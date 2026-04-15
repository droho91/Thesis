import { ethers } from "ethers";
import { loadArtifact, loadConfig, signerFor } from "./ibc-lite-common.mjs";

const USER_INDEX = Number(process.env.USER_INDEX || 1);
const AMOUNT = ethers.parseUnits(process.env.SEED_AMOUNT || "1000", 18);

async function main() {
  const config = await loadConfig();
  const tokenArtifact = await loadArtifact("apps/BankToken.sol", "BankToken");
  const ownerA = await signerFor(config, "A", 0);
  const user = await signerFor(config, "A", USER_INDEX);
  const canonical = new ethers.Contract(config.chains.A.canonicalToken, tokenArtifact.abi, ownerA);
  await (await canonical.mint(await user.getAddress(), AMOUNT)).wait();
  console.log(`[seed] minted ${ethers.formatUnits(AMOUNT, 18)} aBANK to ${await user.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
