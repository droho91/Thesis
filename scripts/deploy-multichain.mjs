import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";
const DEFAULT_FACTOR_BPS = Number(process.env.COLLATERAL_FACTOR_BPS || 5000);
const DEFAULT_PRICE_E8 = BigInt(process.env.DEFAULT_PRICE_E8 || "100000000");
const DEFAULT_BRIDGE_TX_CAP_WEI = ethers.parseUnits("250", 18);

function artifactPath(fileName, contractName) {
  return resolve(process.cwd(), "artifacts", "contracts", fileName, `${contractName}.json`);
}

async function loadArtifact(fileName, contractName) {
  const raw = await readFile(artifactPath(fileName, contractName), "utf8");
  return JSON.parse(raw);
}

async function deploy(artifact, signer, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function initializeSourceEmitter(gatewayArtifact, signer, gatewayAddress, sourceEmitterAddress) {
  const gateway = new ethers.Contract(gatewayAddress, gatewayArtifact.abi, signer);
  const tx = await gateway.initializeSourceEmitter(sourceEmitterAddress);
  await tx.wait();
}

function chainLabel(key) {
  return key === "A" ? "Chain A" : "Chain B";
}

function marketLabel(sourceKey, destinationKey) {
  return `${sourceKey}_TO_${destinationKey}`;
}

async function deployChainStack({
  key,
  remoteKey,
  owner,
  chainId,
  remoteChainId,
  validators,
  bridgeThreshold,
  bridgeTxCapWei,
  stableArtifact,
  vaultArtifact,
  wrappedArtifact,
  poolArtifact,
  oracleArtifact,
  routerArtifact,
  gatewayArtifact,
  unlockSelector,
  mintSelector,
  burnSelector,
}) {
  const collateralSymbol = key === "A" ? "aCOL" : "bCOL";
  const stableSymbol = key === "A" ? "sA" : "sB";
  const wrappedSymbol = key === "A" ? "wB" : "wA";

  const localCollateralToken = await deploy(stableArtifact, owner, [`${chainLabel(key)} Collateral`, collateralSymbol]);
  const stableToken = await deploy(stableArtifact, owner, [`${chainLabel(key)} Stable`, stableSymbol]);
  const priceOracle = await deploy(oracleArtifact, owner, []);

  const mintGateway = await deploy(gatewayArtifact, owner, [
    remoteChainId,
    chainId,
    1,
    validators,
    bridgeThreshold,
    mintSelector,
    burnSelector,
    bridgeTxCapWei,
  ]);

  const unlockGateway = await deploy(gatewayArtifact, owner, [
    remoteChainId,
    chainId,
    2,
    validators,
    bridgeThreshold,
    unlockSelector,
    "0x00000000",
    bridgeTxCapWei,
  ]);

  const wrappedRemoteToken = await deploy(wrappedArtifact, owner, [
    `${chainLabel(remoteKey)} Wrapped Collateral`,
    wrappedSymbol,
    await mintGateway.getAddress(),
  ]);
  await (await mintGateway.initializeTarget(await wrappedRemoteToken.getAddress())).wait();

  const collateralVault = await deploy(vaultArtifact, owner, [
    await localCollateralToken.getAddress(),
    await unlockGateway.getAddress(),
  ]);
  await (await unlockGateway.initializeTarget(await collateralVault.getAddress())).wait();

  await (await priceOracle.setPrice(await wrappedRemoteToken.getAddress(), DEFAULT_PRICE_E8)).wait();
  await (await priceOracle.setPrice(await stableToken.getAddress(), DEFAULT_PRICE_E8)).wait();

  const lendingPool = await deploy(poolArtifact, owner, [
    await wrappedRemoteToken.getAddress(),
    await stableToken.getAddress(),
    await priceOracle.getAddress(),
    DEFAULT_FACTOR_BPS,
  ]);

  const swapRouter = await deploy(routerArtifact, owner, [
    await priceOracle.getAddress(),
    Number(process.env.SWAP_FEE_BPS || 0),
  ]);
  await (await lendingPool.setSwapRouter(await swapRouter.getAddress())).wait();

  return {
    key,
    name: chainLabel(key),
    chainId,
    localCollateralToken: await localCollateralToken.getAddress(),
    collateralVault: await collateralVault.getAddress(),
    wrappedRemoteToken: await wrappedRemoteToken.getAddress(),
    stableToken: await stableToken.getAddress(),
    priceOracle: await priceOracle.getAddress(),
    swapRouter: await swapRouter.getAddress(),
    lendingPool: await lendingPool.getAddress(),
    mintGateway: await mintGateway.getAddress(),
    unlockGateway: await unlockGateway.getAddress(),
    
    symbols: {
      collateral: collateralSymbol,
      wrapped: wrappedSymbol,
      stable: stableSymbol,
    },
    priceE8: DEFAULT_PRICE_E8.toString(),
  };
}

async function readRiskSnapshot(poolArtifact, provider, address) {
  const pool = new ethers.Contract(address, poolArtifact.abi, provider);
  return {
    collateralFactorBps: Number(await pool.collateralFactorBps()),
    liquidationThresholdBps: Number(await pool.liquidationThresholdBps()),
    closeFactorBps: Number(await pool.closeFactorBps()),
    loanDuration: Number(await pool.loanDuration()),
    overduePenaltyBps: Number(await pool.overduePenaltyBps()),
    liquidationBonusBps: Number(await pool.liquidationBonusBps()),
    baseRateBps: Number(await pool.baseRateBps()),
    slope1Bps: Number(await pool.slope1Bps()),
    slope2Bps: Number(await pool.slope2Bps()),
    kinkBps: Number(await pool.kinkBps()),
  };
}

async function main() {
  const chainAProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const chainBProvider = new ethers.JsonRpcProvider(CHAIN_B_RPC);

  const chainAId = Number((await chainAProvider.getNetwork()).chainId);
  const chainBId = Number((await chainBProvider.getNetwork()).chainId);
  if (chainAId === chainBId) {
    throw new Error(
      `Both RPC endpoints are on the same chainId (${chainAId}). Start chain B with a different chainId (recommended 31338).`
    );
  }

  const ownerA = await chainAProvider.getSigner(0);
  const ownerB = await chainBProvider.getSigner(0);
  const userA = await chainAProvider.getSigner(2);
  const userB = await chainBProvider.getSigner(2);

  const validatorIndexes = [1, 3, 4];
  const bridgeThreshold = Number(process.env.BRIDGE_THRESHOLD || 2);
  const bridgeTxCapWei = BigInt(process.env.BRIDGE_TX_CAP_WEI || DEFAULT_BRIDGE_TX_CAP_WEI.toString());

  const validatorsA = [];
  const validatorsB = [];
  for (const idx of validatorIndexes) {
    validatorsA.push(await (await chainAProvider.getSigner(idx)).getAddress());
    validatorsB.push(await (await chainBProvider.getSigner(idx)).getAddress());
  }

  for (let i = 0; i < validatorsA.length; i++) {
    if (validatorsA[i].toLowerCase() !== validatorsB[i].toLowerCase()) {
      throw new Error(`Validator address mismatch at index ${validatorIndexes[i]} across chain A and B.`);
    }
  }

  if (bridgeThreshold <= 0 || bridgeThreshold > validatorsA.length) {
    throw new Error(`Invalid BRIDGE_THRESHOLD=${bridgeThreshold}. Must be between 1 and ${validatorsA.length}.`);
  }

  const stableArtifact = await loadArtifact("StableToken.sol", "StableToken");
  const vaultArtifact = await loadArtifact("CollateralVault.sol", "CollateralVault");
  const wrappedArtifact = await loadArtifact("WrappedCollateral.sol", "WrappedCollateral");
  const poolArtifact = await loadArtifact("LendingPool.sol", "LendingPool");
  const oracleArtifact = await loadArtifact("MockPriceOracle.sol", "MockPriceOracle");
  const routerArtifact = await loadArtifact("MockSwapRouter.sol", "MockSwapRouter");
  const gatewayArtifact = await loadArtifact("BridgeGateway.sol", "BridgeGateway");

  const unlockSelector = ethers.id("unlockFromBurnEvent(address,uint256,bytes32)").slice(0, 10);
  const mintSelector = ethers.id("mintFromLockEvent(address,uint256,bytes32)").slice(0, 10);
  const burnSelector = ethers.id("burn(address,uint256)").slice(0, 10);

  const chainAStack = await deployChainStack({
    key: "A",
    remoteKey: "B",
    owner: ownerA,
    chainId: chainAId,
    remoteChainId: chainBId,
    validators: validatorsA,
    bridgeThreshold,
    bridgeTxCapWei,
    stableArtifact,
    vaultArtifact,
    wrappedArtifact,
    poolArtifact,
    oracleArtifact,
    routerArtifact,
    gatewayArtifact,
    unlockSelector,
    mintSelector,
    burnSelector,
  });

  const chainBStack = await deployChainStack({
    key: "B",
    remoteKey: "A",
    owner: ownerB,
    chainId: chainBId,
    remoteChainId: chainAId,
    validators: validatorsB,
    bridgeThreshold,
    bridgeTxCapWei,
    stableArtifact,
    vaultArtifact,
    wrappedArtifact,
    poolArtifact,
    oracleArtifact,
    routerArtifact,
    gatewayArtifact,
    unlockSelector,
    mintSelector,
    burnSelector,
  });

  await initializeSourceEmitter(gatewayArtifact, ownerA, chainAStack.mintGateway, chainBStack.collateralVault);
  await initializeSourceEmitter(gatewayArtifact, ownerA, chainAStack.unlockGateway, chainBStack.mintGateway);
  await initializeSourceEmitter(gatewayArtifact, ownerB, chainBStack.mintGateway, chainAStack.collateralVault);
  await initializeSourceEmitter(gatewayArtifact, ownerB, chainBStack.unlockGateway, chainAStack.mintGateway);

  const chainARisk = await readRiskSnapshot(poolArtifact, chainAProvider, chainAStack.lendingPool);
  const chainBRisk = await readRiskSnapshot(poolArtifact, chainBProvider, chainBStack.lendingPool);

  const ownerAddress = await ownerA.getAddress();
  const userAddress = await userA.getAddress();

  const output = {
    roles: {
      owner: ownerAddress,
      user: userAddress,
      validators: validatorsA,
      bridgeThreshold,
      bridgeTxCapWei: bridgeTxCapWei.toString(),
    },
    chains: {
      A: {
        rpc: CHAIN_A_RPC,
        chainId: chainAId,
        owner: ownerAddress,
        user: userAddress,
        validators: validatorsA,
        bridgeThreshold,
        bridgeTxCapWei: bridgeTxCapWei.toString(),
        ...chainAStack,
        risk: chainARisk,
      },
      B: {
        rpc: CHAIN_B_RPC,
        chainId: chainBId,
        owner: await ownerB.getAddress(),
        user: await userB.getAddress(),
        validators: validatorsB,
        bridgeThreshold,
        bridgeTxCapWei: bridgeTxCapWei.toString(),
        ...chainBStack,
        risk: chainBRisk,
      },
    },
    markets: {
      A_TO_B: {
        id: marketLabel("A", "B"),
        sourceChain: "A",
        destinationChain: "B",
        sourceCollateralToken: chainAStack.localCollateralToken,
        sourceVault: chainAStack.collateralVault,
        sourceUnlockGateway: chainAStack.unlockGateway,
        destinationMintGateway: chainBStack.mintGateway,
        destinationWrappedToken: chainBStack.wrappedRemoteToken,
        destinationStableToken: chainBStack.stableToken,
        destinationPriceOracle: chainBStack.priceOracle,
        destinationLendingPool: chainBStack.lendingPool,
        symbols: {
          collateral: chainAStack.symbols.collateral,
          wrapped: chainBStack.symbols.wrapped,
          stable: chainBStack.symbols.stable,
        },
      },
      B_TO_A: {
        id: marketLabel("B", "A"),
        sourceChain: "B",
        destinationChain: "A",
        sourceCollateralToken: chainBStack.localCollateralToken,
        sourceVault: chainBStack.collateralVault,
        sourceUnlockGateway: chainBStack.unlockGateway,
        destinationMintGateway: chainAStack.mintGateway,
        destinationWrappedToken: chainAStack.wrappedRemoteToken,
        destinationStableToken: chainAStack.stableToken,
        destinationPriceOracle: chainAStack.priceOracle,
        destinationLendingPool: chainAStack.lendingPool,
        symbols: {
          collateral: chainBStack.symbols.collateral,
          wrapped: chainAStack.symbols.wrapped,
          stable: chainAStack.symbols.stable,
        },
      },
    },
  };

  const outPath = resolve(process.cwd(), "demo", "multichain-addresses.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log("Multi-chain deployment complete.");
  console.log(JSON.stringify(output, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error("deploy-multichain failed:");
  console.error(err);
  process.exit(1);
});
