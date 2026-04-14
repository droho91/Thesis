import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

const DECIMALS = 18;
const COLLATERAL_SEED = process.env.COLLATERAL_SEED || "100";
const STABLE_LIQUIDITY = process.env.STABLE_LIQUIDITY || "1000";
const ROUTER_STABLE_LIQUIDITY = process.env.ROUTER_STABLE_LIQUIDITY || "1000";

function toWei(value) {
  return ethers.parseUnits(value, DECIMALS);
}

async function assertContract(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} is not deployed at ${address}. Run deploy:multichain after starting both chains.`);
  }
}

async function mintToken(provider, tokenAddress, to, amount) {
  const owner = await provider.getSigner(0);
  const token = new ethers.Contract(tokenAddress, ["function mint(address to, uint256 amount)"], owner);
  const tx = await token.mint(to, amount);
  await tx.wait();
}

async function main() {
  const cfgPath = resolve(process.cwd(), "demo", "multichain-addresses.json");
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"));

  const providerA = new ethers.JsonRpcProvider(cfg.chains.A.rpc);
  const providerB = new ethers.JsonRpcProvider(cfg.chains.B.rpc);

  const chainA = cfg.chains?.A;
  const chainB = cfg.chains?.B;
  if (!chainA || !chainB) {
    throw new Error("Config is missing chains.A / chains.B. Run deploy:multichain again.");
  }

  await assertContract(providerA, chainA.localCollateralToken, "Bank A local collateral token");
  await assertContract(providerA, chainA.stableToken, "Bank A stable token");
  await assertContract(providerA, chainA.lendingPool, "Bank A lending pool");
  await assertContract(providerA, chainA.swapRouter, "Bank A swap router");
  await assertContract(providerB, chainB.localCollateralToken, "Bank B local collateral token");
  await assertContract(providerB, chainB.stableToken, "Bank B stable token");
  await assertContract(providerB, chainB.lendingPool, "Bank B lending pool");
  await assertContract(providerB, chainB.swapRouter, "Bank B swap router");

  const collateralSeedWei = toWei(COLLATERAL_SEED);
  const stableSeedWei = toWei(STABLE_LIQUIDITY);
  const routerStableSeedWei = toWei(ROUTER_STABLE_LIQUIDITY);

  await mintToken(providerA, chainA.localCollateralToken, cfg.roles.user, collateralSeedWei);
  await mintToken(providerB, chainB.localCollateralToken, cfg.roles.user, collateralSeedWei);
  await mintToken(providerA, chainA.stableToken, chainA.lendingPool, stableSeedWei);
  await mintToken(providerB, chainB.stableToken, chainB.lendingPool, stableSeedWei);
  await mintToken(providerA, chainA.stableToken, chainA.swapRouter, routerStableSeedWei);
  await mintToken(providerB, chainB.stableToken, chainB.swapRouter, routerStableSeedWei);

  console.log("Seed complete:");
  console.log(`- Minted ${COLLATERAL_SEED} ${chainA.symbols.collateral} to user on Bank A`);
  console.log(`- Minted ${COLLATERAL_SEED} ${chainB.symbols.collateral} to user on Bank B`);
  console.log(`- Minted ${STABLE_LIQUIDITY} ${chainA.symbols.stable} to lending pool on Bank A`);
  console.log(`- Minted ${STABLE_LIQUIDITY} ${chainB.symbols.stable} to lending pool on Bank B`);
  console.log(`- Minted ${ROUTER_STABLE_LIQUIDITY} ${chainA.symbols.stable} to swap router on Bank A`);
  console.log(`- Minted ${ROUTER_STABLE_LIQUIDITY} ${chainB.symbols.stable} to swap router on Bank B`);
}

main().catch((err) => {
  console.error("seed-multichain failed:");
  console.error(err);
  process.exit(1);
});
