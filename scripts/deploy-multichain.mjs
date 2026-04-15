import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

const CHAIN_A_RPC = process.env.CHAIN_A_RPC || "http://127.0.0.1:8545";
const CHAIN_B_RPC = process.env.CHAIN_B_RPC || "http://127.0.0.1:9545";
const DEFAULT_FACTOR_BPS = Number(process.env.COLLATERAL_FACTOR_BPS || 5000);
const DEFAULT_PRICE_E8 = BigInt(process.env.DEFAULT_PRICE_E8 || "100000000");
const DEFAULT_ROUTE_TRANSFER_CAP_WEI = ethers.parseUnits(process.env.ROUTE_TRANSFER_CAP || "250", 18);
const DEFAULT_ROUTE_RATE_LIMIT_WEI = ethers.parseUnits(process.env.ROUTE_RATE_LIMIT || "1000", 18);
const DEFAULT_ROUTE_WINDOW_SECONDS = Number(process.env.ROUTE_WINDOW_SECONDS || 3600);
const DEFAULT_HIGH_VALUE_THRESHOLD_WEI = ethers.parseUnits(process.env.HIGH_VALUE_THRESHOLD || "200", 18);
const RELAYER_REWARD_BPS = Number(process.env.RELAYER_REWARD_BPS || 0);
const VALIDATOR_SET_ID = BigInt(process.env.VALIDATOR_SET_ID || 1);
const VALIDATOR_INDICES = (process.env.VALIDATOR_INDICES || "3,4,5").split(",").map((value) => Number(value.trim()));

const ACTION_LOCK_TO_MINT = 1;
const ACTION_BURN_TO_UNLOCK = 2;

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

function chainLabel(key) {
  return key === "A" ? "Bank A" : "Bank B";
}

function marketLabel(sourceKey, destinationKey) {
  return `${sourceKey}_TO_${destinationKey}`;
}

function computeRouteId(label, sourceChainId, destinationChainId, sourceAsset, target, action) {
  return ethers.solidityPackedKeccak256(
    ["string", "string", "uint256", "uint256", "address", "address", "uint8"],
    ["CROSS_CHAIN_LENDING_ROUTE_V1", label, sourceChainId, destinationChainId, sourceAsset, target, action]
  );
}

function routeTuple({
  enabled = true,
  action,
  sourceChainId,
  destinationChainId,
  sourceEmitter,
  sourceSender,
  sourceAsset,
  target,
  flatFee = 0n,
  feeBps = 0,
  transferCap = DEFAULT_ROUTE_TRANSFER_CAP_WEI,
  rateLimitAmount = DEFAULT_ROUTE_RATE_LIMIT_WEI,
  rateLimitWindow = DEFAULT_ROUTE_WINDOW_SECONDS,
  highValueThreshold = DEFAULT_HIGH_VALUE_THRESHOLD_WEI,
}) {
  return [
    enabled,
    action,
    sourceChainId,
    destinationChainId,
    sourceEmitter,
    sourceSender,
    sourceAsset,
    target,
    flatFee,
    feeBps,
    transferCap,
    rateLimitAmount,
    rateLimitWindow,
    highValueThreshold,
  ];
}

async function configureRoute(routeRegistryArtifact, signer, routeRegistryAddress, routeId, config) {
  const registry = new ethers.Contract(routeRegistryAddress, routeRegistryArtifact.abi, signer);
  const tx = await registry.setRoute(routeId, routeTuple(config));
  await tx.wait();
}

async function configureVault(vaultArtifact, signer, vaultAddress, messageBus, routeId, destinationChainId) {
  const vault = new ethers.Contract(vaultAddress, vaultArtifact.abi, signer);
  const tx = await vault.configureDefaultRoute(messageBus, routeId, destinationChainId);
  await tx.wait();
}

