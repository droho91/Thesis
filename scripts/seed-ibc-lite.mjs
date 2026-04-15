import { ethers } from "ethers";
import { loadArtifact, loadConfig, signerFor } from "./ibc-lite-common.mjs";

const USER_INDEX = Number(process.env.USER_INDEX || 1);
const AMOUNT = ethers.parseUnits(process.env.SEED_AMOUNT || "1000", 18);
const LENDING_LIQUIDITY = ethers.parseUnits(process.env.LENDING_LIQUIDITY || "1000", 18);

async function main() {
  const config = await loadConfig();
  const tokenArtifact = await loadArtifact("apps/BankToken.sol", "BankToken");
  const ownerA = await signerFor(config, "A", 0);
  const ownerB = await signerFor(config, "B", 0);
  const user = await signerFor(config, "A", USER_INDEX);
  const canonical = new ethers.Contract(config.chains.A.canonicalToken, tokenArtifact.abi, ownerA);
  const stable = new ethers.Contract(config.chains.B.stableToken, tokenArtifact.abi, ownerB);
  await (await canonical.mint(await user.getAddress(), AMOUNT)).wait();
  await (await stable.mint(config.chains.B.lendingPool, LENDING_LIQUIDITY)).wait();
  console.log(`[seed] minted ${ethers.formatUnits(AMOUNT, 18)} aBANK to ${await user.getAddress()}`);
  console.log(`[seed] funded Bank B lending pool with ${ethers.formatUnits(LENDING_LIQUIDITY, 18)} sBANK`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
