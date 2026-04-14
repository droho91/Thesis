import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export const POLL_MS = Number(process.env.WORKER_POLL_MS || 2500);
export const DEV_HEADER_DOMAIN = ethers.id("DEV_LIGHT_CLIENT_HEADER_UPDATE_V1");
export const DEV_RECEIPT_DOMAIN = ethers.id("DEV_RECEIPT_INCLUSION_PROOF_V1");

export const ABI = {
  messageBus: [
    "event BridgeMessageDispatched(bytes32 indexed messageId, bytes32 indexed routeId, uint8 indexed action, uint256 sourceChainId, uint256 destinationChainId, address sourceSender, address recipient, address asset, uint256 amount, uint256 nonce, bytes32 payloadHash)",
    "function computeEventHash((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceSender,address recipient,address asset,uint256 amount,uint256 nonce,bytes32 payloadHash) message) view returns (bytes32)",
  ],
  lightClient: [
    "function submitFinalizedHeader((uint256 sourceChainId,uint256 blockNumber,bytes32 blockHash,bytes32 parentHash,bytes32 stateRoot,uint256 timestamp) update, bytes proof) returns (bytes32)",
  ],
  executionHeaderStore: [
    "function submitExecutionHeader((uint256 sourceChainId,uint256 blockNumber,bytes32 blockHash,bytes32 parentHash,bytes32 receiptsRoot,uint256 timestamp,bytes32 finalizedCheckpoint) header) returns (bytes32)",
  ],
  inbox: [
    "function consumed(bytes32 messageId) view returns (bool)",
  ],
  router: [
    "function relayMessage((bytes32 routeId,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceSender,address recipient,address asset,uint256 amount,uint256 nonce,bytes32 payloadHash) message, (uint256 sourceChainId,bytes32 blockHash,bytes32 receiptsRoot,address emitter,uint256 logIndex,bytes32 proofRoot) proof) payable returns (bytes32)",
  ],
  riskManager: [
    "function routePaused(bytes32 routeId) view returns (bool)",
    "function routeCursed(bytes32 routeId) view returns (bool)",
    "function setRoutePaused(bytes32 routeId, bool paused)",
    "function setRouteCursed(bytes32 routeId, bool cursed)",
  ],
  routeRegistry: [
    "function getRoute(bytes32 routeId) view returns (bool enabled,uint8 action,uint256 sourceChainId,uint256 destinationChainId,address sourceEmitter,address sourceSender,address sourceAsset,address target,uint256 flatFee,uint16 feeBps,uint256 transferCap,uint256 rateLimitAmount,uint256 rateLimitWindow,uint256 highValueThreshold)",
  ],
};

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function getEventLogIndex(ev) {
  if (ev.logIndex !== undefined && ev.logIndex !== null) return BigInt(ev.logIndex);
  if (ev.index !== undefined && ev.index !== null) return BigInt(ev.index);
  return 0n;
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

export function messageFromEvent(ev) {
  return {
    routeId: ev.args.routeId,
    action: Number(ev.args.action),
    sourceChainId: ev.args.sourceChainId,
    destinationChainId: ev.args.destinationChainId,
    sourceSender: ev.args.sourceSender,
    recipient: ev.args.recipient,
    asset: ev.args.asset,
    amount: ev.args.amount,
    nonce: ev.args.nonce,
    payloadHash: ev.args.payloadHash,
  };
}

export function devHeaderProof(update) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32"],
    [
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "uint256", "bytes32", "bytes32", "bytes32", "uint256"],
          [
            DEV_HEADER_DOMAIN,
            BigInt(update.sourceChainId),
            BigInt(update.blockNumber),
            update.blockHash,
            update.parentHash,
            update.stateRoot,
            BigInt(update.timestamp),
          ]
        )
      ),
    ]
  );
}

export function devReceiptProofRoot({ sourceChainId, blockHash, receiptsRoot, emitter, logIndex, eventHash }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "bytes32", "bytes32", "address", "uint256", "bytes32"],
      [DEV_RECEIPT_DOMAIN, BigInt(sourceChainId), blockHash, receiptsRoot, emitter, BigInt(logIndex), eventHash]
    )
  );
}

export function fallbackRoot(label, ...values) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", ...values.map((value) => (typeof value === "bigint" ? "uint256" : "bytes32"))],
      [label, ...values]
    )
  );
}

export async function blockHeaderForEvent(provider, sourceChainId, ev) {
  const block = await provider.getBlock(ev.blockNumber);
  if (!block?.hash) throw new Error(`Missing source block ${ev.blockNumber}`);

  const blockNumber = BigInt(block.number);
  const blockHash = block.hash;
  const parentHash = block.parentHash || ethers.ZeroHash;
  const stateRoot = block.stateRoot || fallbackRoot("DEV_STATE_ROOT", BigInt(sourceChainId), blockNumber, blockHash);
  const receiptsRoot = block.receiptsRoot || fallbackRoot("DEV_RECEIPTS_ROOT", BigInt(sourceChainId), blockNumber, blockHash);

  return {
    update: {
      sourceChainId: BigInt(sourceChainId),
      blockNumber,
      blockHash,
      parentHash,
      stateRoot,
      timestamp: BigInt(block.timestamp),
    },
    executionHeader: {
      sourceChainId: BigInt(sourceChainId),
      blockNumber,
      blockHash,
      parentHash,
      receiptsRoot,
      timestamp: BigInt(block.timestamp),
      finalizedCheckpoint: blockHash,
    },
  };
}

export function routeLegsForMarket(cfg, market) {
  return [
    {
      kind: "lock",
      sourceChainKey: market.sourceChain,
      destinationChainKey: market.destinationChain,
      routeId: market.lockRouteId,
      sourceMessageBus: market.sourceMessageBus,
      destinationLightClient: market.destinationLightClient,
      destinationExecutionHeaderStore: market.destinationExecutionHeaderStore,
      destinationBridgeRouter: market.destinationBridgeRouter,
      destinationInbox: cfg.chains[market.destinationChain].messageInbox,
    },
    {
      kind: "burn",
      sourceChainKey: market.destinationChain,
      destinationChainKey: market.sourceChain,
      routeId: market.burnRouteId,
      sourceMessageBus: market.destinationMessageBus,
      destinationLightClient: market.sourceLightClient,
      destinationExecutionHeaderStore: market.sourceExecutionHeaderStore,
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
