import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const POLL_MS = Number(process.env.WORKER_POLL_MS || 2500);
export const CHECKPOINT_TYPEHASH = ethers.id("BankChain.FinalizedCheckpoint.v1");
export const MESSAGE_LEAF_TYPEHASH = ethers.id("CrossChainLending.MessageLeaf.v1");
export const LOCAL_VALIDATOR_MNEMONIC =
  process.env.LOCAL_VALIDATOR_MNEMONIC || "test test test test test test test test test test test junk";

export const ABI = {
  messageBus: [
    "event BridgeMessageDispatched(bytes32 indexed messageId, bytes32 indexed routeId, uint8 indexed action, uint256 messageSequence, uint256 sourceChainId, uint256 destinationChainId, address sourceEmitter, address sourceSender, address recipient, address asset, uint256 amount, uint256 nonce, bytes32 payloadHash, bytes32 leaf)",
    "function computeLeafHash((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address recipient,address asset,uint256 amount,uint256 nonce,bytes32 payloadHash) message) view returns (bytes32)",
  ],
  checkpointClient: [
    "function latestCheckpointSequence(uint256 sourceChainId) view returns (uint256)",
    "function latestCheckpointHash(uint256 sourceChainId) view returns (bytes32)",
    "function checkpointHashBySequence(uint256 sourceChainId, uint256 sequence) view returns (bytes32)",
    "function sourceFrozen(uint256 sourceChainId) view returns (bool)",
    "function hashCheckpoint((uint256 sourceChainId,uint256 validatorSetId,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 timestamp) checkpoint) view returns (bytes32)",
    "function submitCheckpoint((uint256 sourceChainId,uint256 validatorSetId,uint256 sequence,bytes32 parentCheckpointHash,bytes32 messageRoot,uint256 timestamp) checkpoint, bytes[] signatures) returns (bytes32)",
  ],
  inbox: [
    "function consumed(bytes32 messageId) view returns (bool)",
  ],
  router: [
    "function relayMessage((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address recipient,address asset,uint256 amount,uint256 nonce,bytes32 payloadHash) message, (bytes32 checkpointHash,uint256 leafIndex,bytes32[] siblings) proof) payable returns (bytes32)",
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

export function messageFromEvent(ev) {
  return {
    routeId: ev.args.routeId,
    action: Number(ev.args.action),
    sourceChainId: ev.args.sourceChainId,
    destinationChainId: ev.args.destinationChainId,
    sourceEmitter: ev.args.sourceEmitter,
    sourceSender: ev.args.sourceSender,
    recipient: ev.args.recipient,
    asset: ev.args.asset,
    amount: ev.args.amount,
    nonce: ev.args.nonce,
    payloadHash: ev.args.payloadHash,
  };
}

export function checkpointHash(checkpoint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256"],
      [
        CHECKPOINT_TYPEHASH,
        BigInt(checkpoint.sourceChainId),
        BigInt(checkpoint.validatorSetId),
        BigInt(checkpoint.sequence),
        checkpoint.parentCheckpointHash,
        checkpoint.messageRoot,
        BigInt(checkpoint.timestamp),
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

export function buildSingleLeafProof(checkpointHashValue) {
  return {
    checkpointHash: checkpointHashValue,
    leafIndex: 0n,
    siblings: [],
  };
}
