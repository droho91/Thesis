import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-update.mjs";

const HANDSHAKE_TX_GAS_LIMIT = BigInt(process.env.HANDSHAKE_TX_GAS_LIMIT || process.env.INTERCHAIN_TX_GAS_LIMIT || "8000000");
const HANDSHAKE_TX_WAIT_TIMEOUT_MS = Number(
  process.env.HANDSHAKE_TX_WAIT_TIMEOUT_MS || process.env.TX_WAIT_TIMEOUT_MS || 120000
);
const HEADER_WAIT_TIMEOUT_MS = Number(process.env.HEADER_WAIT_TIMEOUT_MS || "120000");
const HEADER_WAIT_INTERVAL_MS = Number(process.env.HEADER_WAIT_INTERVAL_MS || "2000");
const HEADER_UPDATE_BATCH_SIZE = Math.max(1, Number(process.env.HEADER_UPDATE_BATCH_SIZE || "5"));

function debugHandshake() {
  return process.env.DEBUG_HANDSHAKE === "true" || process.env.DEBUG_DEMO_FLOW === "true";
}

function txOptions() {
  return { gasLimit: HANDSHAKE_TX_GAS_LIMIT };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForTx(tx, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`[ibc handshake] ${label} timed out waiting for ${tx.hash}`));
    }, HANDSHAKE_TX_WAIT_TIMEOUT_MS);
  });
  const receipt = await Promise.race([tx.wait(), timeout]);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[ibc handshake] ${label} failed in transaction ${tx.hash}`);
  }
  return receipt;
}

async function txStep(label, send) {
  if (debugHandshake()) console.log(`[ibc handshake] ${label}`);
  const tx = await send();
  if (debugHandshake()) console.log(`[ibc handshake] ${label} tx=${tx.hash}`);
  return waitForTx(tx, label);
}

async function updateLightClientHeaders({ lightClient, updates, label }) {
  if (updates.length === 0) return null;

  let latest = null;
  for (let i = 0; i < updates.length; i += HEADER_UPDATE_BATCH_SIZE) {
    const chunk = updates.slice(i, i + HEADER_UPDATE_BATCH_SIZE);
    latest = chunk[chunk.length - 1];

    if (chunk.length === 1 || typeof lightClient.updateClientBatch !== "function") {
      await txStep(`${label} to height ${latest.headerUpdate.height.toString()}`, () =>
        lightClient.updateClient(latest.headerUpdate, latest.validatorSet, txOptions())
      );
      continue;
    }

    const firstHeight = chunk[0].headerUpdate.height;
    const lastHeight = latest.headerUpdate.height;
    await txStep(`${label} heights ${firstHeight.toString()}-${lastHeight.toString()}`, () =>
      lightClient.updateClientBatch(
        chunk.map((item) => item.headerUpdate),
        chunk.map((item) => item.validatorSet),
        txOptions()
      )
    );
  }

  return latest;
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

function isVerifiableHeader(result) {
  return result.headerUpdate.headerHash.toLowerCase() === result.derived.blockHeaderHash.toLowerCase();
}

async function buildVerifiableBesuHeaderUpdate({
  provider,
  minimumHeight,
  sourceChainId,
  validatorEpoch,
}) {
  const minHeight = BigInt(minimumHeight);
  const start = Date.now();
  let lastMismatch = null;

  while (Date.now() - start < HEADER_WAIT_TIMEOUT_MS) {
    const latestHeight = BigInt(await provider.getBlockNumber());
    if (latestHeight < minHeight) {
      await sleep(HEADER_WAIT_INTERVAL_MS);
      continue;
    }

    const candidate = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(latestHeight),
      sourceChainId,
      validatorEpoch,
    });
    if (isVerifiableHeader(candidate)) {
      return candidate;
    }

    lastMismatch =
      `height ${candidate.headerUpdate.height.toString()} rpcHash=${candidate.headerUpdate.headerHash} ` +
      `blockHeaderHash=${candidate.derived.blockHeaderHash}`;
    if (debugHandshake()) {
      console.log(`[ibc handshake] waiting for verifiable Besu header after ${lastMismatch}`);
    }
    await sleep(HEADER_WAIT_INTERVAL_MS);
  }

  throw new Error(
    `[ibc handshake] timed out waiting for a verifiable Besu header at or after ${minHeight.toString()}` +
      (lastMismatch ? `; last mismatch: ${lastMismatch}` : "")
  );
}

async function buildVerifiableBesuHeaderAt({
  provider,
  height,
  sourceChainId,
  validatorEpoch,
}) {
  const targetHeight = BigInt(height);
  const start = Date.now();
  let lastMismatch = null;

  while (Date.now() - start < HEADER_WAIT_TIMEOUT_MS) {
    const latestHeight = BigInt(await provider.getBlockNumber());
    if (latestHeight < targetHeight) {
      await sleep(HEADER_WAIT_INTERVAL_MS);
      continue;
    }

    const candidate = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(targetHeight),
      sourceChainId,
      validatorEpoch,
    });
    if (isVerifiableHeader(candidate)) {
      return candidate;
    }

    lastMismatch =
      `height ${candidate.headerUpdate.height.toString()} rpcHash=${candidate.headerUpdate.headerHash} ` +
      `blockHeaderHash=${candidate.derived.blockHeaderHash}`;
    if (debugHandshake()) {
      console.log(`[ibc handshake] waiting for verifiable Besu header at ${lastMismatch}`);
    }
    await sleep(HEADER_WAIT_INTERVAL_MS);
  }

  throw new Error(
    `[ibc handshake] timed out waiting for a verifiable Besu header at ${targetHeight.toString()}` +
      (lastMismatch ? `; last mismatch: ${lastMismatch}` : "")
  );
}

function chainClientId(chainId) {
  return ethers.zeroPadValue(ethers.toBeHex(chainId), 32);
}

function rlpWord(word) {
  const bytes = ethers.getBytes(word);
  let firstNonZero = 0;
  while (firstNonZero < bytes.length && bytes[firstNonZero] === 0) firstNonZero++;
  const trimmed = bytes.slice(firstNonZero);
  if (trimmed.length === 0) return "0x80";
  if (trimmed.length === 1 && trimmed[0] < 0x80) return ethers.hexlify(trimmed);
  return ethers.hexlify(ethers.concat([new Uint8Array([0x80 + trimmed.length]), trimmed]));
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
    throw new Error("Cannot trust block zero through the Besu update path.");
  }

  let currentHeight = BigInt(await lightClient.latestTrustedHeight(sourceChainId));
  if (currentHeight >= height) {
    const current = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(currentHeight),
      sourceChainId,
      validatorEpoch,
    });
    if (isVerifiableHeader(current)) {
      return current;
    }

    const target = await buildVerifiableBesuHeaderAt({
      provider,
      height: currentHeight + 1n,
      sourceChainId,
      validatorEpoch,
    });
    await updateLightClientHeaders({
      lightClient,
      updates: [target],
      label: "update Besu light client",
    });
    return target;
  }

  if (currentHeight === 0n) {
    const target = await buildVerifiableBesuHeaderUpdate({
      provider,
      minimumHeight: height,
      sourceChainId,
      validatorEpoch,
    });
    const anchorHeight = target.headerUpdate.height - 1n;
    if (anchorHeight === 0n) {
      throw new Error("Cannot initialize a Besu trust anchor from block zero.");
    }
    const anchor = await buildBesuHeaderUpdate({
      provider,
      blockTag: ethers.toQuantity(anchorHeight),
      sourceChainId,
      validatorEpoch,
    });
    await txStep("initialize trust anchor", () =>
      lightClient.initializeTrustAnchor(sourceChainId, trustedAnchorFrom(anchor), anchor.validatorSet, txOptions())
    );
    await updateLightClientHeaders({
      lightClient,
      updates: [target],
      label: "update Besu light client",
    });
    return target;
  }

  let trusted = null;
  let pendingUpdates = [];
  while (currentHeight < height) {
    const nextHeight = currentHeight + 1n;
    const next = await buildVerifiableBesuHeaderAt({
      provider,
      height: nextHeight,
      sourceChainId,
      validatorEpoch,
    });
    pendingUpdates.push(next);
    if (pendingUpdates.length >= HEADER_UPDATE_BATCH_SIZE) {
      trusted = await updateLightClientHeaders({
        lightClient,
        updates: pendingUpdates,
        label: "update Besu light client",
      });
      pendingUpdates = [];
    }
    currentHeight = nextHeight;
  }
  if (pendingUpdates.length > 0) {
    trusted = await updateLightClientHeaders({
      lightClient,
      updates: pendingUpdates,
      label: "update Besu light client",
    });
  }

  return trusted;
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
    trustedHeight: sourceInitHeader.headerUpdate.height,
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
    trustedHeight: destinationTryHeader.headerUpdate.height,
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
    trustedHeight: sourceAckHeader.headerUpdate.height,
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
    sourceInitProofHeight: sourceInitHeader.headerUpdate.height.toString(),
    destinationTryHeight: destinationTryHeight.toString(),
    destinationTryProofHeight: destinationTryHeader.headerUpdate.height.toString(),
    sourceAckHeight: sourceAckHeight.toString(),
    sourceAckProofHeight: sourceAckHeader.headerUpdate.height.toString(),
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
    trustedHeight: sourceInitHeader.headerUpdate.height,
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
    trustedHeight: destinationTryHeader.headerUpdate.height,
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
    trustedHeight: sourceAckHeader.headerUpdate.height,
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
    sourceInitProofHeight: sourceInitHeader.headerUpdate.height.toString(),
    destinationTryHeight: destinationTryHeight.toString(),
    destinationTryProofHeight: destinationTryHeader.headerUpdate.height.toString(),
    sourceAckHeight: sourceAckHeight.toString(),
    sourceAckProofHeight: sourceAckHeader.headerUpdate.height.toString(),
    destinationConfirmHeight: BigInt(destinationConfirmReceipt.blockNumber).toString(),
  };
}
