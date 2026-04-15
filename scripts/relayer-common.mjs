import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const POLL_MS = Number(process.env.WORKER_POLL_MS || 2500);
export const CHECKPOINT_TYPEHASH = ethers.id("BankChain.FinalizedCheckpoint.v4");
export const MESSAGE_LEAF_TYPEHASH = ethers.id("CrossChainLending.MessageLeaf.v1");
export const LOCAL_VALIDATOR_MNEMONIC =
  process.env.LOCAL_VALIDATOR_MNEMONIC || "test test test test test test test test test test test junk";

export const ABI = {
  messageBus: [
    "event BridgeMessageDispatched(bytes32 indexed messageId, bytes32 indexed routeId, uint8 indexed action, uint256 messageSequence, uint256 sourceChainId, uint256 destinationChainId, address sourceEmitter, address sourceSender, address owner, address recipient, address asset, uint256 amount, uint256 nonce, uint256 prepaidFee, bytes32 payloadHash, bytes32 leaf, bytes32 accumulator)",
    "function messageSequence() view returns (uint256)",
    "function messageLeafAt(uint256 sequence) view returns (bytes32)",
    "function computeLeafHash((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address owner,address recipient,address asset,uint256 amount,uint256 nonce,uint256 prepaidFee,bytes32 payloadHash) message) view returns (bytes32)",
  ],
  checkpointRegistry: [
    "event SourceCheckpointCommitted(uint256 indexed sequence,uint256 indexed validatorEpochId,bytes32 indexed checkpointHash,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,bytes32 validatorEpochHash,bytes32 sourceCommitmentHash)",
    "function commitCheckpoint(uint256 uptoMessageSequence) returns ((uint256 sourceChainId,address sourceCheckpointRegistry,address sourceMessageBus,address sourceValidatorSetRegistry,uint256 validatorEpochId,bytes32 validatorEpochHash,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,uint256 timestamp,bytes32 sourceCommitmentHash,bytes32 checkpointHash))",
    "function checkpointsBySequence(uint256 sequence) view returns (uint256 sourceChainId,address sourceCheckpointRegistry,address sourceMessageBus,address sourceValidatorSetRegistry,uint256 validatorEpochId,bytes32 validatorEpochHash,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,uint256 timestamp,bytes32 sourceCommitmentHash,bytes32 checkpointHash)",
    "function checkpointSequence() view returns (uint256)",
    "function lastCommittedMessageSequence() view returns (uint256)",
  ],
  validatorRegistry: [
    "function activeValidatorEpochId() view returns (uint256)",
    "function validatorEpoch(uint256 epochId) view returns (uint256 sourceChainId,address sourceValidatorSetRegistry,uint256 epochId,bytes32 parentEpochHash,address[] validators,uint256[] votingPowers,uint256 totalVotingPower,uint256 quorumNumerator,uint256 quorumDenominator,uint256 activationBlockNumber,bytes32 activationBlockHash,uint256 timestamp,bytes32 epochHash,bool active)",
  ],
  checkpointClient: [
    "function activeValidatorEpochId(uint256 sourceChainId) view returns (uint256)",
    "function latestCheckpointSequence(uint256 sourceChainId) view returns (uint256)",
    "function latestCheckpointHash(uint256 sourceChainId) view returns (bytes32)",
    "function checkpointHashBySequence(uint256 sourceChainId, uint256 sequence) view returns (bytes32)",
    "function sourceFrozen(uint256 sourceChainId) view returns (bool)",
    "function verifiedCheckpoint(uint256 sourceChainId, bytes32 checkpointHash) view returns (uint256 sourceChainId,address sourceCheckpointRegistry,address sourceMessageBus,address sourceValidatorSetRegistry,uint256 validatorEpochId,bytes32 validatorEpochHash,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,uint256 timestamp,bytes32 sourceCommitmentHash,bytes32 checkpointHash,bool exists)",
    "function hashCheckpoint((uint256 sourceChainId,address sourceCheckpointRegistry,address sourceMessageBus,address sourceValidatorSetRegistry,uint256 validatorEpochId,bytes32 validatorEpochHash,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,uint256 timestamp,bytes32 sourceCommitmentHash) checkpoint) view returns (bytes32)",
    "function submitCheckpoint((uint256 sourceChainId,address sourceCheckpointRegistry,address sourceMessageBus,address sourceValidatorSetRegistry,uint256 validatorEpochId,bytes32 validatorEpochHash,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 firstMessageSequence,uint256 lastMessageSequence,uint256 messageCount,bytes32 messageAccumulator,uint256 sourceBlockNumber,bytes32 sourceBlockHash,uint256 timestamp,bytes32 sourceCommitmentHash) checkpoint, bytes[] signatures) returns (bytes32)",
    "function submitValidatorEpoch((uint256 sourceChainId,address sourceValidatorSetRegistry,uint256 epochId,bytes32 parentEpochHash,address[] validators,uint256[] votingPowers,uint256 totalVotingPower,uint256 quorumNumerator,uint256 quorumDenominator,uint256 activationBlockNumber,bytes32 activationBlockHash,uint256 timestamp,bytes32 epochHash,bool active) epoch, bytes[] signatures) returns (bytes32)",
  ],
  inbox: [
    "function consumed(bytes32 messageId) view returns (bool)",
  ],
  router: [
    "function relayMessage((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address owner,address recipient,address asset,uint256 amount,uint256 nonce,uint256 prepaidFee,bytes32 payloadHash) message, (bytes32 checkpointHash,uint256 leafIndex,bytes32[] siblings) proof) returns (bytes32)",
  ],
  riskManager: [
    "function routePaused(bytes32 routeId) view returns (bool)",
    "function routeFrozen(bytes32 routeId) view returns (bool)",
    "function setRoutePaused(bytes32 routeId, bool paused)",
    "function setRouteFrozen(bytes32 routeId, bool frozen)",
  ],
  routeRegistry: [
    "function getRoute(bytes32 routeId) view returns (bool enabled,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address sourceAsset,address target,uint256 flatFee,uint16 feeBps,uint256 transferCap,uint256 rateLimitAmount,uint256 rateLimitWindow,uint256 highValueThreshold)",
  ],
};

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function prettyHash(value) {
  if (!value) return "-";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

export async function loadConfig() {
  const cfgPath = resolve(process.cwd(), "demo", "multichain-addresses.json");
  return JSON.parse(await readFile(cfgPath, "utf8"));
}

export function getMarketEntries(cfg) {
  return Object.values(cfg.markets || {});
}

export function providerFor(cfg, chainKey) {
  return new ethers.JsonRpcProvider(cfg.chains[chainKey].rpc);
}

export async function signerFor(cfg, chainKey, index) {
  return providerFor(cfg, chainKey).getSigner(index);
}

export function routeLegsForMarket(cfg, market) {
  return [
    {
      kind: "lock",
      sourceChainKey: market.sourceChain,
      destinationChainKey: market.destinationChain,
      routeId: market.lockRouteId,
      sourceMessageBus: market.sourceMessageBus,
      sourceCheckpointRegistry: market.sourceCheckpointRegistry,
      sourceValidatorSetRegistry: cfg.chains[market.sourceChain].validatorSetRegistry,
      destinationCheckpointClient: market.destinationCheckpointClient,
      destinationBridgeRouter: market.destinationBridgeRouter,
      destinationInbox: cfg.chains[market.destinationChain].messageInbox,
    },
    {
      kind: "burn",
      sourceChainKey: market.destinationChain,
      destinationChainKey: market.sourceChain,
      routeId: market.burnRouteId,
      sourceMessageBus: market.destinationMessageBus,
      sourceCheckpointRegistry: market.destinationCheckpointRegistry,
      sourceValidatorSetRegistry: cfg.chains[market.destinationChain].validatorSetRegistry,
      destinationCheckpointClient: market.sourceCheckpointClient,
      destinationBridgeRouter: market.sourceBridgeRouter,
      destinationInbox: cfg.chains[market.sourceChain].messageInbox,
    },
  ];
}

export async function queryMessages(provider, messageBusAddress, routeId) {
  const bus = new ethers.Contract(messageBusAddress, ABI.messageBus, provider);
  const events = await bus.queryFilter(bus.filters.BridgeMessageDispatched(null, routeId), 0, "latest");
  return { bus, events };
}

export async function queryAllMessages(provider, messageBusAddress) {
  const bus = new ethers.Contract(messageBusAddress, ABI.messageBus, provider);
  const events = await bus.queryFilter(bus.filters.BridgeMessageDispatched(), 0, "latest");
  events.sort((a, b) => Number(a.args.messageSequence - b.args.messageSequence));
  return { bus, events };
}

export function messageFromEvent(ev) {
  return {
    routeId: ev.args.routeId,
    action: Number(ev.args.action),
    sourceChainId: ev.args.sourceChainId,
    destinationChainId: ev.args.destinationChainId,
    sourceEmitter: ev.args.sourceEmitter,
    sourceSender: ev.args.sourceSender,
    owner: ev.args.owner,
    recipient: ev.args.recipient,
    asset: ev.args.asset,
    amount: ev.args.amount,
    nonce: ev.args.nonce,
    prepaidFee: ev.args.prepaidFee,
    payloadHash: ev.args.payloadHash,
  };
}

export function checkpointHash(checkpoint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "address",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
      ],
      [
        CHECKPOINT_TYPEHASH,
        BigInt(checkpoint.sourceChainId),
        checkpoint.sourceCheckpointRegistry,
        checkpoint.sourceMessageBus,
        checkpoint.sourceValidatorSetRegistry,
        BigInt(checkpoint.validatorEpochId),
        checkpoint.validatorEpochHash,
        BigInt(checkpoint.sequence),
        checkpoint.parentCheckpointHash,
        checkpoint.messageRoot,
        BigInt(checkpoint.firstMessageSequence),
        BigInt(checkpoint.lastMessageSequence),
        BigInt(checkpoint.messageCount),
        checkpoint.messageAccumulator,
        BigInt(checkpoint.sourceBlockNumber),
        checkpoint.sourceBlockHash,
        BigInt(checkpoint.timestamp),
        checkpoint.sourceCommitmentHash,
      ]
    )
  );
}

