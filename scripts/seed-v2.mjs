import { ethers } from "ethers";
import { loadArtifact, normalizeRuntime, waitForBesuRuntimeReady } from "./ibc-lite-common.mjs";
import { loadV2Config, saveV2Config, signerForV2, V2_CONFIG_PATH } from "./ibc-v2-config.mjs";

const SOURCE_USER_INDEX = Number(process.env.SOURCE_USER_INDEX || process.env.USER_INDEX || 1);
const DESTINATION_USER_INDEX = Number(process.env.DESTINATION_USER_INDEX || process.env.USER_INDEX || 1);
const LIQUIDATOR_INDEX = Number(process.env.LIQUIDATOR_INDEX || 2);

const SOURCE_USER_AMOUNT = ethers.parseUnits(process.env.SEED_AMOUNT || "1000", 18);
const POOL_LIQUIDITY = ethers.parseUnits(process.env.POOL_LIQUIDITY || "10000", 18);
const LIQUIDATOR_DEBT_BALANCE = ethers.parseUnits(process.env.LIQUIDATOR_DEBT_BALANCE || "1000", 18);
const VOUCHER_EXPOSURE_CAP = ethers.parseUnits(process.env.VOUCHER_EXPOSURE_CAP || "1000000", 18);
const COLLATERAL_CAP = ethers.parseUnits(process.env.COLLATERAL_CAP || "1000000", 18);
const DEBT_ASSET_BORROW_CAP = ethers.parseUnits(process.env.DEBT_ASSET_BORROW_CAP || "1000000", 18);
const ACCOUNT_BORROW_CAP = ethers.parseUnits(process.env.ACCOUNT_BORROW_CAP || "2000", 18);
const INITIAL_VOUCHER_PRICE_E18 = ethers.parseUnits(process.env.INITIAL_VOUCHER_PRICE || "2", 18);
const DEBT_PRICE_E18 = ethers.parseUnits(process.env.DEBT_PRICE || "1", 18);
const COLLATERAL_FACTOR_BPS = BigInt(process.env.COLLATERAL_FACTOR_BPS || "8000");
const COLLATERAL_HAIRCUT_BPS = BigInt(process.env.COLLATERAL_HAIRCUT_BPS || "9000");
const LIQUIDATION_CLOSE_FACTOR_BPS = BigInt(process.env.LIQUIDATION_CLOSE_FACTOR_BPS || "5000");
const LIQUIDATION_BONUS_BPS = BigInt(process.env.LIQUIDATION_BONUS_BPS || "500");
const SEED_TX_GAS_LIMIT = BigInt(process.env.SEED_TX_GAS_LIMIT || "1000000");
const TX_WAIT_TIMEOUT_MS = Number(process.env.TX_WAIT_TIMEOUT_MS || 120000);
const SEED_TX_SEND_RETRIES = Number(process.env.SEED_TX_SEND_RETRIES || 2);

async function contractAt(config, chainKey, address, artifact, signerIndex = 0) {
  const signer = await signerForV2(config, chainKey, signerIndex);
  return new ethers.Contract(address, artifact.abi, signer);
}

function txOptions() {
  return { gasLimit: SEED_TX_GAS_LIMIT };
}

function errorSummary(error) {
  return [
    error?.code,
    error?.shortMessage,
    error?.info?.error?.message,
    error?.message,
  ]
    .filter(Boolean)
    .join(" | ");
}