async function deployRouterInfra({ owner, chainId, artifacts }) {
  const messageBus = await deploy(artifacts.messageBus, owner, [chainId]);
  const checkpointRegistry = await deploy(artifacts.checkpointRegistry, owner, [chainId, await messageBus.getAddress(), VALIDATOR_SET_ID]);
  const checkpointClient = await deploy(artifacts.checkpointClient, owner, []);
  const messageInbox = await deploy(artifacts.messageInbox, owner, []);
  const routeRegistry = await deploy(artifacts.routeRegistry, owner, []);
  const riskManager = await deploy(artifacts.riskManager, owner, [await routeRegistry.getAddress()]);
  const feeVault = await deploy(artifacts.feeVault, owner, [RELAYER_REWARD_BPS]);
  const bridgeRouter = await deploy(artifacts.bridgeRouter, owner, [
    chainId,
    await messageBus.getAddress(),
    await checkpointClient.getAddress(),
    await messageInbox.getAddress(),
    await routeRegistry.getAddress(),
    await riskManager.getAddress(),
    await feeVault.getAddress(),
  ]);

  await (await messageInbox.grantConsumer(await bridgeRouter.getAddress())).wait();
  await (await riskManager.grantPolicyCaller(await bridgeRouter.getAddress())).wait();
  await (await feeVault.grantCollector(await bridgeRouter.getAddress())).wait();

  return {
    messageBus: await messageBus.getAddress(),
    checkpointRegistry: await checkpointRegistry.getAddress(),
    checkpointClient: await checkpointClient.getAddress(),
    messageInbox: await messageInbox.getAddress(),
    routeRegistry: await routeRegistry.getAddress(),
    riskManager: await riskManager.getAddress(),
    feeVault: await feeVault.getAddress(),
    bridgeRouter: await bridgeRouter.getAddress(),
  };
}