export function messageLeaf(messageId) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [MESSAGE_LEAF_TYPEHASH, messageId]));
}

export function checkpointValidatorWallets(cfg, chainKey, provider) {
  const indices = cfg.validatorSimulation?.validatorIndices || [3, 4, 5];
  return indices.map((index) => {
    const wallet = ethers.HDNodeWallet.fromPhrase(
      LOCAL_VALIDATOR_MNEMONIC,
      undefined,
      `m/44'/60'/0'/0/${index}`
    );
    return wallet.connect(provider);
  });
}

export async function signCheckpoint(cfg, sourceChainKey, digest) {
  const provider = providerFor(cfg, sourceChainKey);
  const wallets = checkpointValidatorWallets(cfg, sourceChainKey, provider);
  const quorumCount = Math.ceil((wallets.length * 2) / 3);
  return Promise.all(wallets.slice(0, quorumCount).map((wallet) => wallet.signMessage(ethers.getBytes(digest))));
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) throw new Error("Cannot build a Merkle root for zero leaves");
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(ethers.keccak256(ethers.concat([left, right])));
    }
    level = next;
  }
  return level[0];
}

export function buildMerkleProof(leaves, leafIndex) {
  if (leafIndex < 0 || leafIndex >= leaves.length) throw new Error(`Leaf index ${leafIndex} out of range`);
  let index = leafIndex;
  let level = [...leaves];
  const siblings = [];
  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    siblings.push(siblingIndex < level.length ? level[siblingIndex] : level[index]);

    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(ethers.keccak256(ethers.concat([left, right])));
    }
    index = Math.floor(index / 2);
    level = next;
  }
  return siblings;
}

export function buildProof(checkpointHashValue, leafIndex, siblings) {
  return {
    checkpointHash: checkpointHashValue,
    leafIndex: BigInt(leafIndex),
    siblings,
  };
}
