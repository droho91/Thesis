import { ethers } from "ethers";
import { POLL_MS, getEventLogIndex, getMarketEntries, loadConfig, prettyHash, sleep } from "./worker-common.mjs";

function getArgValue(flag) {
  const idx = process.argv.findIndex((v) => v === flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const VALIDATOR_INDEX = Number(getArgValue("--validator-index") || process.env.VALIDATOR_INDEX || 1);

const ABI = {
  vault: [
    "event Locked(address indexed user, uint256 amount)",
  ],
  gateway: [
    "function computeMessageId(bytes32 srcTxHash, uint256 srcLogIndex, address user, uint256 amount) view returns (bytes32)",
    "function executed(bytes32 messageId) view returns (bool)",
    "function hasAttested(bytes32 messageId, address validator) view returns (bool)",
    "function attest(bytes32 srcTxHash, uint256 srcLogIndex, address user, uint256 amount) returns (bytes32 messageId)",
    "event BurnRequested(address indexed user, uint256 amount)",
  ],
};

async function processLockAttestationsForMarket(cfg, market, signer, validatorAddress) {
  const sourceChain = cfg.chains[market.sourceChain];
  const destinationChain = cfg.chains[market.destinationChain];

  const providerSource = new ethers.JsonRpcProvider(sourceChain.rpc);
  const vault = new ethers.Contract(sourceChain.collateralVault, ABI.vault, providerSource);
  const gatewayRead = new ethers.Contract(destinationChain.mintGateway, ABI.gateway, signer.provider);
  const gatewayWrite = gatewayRead.connect(signer);

  const lockEvents = await vault.queryFilter(vault.filters.Locked(), 0, "latest");
  let processed = 0;

  for (const ev of lockEvents) {
    const user = ev.args.user;
    const amount = ev.args.amount;
    const logIndex = getEventLogIndex(ev);
    const srcTxHash = ev.transactionHash;

    const messageId = await gatewayRead.computeMessageId(srcTxHash, logIndex, user, amount);
    if (await gatewayRead.executed(messageId)) {
      continue;
    }

    if (await gatewayRead.hasAttested(messageId, validatorAddress)) {
      continue;
    }

    try {
      const tx = await gatewayWrite.attest(srcTxHash, logIndex, user, amount);
      await tx.wait();
      processed += 1;
      console.log(
        `[validator ${validatorAddress.slice(0, 8)}] ${market.id} lock attest -> ${prettyHash(messageId)} tx=${prettyHash(tx.hash)}`
      );
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("ALREADY_ATTESTED") && !msg.includes("ALREADY_EXECUTED")) {
        console.log(`[validator ${validatorAddress.slice(0, 8)}] ${market.id} lock attest skipped: ${msg}`);
      }
    }
  }

  return processed;
}

async function processBurnAttestationsForMarket(cfg, market, signer, validatorAddress) {
  const sourceChain = cfg.chains[market.sourceChain];
  const destinationChain = cfg.chains[market.destinationChain];

  const providerDestination = new ethers.JsonRpcProvider(destinationChain.rpc);
  const destinationMintGatewayRead = new ethers.Contract(destinationChain.mintGateway, ABI.gateway, providerDestination);
  const sourceUnlockGatewayRead = new ethers.Contract(sourceChain.unlockGateway, ABI.gateway, signer.provider);
  const sourceUnlockGatewayWrite = sourceUnlockGatewayRead.connect(signer);

  const burnEvents = await destinationMintGatewayRead.queryFilter(destinationMintGatewayRead.filters.BurnRequested(), 0, "latest");
  let processed = 0;

  for (const ev of burnEvents) {
    const user = ev.args.user;
    const amount = ev.args.amount;
    const logIndex = getEventLogIndex(ev);
    const srcTxHash = ev.transactionHash;

    const messageId = await sourceUnlockGatewayRead.computeMessageId(srcTxHash, logIndex, user, amount);
    if (await sourceUnlockGatewayRead.executed(messageId)) {
      continue;
    }

    if (await sourceUnlockGatewayRead.hasAttested(messageId, validatorAddress)) {
      continue;
    }

    try {
      const tx = await sourceUnlockGatewayWrite.attest(srcTxHash, logIndex, user, amount);
      await tx.wait();
      processed += 1;
      console.log(
        `[validator ${validatorAddress.slice(0, 8)}] ${market.id} burn attest -> ${prettyHash(messageId)} tx=${prettyHash(tx.hash)}`
      );
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (!msg.includes("ALREADY_ATTESTED") && !msg.includes("ALREADY_EXECUTED")) {
        console.log(`[validator ${validatorAddress.slice(0, 8)}] ${market.id} burn attest skipped: ${msg}`);
      }
    }
  }

  return processed;
}

async function main() {
  const cfg = await loadConfig();
  const providerA = new ethers.JsonRpcProvider(cfg.chains.A.rpc);
  const providerB = new ethers.JsonRpcProvider(cfg.chains.B.rpc);

  const signerA = await providerA.getSigner(VALIDATOR_INDEX);
  const signerB = await providerB.getSigner(VALIDATOR_INDEX);

  const addrA = (await signerA.getAddress()).toLowerCase();
  const addrB = (await signerB.getAddress()).toLowerCase();
  if (addrA !== addrB) {
    throw new Error("Validator address mismatch across chain A/B for the same signer index.");
  }

  const validatorAddress = await signerA.getAddress();
  if (!cfg.roles.validators.some((v) => v.toLowerCase() === addrA)) {
    throw new Error(`Signer index ${VALIDATOR_INDEX} (${validatorAddress}) is not listed in validators.`);
  }

  console.log(`validator-worker started | validatorIndex=${VALIDATOR_INDEX} | address=${validatorAddress}`);
  console.log(`- chainA=${cfg.chains.A.rpc} mint=${cfg.chains.A.mintGateway} unlock=${cfg.chains.A.unlockGateway}`);
  console.log(`- chainB=${cfg.chains.B.rpc} mint=${cfg.chains.B.mintGateway} unlock=${cfg.chains.B.unlockGateway}`);

  while (true) {
    try {
      const marketEntries = getMarketEntries(cfg);
      let lockCount = 0;
      let burnCount = 0;

      for (const market of marketEntries) {
        const destinationSigner = market.destinationChain === "A" ? signerA : signerB;
        const sourceSigner = market.sourceChain === "A" ? signerA : signerB;

        lockCount += await processLockAttestationsForMarket(cfg, market, destinationSigner, validatorAddress);
        burnCount += await processBurnAttestationsForMarket(cfg, market, sourceSigner, validatorAddress);
      }

      if (lockCount > 0 || burnCount > 0) {
        console.log(`cycle complete | lockAttested=${lockCount}, burnAttested=${burnCount}`);
      }
    } catch (err) {
      console.log(`worker cycle error: ${err?.shortMessage || err?.message || err}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("validator-worker failed:");
  console.error(err);
  process.exit(1);
});