async function deployChainStack({ key, remoteKey, owner, chainId, artifacts }) {
  const collateralSymbol = key === "A" ? "aCOL" : "bCOL";
  const stableSymbol = key === "A" ? "sA" : "sB";
  const wrappedSymbol = key === "A" ? "wB" : "wA";

  const infra = await deployRouterInfra({ owner, chainId, artifacts });

  const localCollateralToken = await deploy(artifacts.stableToken, owner, [`${chainLabel(key)} Collateral`, collateralSymbol]);
  const stableToken = await deploy(artifacts.stableToken, owner, [`${chainLabel(key)} Stable`, stableSymbol]);
  const priceOracle = await deploy(artifacts.priceOracle, owner, []);
  const wrappedRemoteToken = await deploy(artifacts.wrappedCollateral, owner, [
    `${chainLabel(remoteKey)} Wrapped Collateral`,
    wrappedSymbol,
    infra.bridgeRouter,
  ]);
  const collateralVault = await deploy(artifacts.collateralVault, owner, [
    await localCollateralToken.getAddress(),
    infra.bridgeRouter,
  ]);
  await (await collateralVault.configureFeeModules(infra.riskManager, infra.feeVault)).wait();
  const feeVault = new ethers.Contract(infra.feeVault, artifacts.feeVault.abi, owner);
  await (await feeVault.grantCollector(await collateralVault.getAddress())).wait();

  await (await priceOracle.setPrice(await wrappedRemoteToken.getAddress(), DEFAULT_PRICE_E8)).wait();
  await (await priceOracle.setPrice(await stableToken.getAddress(), DEFAULT_PRICE_E8)).wait();

  const lendingPool = await deploy(artifacts.lendingPool, owner, [
    await wrappedRemoteToken.getAddress(),
    await stableToken.getAddress(),
    await priceOracle.getAddress(),
    DEFAULT_FACTOR_BPS,
  ]);

  const swapRouter = await deploy(artifacts.swapRouter, owner, [
    await priceOracle.getAddress(),
    Number(process.env.SWAP_FEE_BPS || 0),
  ]);
  await (await lendingPool.setSwapRouter(await swapRouter.getAddress())).wait();

  return {
    key,
    name: chainLabel(key),
    chainId,
    ...infra,
    localCollateralToken: await localCollateralToken.getAddress(),
    collateralVault: await collateralVault.getAddress(),
    wrappedRemoteToken: await wrappedRemoteToken.getAddress(),
    stableToken: await stableToken.getAddress(),
    priceOracle: await priceOracle.getAddress(),
    swapRouter: await swapRouter.getAddress(),
    lendingPool: await lendingPool.getAddress(),
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

async function loadArtifacts() {
  return {
    stableToken: await loadArtifact("StableToken.sol", "StableToken"),
    collateralVault: await loadArtifact("CollateralVault.sol", "CollateralVault"),
    wrappedCollateral: await loadArtifact("WrappedCollateral.sol", "WrappedCollateral"),
    lendingPool: await loadArtifact("LendingPool.sol", "LendingPool"),
    priceOracle: await loadArtifact("MockPriceOracle.sol", "MockPriceOracle"),
    swapRouter: await loadArtifact("MockSwapRouter.sol", "MockSwapRouter"),
    messageBus: await loadArtifact("bridge/MessageBus.sol", "MessageBus"),
    checkpointRegistry: await loadArtifact("checkpoint/BankCheckpointRegistry.sol", "BankCheckpointRegistry"),
    checkpointClient: await loadArtifact("checkpoint/BankCheckpointClient.sol", "BankCheckpointClient"),
    messageInbox: await loadArtifact("bridge/MessageInbox.sol", "MessageInbox"),
    bridgeRouter: await loadArtifact("bridge/BridgeRouter.sol", "BridgeRouter"),
    routeRegistry: await loadArtifact("risk/RouteRegistry.sol", "RouteRegistry"),
    riskManager: await loadArtifact("risk/RiskManager.sol", "RiskManager"),
    feeVault: await loadArtifact("fees/FeeVault.sol", "FeeVault"),
  };
}

async function validatorAddresses(provider, indices) {
  return Promise.all(indices.map(async (index) => provider.getSigner(index).then((signer) => signer.getAddress())));
}

async function installRemoteValidatorSet({ checkpointArtifact, owner, checkpointClient, sourceChainId, validatorAddresses }) {
  const client = new ethers.Contract(checkpointClient, checkpointArtifact.abi, owner);
  const powers = validatorAddresses.map(() => 1n);
  const tx = await client.setValidatorSet(sourceChainId, VALIDATOR_SET_ID, validatorAddresses, powers, true);
  await tx.wait();
}

async function main() {
  const chainAProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const chainBProvider = new ethers.JsonRpcProvider(CHAIN_B_RPC);

  const chainAId = Number((await chainAProvider.getNetwork()).chainId);
  const chainBId = Number((await chainBProvider.getNetwork()).chainId);
  if (chainAId === chainBId) {
    throw new Error(
      `Both RPC endpoints are on the same chainId (${chainAId}). Start Bank B with a different chainId (recommended 31338).`
    );
  }

  if (!Number.isSafeInteger(DEFAULT_ROUTE_WINDOW_SECONDS) || DEFAULT_ROUTE_WINDOW_SECONDS <= 0) {
    throw new Error(`Invalid ROUTE_WINDOW_SECONDS=${DEFAULT_ROUTE_WINDOW_SECONDS}. Must be a positive integer.`);
  }
  if (RELAYER_REWARD_BPS < 0 || RELAYER_REWARD_BPS > 10_000) {
    throw new Error(`Invalid RELAYER_REWARD_BPS=${RELAYER_REWARD_BPS}. Must be between 0 and 10000.`);
  }

  const ownerA = await chainAProvider.getSigner(0);
  const ownerB = await chainBProvider.getSigner(0);
  const userA = await chainAProvider.getSigner(2);
  const userB = await chainBProvider.getSigner(2);
  const relayerA = await chainAProvider.getSigner(Number(process.env.RELAYER_INDEX_A || 1));
  const relayerB = await chainBProvider.getSigner(Number(process.env.RELAYER_INDEX_B || 1));
  const validatorsA = await validatorAddresses(chainAProvider, VALIDATOR_INDICES);
  const validatorsB = await validatorAddresses(chainBProvider, VALIDATOR_INDICES);

  const artifacts = await loadArtifacts();

  const chainAStack = await deployChainStack({
    key: "A",
    remoteKey: "B",
    owner: ownerA,
    chainId: chainAId,
    artifacts,
  });

  const chainBStack = await deployChainStack({
    key: "B",
    remoteKey: "A",
    owner: ownerB,
    chainId: chainBId,
    artifacts,
  });

  await installRemoteValidatorSet({
    checkpointArtifact: artifacts.checkpointClient,
    owner: ownerB,
    checkpointClient: chainBStack.checkpointClient,
    sourceChainId: chainAId,
    validatorAddresses: validatorsA,
  });
  await installRemoteValidatorSet({
    checkpointArtifact: artifacts.checkpointClient,
    owner: ownerA,
    checkpointClient: chainAStack.checkpointClient,
    sourceChainId: chainBId,
    validatorAddresses: validatorsB,
  });

  const lockAToBRouteId = computeRouteId(
    "A_TO_B_LOCK_TO_MINT",
    chainAId,
    chainBId,
    chainAStack.localCollateralToken,
    chainBStack.wrappedRemoteToken,
    ACTION_LOCK_TO_MINT
  );
  const lockBToARouteId = computeRouteId(
    "B_TO_A_LOCK_TO_MINT",
    chainBId,
    chainAId,
    chainBStack.localCollateralToken,
    chainAStack.wrappedRemoteToken,
    ACTION_LOCK_TO_MINT
  );
  const burnBToARouteId = computeRouteId(
    "B_TO_A_BURN_TO_UNLOCK",
    chainBId,
    chainAId,
    chainBStack.wrappedRemoteToken,
    chainAStack.collateralVault,
    ACTION_BURN_TO_UNLOCK
  );
  const burnAToBRouteId = computeRouteId(
    "A_TO_B_BURN_TO_UNLOCK",
    chainAId,
    chainBId,
    chainAStack.wrappedRemoteToken,
    chainBStack.collateralVault,
    ACTION_BURN_TO_UNLOCK
  );

  await configureVault(artifacts.collateralVault, ownerA, chainAStack.collateralVault, chainAStack.messageBus, lockAToBRouteId, chainBId);
  await configureVault(artifacts.collateralVault, ownerB, chainBStack.collateralVault, chainBStack.messageBus, lockBToARouteId, chainAId);

  const routeConfigs = [
    {
      registry: chainAStack.routeRegistry,
      signer: ownerA,
      routeId: lockAToBRouteId,
      config: {
        action: ACTION_LOCK_TO_MINT,
        sourceChainId: chainAId,
        destinationChainId: chainBId,
        sourceEmitter: chainAStack.messageBus,
        sourceSender: chainAStack.collateralVault,
        sourceAsset: chainAStack.localCollateralToken,
        target: chainBStack.wrappedRemoteToken,
      },
    },
    {
      registry: chainBStack.routeRegistry,
      signer: ownerB,
      routeId: lockAToBRouteId,
      config: {
        action: ACTION_LOCK_TO_MINT,
        sourceChainId: chainAId,
        destinationChainId: chainBId,
        sourceEmitter: chainAStack.messageBus,
        sourceSender: chainAStack.collateralVault,
        sourceAsset: chainAStack.localCollateralToken,
        target: chainBStack.wrappedRemoteToken,
      },
    },
    {
      registry: chainBStack.routeRegistry,
      signer: ownerB,
      routeId: lockBToARouteId,
      config: {
        action: ACTION_LOCK_TO_MINT,
        sourceChainId: chainBId,
        destinationChainId: chainAId,
        sourceEmitter: chainBStack.messageBus,
        sourceSender: chainBStack.collateralVault,
        sourceAsset: chainBStack.localCollateralToken,
        target: chainAStack.wrappedRemoteToken,
      },
    },
    {
      registry: chainAStack.routeRegistry,
      signer: ownerA,
      routeId: lockBToARouteId,
      config: {
        action: ACTION_LOCK_TO_MINT,
        sourceChainId: chainBId,
        destinationChainId: chainAId,
        sourceEmitter: chainBStack.messageBus,
        sourceSender: chainBStack.collateralVault,
        sourceAsset: chainBStack.localCollateralToken,
        target: chainAStack.wrappedRemoteToken,
      },
    },
    {
      registry: chainAStack.routeRegistry,
      signer: ownerA,
      routeId: burnBToARouteId,
      config: {
        action: ACTION_BURN_TO_UNLOCK,
        sourceChainId: chainBId,
        destinationChainId: chainAId,
        sourceEmitter: chainBStack.messageBus,
        sourceSender: chainBStack.bridgeRouter,
        sourceAsset: chainBStack.wrappedRemoteToken,
        target: chainAStack.collateralVault,
      },
    },
    {
      registry: chainBStack.routeRegistry,
      signer: ownerB,
      routeId: burnBToARouteId,
      config: {
        action: ACTION_BURN_TO_UNLOCK,
        sourceChainId: chainBId,
        destinationChainId: chainAId,
        sourceEmitter: chainBStack.messageBus,
        sourceSender: chainBStack.bridgeRouter,
        sourceAsset: chainBStack.wrappedRemoteToken,
        target: chainAStack.collateralVault,
      },
    },
    {
      registry: chainBStack.routeRegistry,
      signer: ownerB,
      routeId: burnAToBRouteId,
      config: {
        action: ACTION_BURN_TO_UNLOCK,
        sourceChainId: chainAId,
        destinationChainId: chainBId,
        sourceEmitter: chainAStack.messageBus,
        sourceSender: chainAStack.bridgeRouter,
        sourceAsset: chainAStack.wrappedRemoteToken,
        target: chainBStack.collateralVault,
      },
    },
    {
      registry: chainAStack.routeRegistry,
      signer: ownerA,
      routeId: burnAToBRouteId,
      config: {
        action: ACTION_BURN_TO_UNLOCK,
        sourceChainId: chainAId,
        destinationChainId: chainBId,
        sourceEmitter: chainAStack.messageBus,
        sourceSender: chainAStack.bridgeRouter,
        sourceAsset: chainAStack.wrappedRemoteToken,
        target: chainBStack.collateralVault,
      },
    },
  ];

  for (const item of routeConfigs) {
    await configureRoute(artifacts.routeRegistry, item.signer, item.registry, item.routeId, item.config);
  }

  const chainARisk = await readRiskSnapshot(artifacts.lendingPool, chainAProvider, chainAStack.lendingPool);
  const chainBRisk = await readRiskSnapshot(artifacts.lendingPool, chainBProvider, chainBStack.lendingPool);

  const ownerAddress = await ownerA.getAddress();
  const userAddress = await userA.getAddress();

  const output = {
    architecture: "bank-checkpoint-router",
    roles: {
      owner: ownerAddress,
      user: userAddress,
      relayers: [await relayerA.getAddress(), await relayerB.getAddress()],
      note: "Relayers are permissionless transport. Signed bank checkpoints and Merkle inclusion proofs are the trust boundary.",
    },
    validatorSimulation: {
      validatorSetId: VALIDATOR_SET_ID.toString(),
      validatorIndices: VALIDATOR_INDICES,
      note: "Local-only consortium simulation. Validators are local dev-node accounts.",
    },
    checkpointDefaults: {
      routeTransferCapWei: DEFAULT_ROUTE_TRANSFER_CAP_WEI.toString(),
      routeRateLimitWei: DEFAULT_ROUTE_RATE_LIMIT_WEI.toString(),
      routeWindowSeconds: DEFAULT_ROUTE_WINDOW_SECONDS,
      highValueThresholdWei: DEFAULT_HIGH_VALUE_THRESHOLD_WEI.toString(),
      relayerRewardBps: RELAYER_REWARD_BPS,
      verifierMode: "signed-checkpoints-and-merkle-inclusion",
    },
    chains: {
      A: {
        rpc: CHAIN_A_RPC,
        owner: ownerAddress,
        user: userAddress,
        risk: chainARisk,
        ...chainAStack,
      },
      B: {
        rpc: CHAIN_B_RPC,
        owner: await ownerB.getAddress(),
        user: await userB.getAddress(),
        risk: chainBRisk,
        ...chainBStack,
      },
    },
    routes: {
      lockAToBRouteId,
      lockBToARouteId,
      burnBToARouteId,
      burnAToBRouteId,
    },
    markets: {
      A_TO_B: {
        id: marketLabel("A", "B"),
        sourceChain: "A",
        destinationChain: "B",
        lockRouteId: lockAToBRouteId,
        burnRouteId: burnBToARouteId,
        sourceCollateralToken: chainAStack.localCollateralToken,
        sourceVault: chainAStack.collateralVault,
        sourceMessageBus: chainAStack.messageBus,
        sourceCheckpointRegistry: chainAStack.checkpointRegistry,
        sourceBridgeRouter: chainAStack.bridgeRouter,
        sourceCheckpointClient: chainAStack.checkpointClient,
        sourceRiskManager: chainAStack.riskManager,
        destinationMessageBus: chainBStack.messageBus,
        destinationCheckpointRegistry: chainBStack.checkpointRegistry,
        destinationBridgeRouter: chainBStack.bridgeRouter,
        destinationCheckpointClient: chainBStack.checkpointClient,
        destinationRiskManager: chainBStack.riskManager,
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
        lockRouteId: lockBToARouteId,
        burnRouteId: burnAToBRouteId,
        sourceCollateralToken: chainBStack.localCollateralToken,
        sourceVault: chainBStack.collateralVault,
        sourceMessageBus: chainBStack.messageBus,
        sourceCheckpointRegistry: chainBStack.checkpointRegistry,
        sourceBridgeRouter: chainBStack.bridgeRouter,
        sourceCheckpointClient: chainBStack.checkpointClient,
        sourceRiskManager: chainBStack.riskManager,
        destinationMessageBus: chainAStack.messageBus,
        destinationCheckpointRegistry: chainAStack.checkpointRegistry,
        destinationBridgeRouter: chainAStack.bridgeRouter,
        destinationCheckpointClient: chainAStack.checkpointClient,
        destinationRiskManager: chainAStack.riskManager,
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

  console.log("Bank checkpoint bridge deployment complete.");
  console.log(JSON.stringify(output, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch((err) => {
  console.error("deploy-multichain failed:");
  console.error(err);
  process.exit(1);
});