function isRetryableSendError(error) {
  return /BAD_DATA|null.*hash|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(errorSummary(error));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReceipt(tx, label) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`[v2 seed] ${label} timed out waiting for ${tx.hash}`));
    }, TX_WAIT_TIMEOUT_MS);
  });
  const receipt = await Promise.race([tx.wait(), timeout]);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[v2 seed] ${label} failed in transaction ${tx.hash}`);
  }
  return receipt;
}

async function txStep(label, send) {
  console.log(`[v2 seed] ${label}`);
  let tx;
  for (let attempt = 0; attempt <= SEED_TX_SEND_RETRIES; attempt++) {
    try {
      tx = await send();
      if (tx?.hash) break;
      throw new Error("RPC returned an empty transaction response.");
    } catch (error) {
      if (attempt >= SEED_TX_SEND_RETRIES || !isRetryableSendError(error)) {
        throw new Error(`[v2 seed] ${label} send failed: ${errorSummary(error)}`);
      }
      console.log(`[v2 seed] ${label} send retry ${attempt + 1}/${SEED_TX_SEND_RETRIES}: ${errorSummary(error)}`);
      await sleep(1000 * (attempt + 1));
    }
  }
  console.log(`[v2 seed] ${label} tx=${tx.hash}`);
  return waitForReceipt(tx, label);
}

async function ensureBalanceAtLeast(token, account, targetBalance, label) {
  const currentBalance = await token.balanceOf(account);
  if (currentBalance >= targetBalance) {
    console.log(`[v2 seed] ${label} already funded`);
    return;
  }
  await txStep(label, () => token.mint(account, targetBalance - currentBalance, txOptions()));
}

async function main() {
  const runtime = normalizeRuntime();
  if (!runtime.besuFirst) {
    throw new Error("seed-v2.mjs is a Besu-first v2 entrypoint.");
  }

  await waitForBesuRuntimeReady();

  const config = await loadV2Config();
  const tokenArtifact = await loadArtifact("apps/BankToken.sol", "BankToken");
  const policyArtifact = await loadArtifact("v2/apps/BankPolicyEngineV2.sol", "BankPolicyEngineV2");
  const oracleArtifact = await loadArtifact("v2/apps/ManualAssetOracleV2.sol", "ManualAssetOracleV2");
  const lendingArtifact = await loadArtifact("v2/apps/PolicyControlledLendingPoolV2.sol", "PolicyControlledLendingPoolV2");

  const sourceUser = await signerForV2(config, "A", SOURCE_USER_INDEX);
  const destinationUser = await signerForV2(config, "B", DESTINATION_USER_INDEX);
  const liquidator = await signerForV2(config, "B", LIQUIDATOR_INDEX);
  const sourceUserAddress = await sourceUser.getAddress();
  const destinationUserAddress = await destinationUser.getAddress();
  const liquidatorAddress = await liquidator.getAddress();

  const canonicalToken = await contractAt(config, "A", config.chains.A.canonicalToken, tokenArtifact);
  const debtToken = await contractAt(config, "B", config.chains.B.debtToken, tokenArtifact);
  const policyA = await contractAt(config, "A", config.chains.A.policyEngine, policyArtifact);
  const policyB = await contractAt(config, "B", config.chains.B.policyEngine, policyArtifact);
  const oracleB = await contractAt(config, "B", config.chains.B.oracle, oracleArtifact);
  const lendingPoolB = await contractAt(config, "B", config.chains.B.lendingPool, lendingArtifact);

  await ensureBalanceAtLeast(canonicalToken, sourceUserAddress, SOURCE_USER_AMOUNT, "fund source user with canonical token");
  await ensureBalanceAtLeast(debtToken, config.chains.B.lendingPool, POOL_LIQUIDITY, "fund Bank B lending pool");
  await ensureBalanceAtLeast(debtToken, liquidatorAddress, LIQUIDATOR_DEBT_BALANCE, "fund liquidator");

  await txStep("allow source user on Bank A", () => policyA.setAccountAllowed(sourceUserAddress, true, txOptions()));
  await txStep("allow Bank A admin", () => policyA.setAccountAllowed(config.chains.A.admin, true, txOptions()));
  await txStep("allow Bank B source chain on Bank A", () => policyA.setSourceChainAllowed(config.chains.B.chainId, true, txOptions()));
  await txStep("allow canonical unlock asset on Bank A", () =>
    policyA.setUnlockAssetAllowed(config.chains.A.canonicalToken, true, txOptions())
  );

  await txStep("allow destination user on Bank B", () =>
    policyB.setAccountAllowed(destinationUserAddress, true, txOptions())
  );
  await txStep("allow liquidator on Bank B", () => policyB.setAccountAllowed(liquidatorAddress, true, txOptions()));
  await txStep("allow Bank B admin", () => policyB.setAccountAllowed(config.chains.B.admin, true, txOptions()));
  await txStep("allow Bank A source chain on Bank B", () => policyB.setSourceChainAllowed(config.chains.A.chainId, true, txOptions()));
  await txStep("allow canonical mint asset on Bank B", () =>
    policyB.setMintAssetAllowed(config.chains.A.canonicalToken, true, txOptions())
  );
  await txStep("allow voucher collateral asset on Bank B", () =>
    policyB.setCollateralAssetAllowed(config.chains.B.voucherToken, true, txOptions())
  );
  await txStep("allow debt asset on Bank B", () =>
    policyB.setDebtAssetAllowed(config.chains.B.debtToken, true, txOptions())
  );
  await txStep("set voucher exposure cap", () =>
    policyB.setVoucherExposureCap(config.chains.A.canonicalToken, VOUCHER_EXPOSURE_CAP, txOptions())
  );
  await txStep("set collateral cap", () =>
    policyB.setCollateralCap(config.chains.B.voucherToken, COLLATERAL_CAP, txOptions())
  );
  await txStep("set debt asset borrow cap", () =>
    policyB.setDebtAssetBorrowCap(config.chains.B.debtToken, DEBT_ASSET_BORROW_CAP, txOptions())
  );
  await txStep("set destination user borrow cap", () =>
    policyB.setAccountBorrowCap(destinationUserAddress, ACCOUNT_BORROW_CAP, txOptions())
  );

  await txStep("set voucher oracle price", () =>
    oracleB.setPrice(config.chains.B.voucherToken, INITIAL_VOUCHER_PRICE_E18, txOptions())
  );
  await txStep("set debt oracle price", () => oracleB.setPrice(config.chains.B.debtToken, DEBT_PRICE_E18, txOptions()));
  await txStep("configure lending oracle", () => lendingPoolB.setValuationOracle(config.chains.B.oracle, txOptions()));
  await txStep("configure collateral factor", () => lendingPoolB.setCollateralFactor(COLLATERAL_FACTOR_BPS, txOptions()));
  await txStep("configure collateral haircut", () =>
    lendingPoolB.setCollateralHaircut(COLLATERAL_HAIRCUT_BPS, txOptions())
  );
  await txStep("configure liquidation", () =>
    lendingPoolB.setLiquidationConfig(LIQUIDATION_CLOSE_FACTOR_BPS, LIQUIDATION_BONUS_BPS, txOptions())
  );
  await txStep("grant liquidator role", async () =>
    lendingPoolB.grantRole(await lendingPoolB.LIQUIDATOR_ROLE(), liquidatorAddress, txOptions())
  );

  config.status = {
    ...(config.status || {}),
    seeded: true,
  };
  config.participants = {
    sourceUser: sourceUserAddress,
    destinationUser: destinationUserAddress,
    liquidator: liquidatorAddress,
    sourceUserIndex: SOURCE_USER_INDEX,
    destinationUserIndex: DESTINATION_USER_INDEX,
    liquidatorIndex: LIQUIDATOR_INDEX,
  };
  config.seed = {
    sourceUserAmount: SOURCE_USER_AMOUNT.toString(),
    poolLiquidity: POOL_LIQUIDITY.toString(),
    liquidatorDebtBalance: LIQUIDATOR_DEBT_BALANCE.toString(),
    voucherExposureCap: VOUCHER_EXPOSURE_CAP.toString(),
    collateralCap: COLLATERAL_CAP.toString(),
    debtAssetBorrowCap: DEBT_ASSET_BORROW_CAP.toString(),
    accountBorrowCap: ACCOUNT_BORROW_CAP.toString(),
    initialVoucherPriceE18: INITIAL_VOUCHER_PRICE_E18.toString(),
    debtPriceE18: DEBT_PRICE_E18.toString(),
    collateralFactorBps: COLLATERAL_FACTOR_BPS.toString(),
    collateralHaircutBps: COLLATERAL_HAIRCUT_BPS.toString(),
    liquidationCloseFactorBps: LIQUIDATION_CLOSE_FACTOR_BPS.toString(),
    liquidationBonusBps: LIQUIDATION_BONUS_BPS.toString(),
  };
  await saveV2Config(config);

  console.log(`[v2 seed] minted ${ethers.formatUnits(SOURCE_USER_AMOUNT, 18)} aBANK to ${sourceUserAddress}`);
  console.log(`[v2 seed] funded Bank B lending pool with ${ethers.formatUnits(POOL_LIQUIDITY, 18)} bCASH`);
  console.log(`[v2 seed] funded liquidator ${liquidatorAddress} with ${ethers.formatUnits(LIQUIDATOR_DEBT_BALANCE, 18)} bCASH`);
  console.log(`[v2 seed] policy/oracle/risk configuration saved to ${V2_CONFIG_PATH}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
