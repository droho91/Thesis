import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-v2.mjs";

const HANDSHAKE_TX_GAS_LIMIT = BigInt(process.env.HANDSHAKE_TX_GAS_LIMIT || process.env.V2_TX_GAS_LIMIT || "8000000");
const HANDSHAKE_TX_WAIT_TIMEOUT_MS = Number(
  process.env.HANDSHAKE_TX_WAIT_TIMEOUT_MS || process.env.TX_WAIT_TIMEOUT_MS || 120000
);

function debugHandshake() {
  return process.env.DEBUG_HANDSHAKE === "true" || process.env.DEBUG_DEMO_FLOW === "true";
}

function txOptions() {
  return { gasLimit: HANDSHAKE_TX_GAS_LIMIT };
}

async function waitForTx(tx, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`[v2 handshake] ${label} timed out waiting for ${tx.hash}`));
    }, HANDSHAKE_TX_WAIT_TIMEOUT_MS);
  });
  const receipt = await Promise.race([tx.wait(), timeout]);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[v2 handshake] ${label} failed in transaction ${tx.hash}`);
  }
  return receipt;
}

async function txStep(label, send) {
  if (debugHandshake()) console.log(`[v2 handshake] ${label}`);
  const tx = await send();
  if (debugHandshake()) console.log(`[v2 handshake] ${label} tx=${tx.hash}`);
  return waitForTx(tx, label);
}

function trustedAnchorFrom(result) {
  return {
    sourceChainId: result.headerUpdate.sourceChainId,
    height: result.headerUpdate.height,
    headerHash: result.headerUpdate.headerHash,
    parentHash: result.headerUpdate.parentHash,
    stateRoot: result.headerUpdate.stateRoot,
    timestamp: BigInt(result.block.timestamp),
    validatorsHash: result.derived.validatorsHash,
    exists: true,
  };
}

function chainClientId(chainId) {
  return ethers.zeroPadValue(ethers.toBeHex(chainId), 32);
}

function rlpWord(word) {
  return ethers.hexlify(ethers.concat([new Uint8Array([0xa0]), ethers.getBytes(word)]));
}

async function buildWordStorageProof({
  provider,
  account,
  storageKey,
  expectedWord,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  const proof = await provider.send("eth_getProof", [account, [storageKey], ethers.toQuantity(trustedHeight)]);
  if (!proof?.storageProof?.length) {
    throw new Error("eth_getProof did not return a storage proof.");
  }

  const storageEntry =
    proof.storageProof.find((entry) => entry.key.toLowerCase() === storageKey.toLowerCase()) ?? proof.storageProof[0];
  if (!storageEntry) {
    throw new Error("Could not match eth_getProof entry to the requested storage slot.");
  }
  if (BigInt(storageEntry.value) !== BigInt(expectedWord)) {
    throw new Error(`Storage proof value mismatch: expected ${expectedWord}, got ${storageEntry.value}.`);
  }

  return {
    sourceChainId,
    trustedHeight,
    stateRoot,
    account,
    storageKey,
    expectedValue: rlpWord(expectedWord),
    accountProof: proof.accountProof,
    storageProof: storageEntry.proof,
  };
}

export async function trustRemoteHeaderAt({
  lightClient,
  provider,
  sourceChainId,
  targetHeight,
  validatorEpoch = 1n,
}) {
  const height = BigInt(targetHeight);
  if (height === 0n) {
    throw new Error("Cannot trust block zero through the v2 update path.");
  }

  let currentHeight = BigInt(await lightClient.latestTrustedHeight(sourceChainId));
  if (currentHeight === 0n) {
    const anchorHeight = height - 1n;
    const anchor = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(anchorHeight),
      sourceChainId,
      validatorEpoch,
    });
    await txStep("initialize trust anchor", () =>
      lightClient.initializeTrustAnchor(sourceChainId, trustedAnchorFrom(anchor), anchor.validatorSet, txOptions())
    );
    currentHeight = anchorHeight;
  }

  let latest;
  if (currentHeight < height) {
    latest = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(height),
      sourceChainId,
      validatorEpoch,
    });
    await txStep("update Besu light client", () =>
      lightClient.updateClient(latest.headerUpdate, latest.validatorSet, txOptions())
    );
  }

  return latest ?? buildBesuHeaderUpdate({
    provider,
    blockTag: ethers.toQuantity(height),
    sourceChainId,
    validatorEpoch,
  });
}

async function buildConnectionCommitmentProof({
  provider,
  keeper,
  keeperAddress,
  connectionId,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  return buildWordStorageProof({
    provider,
    account: keeperAddress,
    storageKey: await keeper.connectionCommitmentStorageSlot(connectionId),
    expectedWord: await keeper.connectionCommitments(connectionId),
    sourceChainId,
    trustedHeight,
    stateRoot,
  });
}

async function buildChannelCommitmentProof({
  provider,
  keeper,
  keeperAddress,
  channelId,
  sourceChainId,
  trustedHeight,
  stateRoot,
}) {
  return buildWordStorageProof({
    provider,
    account: keeperAddress,
    storageKey: await keeper.channelCommitmentStorageSlot(channelId),
    expectedWord: await keeper.channelCommitments(channelId),
    sourceChainId,
    trustedHeight,
    stateRoot,
  });
}

export async function openProofCheckedConnection({
  sourceProvider,
  destinationProvider,
  sourceLightClient,
  destinationLightClient,
  sourceConnectionKeeper,
  destinationConnectionKeeper,
  sourceConnectionKeeperAddress,
  destinationConnectionKeeperAddress,
  sourceChainId,
  destinationChainId,
  sourceConnectionId,
  destinationConnectionId,
  prefix,
  validatorEpoch = 1n,
}) {
  const sourceInitReceipt = await txStep("connection open init on source", () =>
    sourceConnectionKeeper.connectionOpenInit(
      sourceConnectionId,
      chainClientId(destinationChainId),
      chainClientId(sourceChainId),
      0,
      prefix,
      txOptions()
    )
  );
  const sourceInitHeight = BigInt(sourceInitReceipt.blockNumber);
  const sourceInitHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId,
    targetHeight: sourceInitHeight,
    validatorEpoch,
  });
  const sourceInitProof = await buildConnectionCommitmentProof({
    provider: sourceProvider,
    keeper: sourceConnectionKeeper,
    keeperAddress: sourceConnectionKeeperAddress,
    connectionId: sourceConnectionId,
    sourceChainId,
    trustedHeight: sourceInitHeight,
    stateRoot: sourceInitHeader.headerUpdate.stateRoot,
  });

  const destinationTryReceipt = await txStep("connection open try on destination", () =>
    destinationConnectionKeeper.connectionOpenTry(
      destinationConnectionId,
      chainClientId(sourceChainId),
      chainClientId(destinationChainId),
      sourceConnectionId,
      0,
      prefix,
      sourceConnectionKeeperAddress,
      sourceInitProof,
      txOptions()
    )
  );
  const destinationTryHeight = BigInt(destinationTryReceipt.blockNumber);
  const destinationTryHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: destinationChainId,
    targetHeight: destinationTryHeight,
    validatorEpoch,
  });
  const destinationTryProof = await buildConnectionCommitmentProof({
    provider: destinationProvider,
    keeper: destinationConnectionKeeper,
    keeperAddress: destinationConnectionKeeperAddress,
    connectionId: destinationConnectionId,
    sourceChainId: destinationChainId,
    trustedHeight: destinationTryHeight,
    stateRoot: destinationTryHeader.headerUpdate.stateRoot,
  });

  const sourceAckReceipt = await txStep("connection open ack on source", () =>
    sourceConnectionKeeper.connectionOpenAck(
      sourceConnectionId,
      destinationConnectionId,
      destinationConnectionKeeperAddress,
      destinationTryProof,
      txOptions()
    )
  );
  const sourceAckHeight = BigInt(sourceAckReceipt.blockNumber);
  const sourceAckHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId,
    targetHeight: sourceAckHeight,
    validatorEpoch,
  });
  const sourceAckProof = await buildConnectionCommitmentProof({
    provider: sourceProvider,
    keeper: sourceConnectionKeeper,
    keeperAddress: sourceConnectionKeeperAddress,
    connectionId: sourceConnectionId,
    sourceChainId,
    trustedHeight: sourceAckHeight,
    stateRoot: sourceAckHeader.headerUpdate.stateRoot,
  });

  const destinationConfirmReceipt = await txStep("connection open confirm on destination", () =>
    destinationConnectionKeeper.connectionOpenConfirm(
      destinationConnectionId,
      sourceConnectionKeeperAddress,
      sourceAckProof,
      txOptions()
    )
  );

  return {
    sourceInitHeight: sourceInitHeight.toString(),
    destinationTryHeight: destinationTryHeight.toString(),
    sourceAckHeight: sourceAckHeight.toString(),
    destinationConfirmHeight: BigInt(destinationConfirmReceipt.blockNumber).toString(),
  };
}

export async function openProofCheckedChannel({
  sourceProvider,
  destinationProvider,
  sourceLightClient,
  destinationLightClient,
  sourceChannelKeeper,
  destinationChannelKeeper,
  sourceChannelKeeperAddress,
  destinationChannelKeeperAddress,
  sourceChainId,
  destinationChainId,
  sourceConnectionId,
  destinationConnectionId,
  sourceChannelId,
  destinationChannelId,
  sourcePort,
  destinationPort,
  ordering,
  version,
  validatorEpoch = 1n,
}) {
  const sourceInitReceipt = await txStep("channel open init on source", () =>
    sourceChannelKeeper.channelOpenInit(
      sourceChannelId,
      sourceConnectionId,
      destinationChainId,
      destinationPort,
      sourcePort,
      ordering,
      version,
      txOptions()
    )
  );
  const sourceInitHeight = BigInt(sourceInitReceipt.blockNumber);
  const sourceInitHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId,
    targetHeight: sourceInitHeight,
    validatorEpoch,
  });
  const sourceInitProof = await buildChannelCommitmentProof({
    provider: sourceProvider,
    keeper: sourceChannelKeeper,
    keeperAddress: sourceChannelKeeperAddress,
    channelId: sourceChannelId,
    sourceChainId,
    trustedHeight: sourceInitHeight,
    stateRoot: sourceInitHeader.headerUpdate.stateRoot,
  });

  const destinationTryReceipt = await txStep("channel open try on destination", () =>
    destinationChannelKeeper.channelOpenTry(
      destinationChannelId,
      destinationConnectionId,
      sourceChainId,
      sourcePort,
      destinationPort,
      sourceChannelId,
      ordering,
      version,
      sourceChannelKeeperAddress,
      sourceInitProof,
      txOptions()
    )
  );
  const destinationTryHeight = BigInt(destinationTryReceipt.blockNumber);
  const destinationTryHeader = await trustRemoteHeaderAt({
    lightClient: sourceLightClient,
    provider: destinationProvider,
    sourceChainId: destinationChainId,
    targetHeight: destinationTryHeight,
    validatorEpoch,
  });
  const destinationTryProof = await buildChannelCommitmentProof({
    provider: destinationProvider,
    keeper: destinationChannelKeeper,
    keeperAddress: destinationChannelKeeperAddress,
    channelId: destinationChannelId,
    sourceChainId: destinationChainId,
    trustedHeight: destinationTryHeight,
    stateRoot: destinationTryHeader.headerUpdate.stateRoot,
  });

  const sourceAckReceipt = await txStep("channel open ack on source", () =>
    sourceChannelKeeper.channelOpenAck(
      sourceChannelId,
      destinationChannelId,
      destinationChannelKeeperAddress,
      destinationTryProof,
      txOptions()
    )
  );
  const sourceAckHeight = BigInt(sourceAckReceipt.blockNumber);
  const sourceAckHeader = await trustRemoteHeaderAt({
    lightClient: destinationLightClient,
    provider: sourceProvider,
    sourceChainId,
    targetHeight: sourceAckHeight,
    validatorEpoch,
  });
  const sourceAckProof = await buildChannelCommitmentProof({
    provider: sourceProvider,
    keeper: sourceChannelKeeper,
    keeperAddress: sourceChannelKeeperAddress,
    channelId: sourceChannelId,
    sourceChainId,
    trustedHeight: sourceAckHeight,
    stateRoot: sourceAckHeader.headerUpdate.stateRoot,
  });

  const destinationConfirmReceipt = await txStep("channel open confirm on destination", () =>
    destinationChannelKeeper.channelOpenConfirm(
      destinationChannelId,
      sourceChannelKeeperAddress,
      sourceAckProof,
      txOptions()
    )
  );

  return {
    sourceInitHeight: sourceInitHeight.toString(),
    destinationTryHeight: destinationTryHeight.toString(),
    sourceAckHeight: sourceAckHeight.toString(),
    destinationConfirmHeight: BigInt(destinationConfirmReceipt.blockNumber).toString(),
  };
}
