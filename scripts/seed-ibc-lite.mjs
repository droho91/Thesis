import { ethers } from "ethers";
import { loadArtifact, loadConfig, normalizeRuntime, signerFor } from "./ibc-lite-common.mjs";

const USER_INDEX = Number(process.env.USER_INDEX || 1);
const AMOUNT = ethers.parseUnits(process.env.SEED_AMOUNT || "1000", 18);
const POOL_LIQUIDITY = ethers.parseUnits(process.env.POOL_LIQUIDITY || "10000", 18);

export async function runSeedIBCLite() {
  const activeRuntime = normalizeRuntime();
  if (!activeRuntime.besuFirst) {
    throw new Error("seed-ibc-lite.mjs is a canonical Besu-first entrypoint.");
  }

  const config = await loadConfig();
  const tokenArtifact = await loadArtifact("apps/BankToken.sol", "BankToken");
  const ownerA = await signerFor(config, "A", 0);
  const ownerB = await signerFor(config, "B", 0);
  const user = await signerFor(config, "A", USER_INDEX);
  const canonical = new ethers.Contract(config.chains.A.canonicalToken, tokenArtifact.abi, ownerA);
  const debtToken = new ethers.Contract(config.chains.B.debtToken, tokenArtifact.abi, ownerB);
  await (await canonical.mint(await user.getAddress(), AMOUNT)).wait();
  await (await debtToken.mint(config.chains.B.lendingPool, POOL_LIQUIDITY)).wait();
  console.log(`[seed] minted ${ethers.formatUnits(AMOUNT, 18)} aBANK to ${await user.getAddress()}`);
  console.log(`[seed] funded Bank B lending pool with ${ethers.formatUnits(POOL_LIQUIDITY, 18)} bCASH`);
}

runSeedIBCLite().catch((error) => {
  console.error(error);
  process.exit(1);
});
