import { ethers } from "ethers";
import { POLL_MS, getEventLogIndex, getMarketEntries, loadConfig, prettyHash, sleep } from "./worker-common.mjs";
const EXECUTOR_INDEX_A = Number(process.env.EXECUTOR_INDEX_A || 0);
const EXECUTOR_INDEX_B = Number(process.env.EXECUTOR_INDEX_B || 0);

const ABI = {
  vault: [
    "event Locked(address indexed user, uint256 amount)",
  ],
  gateway: [
    "function computeMessageId(bytes32 srcTxHash, uint256 srcLogIndex, address user, uint256 amount) view returns (bytes32)",
    "function attestCount(bytes32 messageId) view returns (uint256)",
    "function executed(bytes32 messageId) view returns (bool)",
    "function threshold() view returns (uint256)",
    "function execute(bytes32 srcTxHash, uint256 srcLogIndex, address user, uint256 amount) returns (bytes32 messageId)",
    "event BurnRequested(address indexed user, uint256 amount)",
  ],
};

async function executeMintReadyMessagesForMarket(cfg, market, signer) {
  const sourceChain = cfg.chains[market.sourceChain];
  const destinationChain = cfg.chains[market.destinationChain];

  const providerSource = new ethers.JsonRpcProvider(sourceChain.rpc);
  const vault = new ethers.Contract(sourceChain.collateralVault, ABI.vault, providerSource);
  const mintGateway = new ethers.Contract(destinationChain.mintGateway, ABI.gateway, signer);
  const threshold = await mintGateway.threshold();

  const lockEvents = await vault.queryFilter(vault.filters.Locked(), 0, "latest");
  let processed = 0;

  for (const ev of lockEvents) {
    const user = ev.args.user;
    const amount = ev.args.amount;
    const logIndex = getEventLogIndex(ev);
    const srcTxHash = ev.transactionHash;

    const messageId = await mintGateway.computeMessageId(srcTxHash, logIndex, user, amount);
    if (await mintGateway.executed(messageId)) {
      continue;
    }

    if ((await mintGateway.attestCount(messageId)) < threshold) {
      continue;
    }

    try {
      const tx = await mintGateway.execute(srcTxHash, logIndex, user, amount);
      await tx.wait();
      processed += 1;
      console.log(`[executor] ${market.id} execute mint -> ${prettyHash(messageId)} tx=${prettyHash(tx.hash)}`);
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("ALREADY_EXECUTED") && !msg.includes("INSUFFICIENT_ATTESTATIONS")) {
        console.log(`[executor] ${market.id} mint execute skipped: ${msg}`);
      }
    }
  }

  return processed;
}

async function executeUnlockReadyMessagesForMarket(cfg, market, signer) {
  const sourceChain = cfg.chains[market.sourceChain];
  const destinationChain = cfg.chains[market.destinationChain];

  const providerDestination = new ethers.JsonRpcProvider(destinationChain.rpc);
  const destinationMintGateway = new ethers.Contract(destinationChain.mintGateway, ABI.gateway, providerDestination);
  const unlockGateway = new ethers.Contract(sourceChain.unlockGateway, ABI.gateway, signer);
  const threshold = await unlockGateway.threshold();

  const burnEvents = await destinationMintGateway.queryFilter(destinationMintGateway.filters.BurnRequested(), 0, "latest");
  let processed = 0;

  for (const ev of burnEvents) {
    const user = ev.args.user;
    const amount = ev.args.amount;
    const logIndex = getEventLogIndex(ev);
    const srcTxHash = ev.transactionHash;

    const messageId = await unlockGateway.computeMessageId(srcTxHash, logIndex, user, amount);
    if (await unlockGateway.executed(messageId)) {
      continue;
    }

    if ((await unlockGateway.attestCount(messageId)) < threshold) {
      continue;
    }

    try {
      const tx = await unlockGateway.execute(srcTxHash, logIndex, user, amount);
      await tx.wait();
      processed += 1;
      console.log(`[executor] ${market.id} execute unlock -> ${prettyHash(messageId)} tx=${prettyHash(tx.hash)}`);
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("ALREADY_EXECUTED") && !msg.includes("INSUFFICIENT_ATTESTATIONS")) {
        console.log(`[executor] ${market.id} unlock execute skipped: ${msg}`);
      }
    }
  }

  return processed;
}

async function main() {
  const cfg = await loadConfig();
  const providerA = new ethers.JsonRpcProvider(cfg.chains.A.rpc);
  const providerB = new ethers.JsonRpcProvider(cfg.chains.B.rpc);

  const executorA = await providerA.getSigner(EXECUTOR_INDEX_A);
  const executorB = await providerB.getSigner(EXECUTOR_INDEX_B);

  console.log("executor-worker started");
  console.log(`- chainA executor: ${await executorA.getAddress()} | rpc=${cfg.chains.A.rpc}`);
  console.log(`- chainB executor: ${await executorB.getAddress()} | rpc=${cfg.chains.B.rpc}`);

  while (true) {
    try {
      const marketEntries = getMarketEntries(cfg);
      let mintCount = 0;
      let unlockCount = 0;

      for (const market of marketEntries) {
        const destinationExecutor = market.destinationChain === "A" ? executorA : executorB;
        const sourceExecutor = market.sourceChain === "A" ? executorA : executorB;

        mintCount += await executeMintReadyMessagesForMarket(cfg, market, destinationExecutor);
        unlockCount += await executeUnlockReadyMessagesForMarket(cfg, market, sourceExecutor);
      }

      if (mintCount > 0 || unlockCount > 0) {
        console.log(`cycle complete | mintExecuted=${mintCount}, unlockExecuted=${unlockCount}`);
      }
    } catch (err) {
      console.log(`worker cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("executor-worker failed:");
  console.error(err);
  process.exit(1);
});
