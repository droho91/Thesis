import { resolve } from "node:path";
import { ethers } from "ethers";
import { readJson, writeJsonAtomic } from "../../../services/shared/json-file.mjs";
import { createTransactionWaiter } from "../../../services/shared/transaction-receipt.mjs";
import { defaultBesuRuntimeEnv, loadArtifact, signerForRpc } from "../besu/runtime.mjs";

defaultBesuRuntimeEnv();

const MANIFEST_PATH = resolve(
  process.cwd(),
  process.env.INSTITUTIONAL_DEPLOYMENT_PATH || ".runtime/institutional-deployment.json",
);
const TX_TIMEOUT_MS = Number(process.env.INSTITUTIONAL_TX_TIMEOUT_MS || 90_000);
const waitForTx = createTransactionWaiter({
  timeoutMs: TX_TIMEOUT_MS,
  timeoutMessage: ({ label, hash }) => `${label} timed out; tx=${hash}`,
  failureMessage: ({ label, hash }) => `${label} failed; tx=${hash}`,
});

async function main() {
  const manifest = await readJson(MANIFEST_PATH);
  if (manifest.version !== "institutional-deployment-v2" || manifest.status !== "ready") {
    throw new Error("Institutional deployment manifest is not ready");
  }
  const artifacts = await loadArtifacts();
  const signers = {
    A: await signerForRpc(manifest.chains.A.rpc, "A", 0),
    B: await signerForRpc(manifest.chains.B.rpc, "B", 0),
  };
  const matrices = await Promise.all(
    ["A", "B"].map((chainKey) => buildRoleMatrix(chainKey, manifest, signers[chainKey], artifacts)),
  );

  // Grant every governance role first so interruption cannot leave any contract without an administrator.
  for (const matrix of matrices) {
    for (const entry of matrix.contracts) {
      for (const role of entry.governedRoles) {
        await ensureGranted(entry.contract, role, matrix.timelock, `${matrix.chainKey}.${entry.name}`);
      }
    }
  }

  for (const matrix of matrices) {
    for (const entry of matrix.contracts) {
      for (const role of rolesWithDefaultAdminLast(entry.governedRoles)) {
        await ensureRenounced(entry.contract, role, matrix.owner, `${matrix.chainKey}.${entry.name}`);
      }
    }
    await ensureRenounced(
      matrix.governance,
      ethers.ZeroHash,
      matrix.owner,
      `${matrix.chainKey}.governance bootstrap admin`,
    );
  }

  const evidence = [];
  for (const matrix of matrices) evidence.push(await verifyMatrix(matrix));
  manifest.securityProfile.governanceMode = "timelock-enforced";
  manifest.securityProfile.governanceFinalizedAt = new Date().toISOString();
  manifest.securityProfile.governance = {
    delaySeconds: manifest.securityProfile.governanceDelaySeconds,
    proposerProfile: "local bank operator; replace with institutional multisig in production",
    emergencyProfile: "operator retains pause-only guardian roles",
    evidence,
  };
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(MANIFEST_PATH, manifest);
  console.log(`[governance] timelock handoff complete: ${MANIFEST_PATH}`);
}

async function loadArtifacts() {
  return {
    checkpointClient: await loadArtifact("gateway/InstitutionalCheckpointClient.sol", "InstitutionalCheckpointClient"),
    gateway: await loadArtifact("gateway/InstitutionalCrossChainGateway.sol", "InstitutionalCrossChainGateway"),
    identityRegistry: await loadArtifact("identity/InstitutionalIdentityRegistry.sol", "InstitutionalIdentityRegistry"),
    policyEngine: await loadArtifact("apps/BankPolicyEngine.sol", "BankPolicyEngine"),
    escrowVault: await loadArtifact("apps/PolicyControlledEscrowVault.sol", "PolicyControlledEscrowVault"),
    voucherToken: await loadArtifact("apps/PolicyControlledVoucherToken.sol", "PolicyControlledVoucherToken"),
    restitutionVault: await loadArtifact(
      "apps/InstitutionalRestitutionVault.sol",
      "InstitutionalRestitutionVault",
    ),
    oracle: await loadArtifact("apps/ManualAssetOracle.sol", "ManualAssetOracle"),
    lendingPool: await loadArtifact("apps/PolicyControlledLendingPool.sol", "PolicyControlledLendingPool"),
    collateralApp: await loadArtifact("apps/InstitutionalCollateralApp.sol", "InstitutionalCollateralApp"),
    bankToken: await loadArtifact("apps/BankToken.sol", "BankToken"),
    governance: await loadArtifact(
      "governance/InstitutionalGovernanceTimelock.sol",
      "InstitutionalGovernanceTimelock",
    ),
  };
}

async function buildRoleMatrix(chainKey, manifest, signer, artifacts) {
  const chain = manifest.chains[chainKey];
  const owner = ethers.getAddress(await signer.getAddress());
  const addressOf = (name) => chain.contracts[name]?.address;
  const contract = (name, artifactName = name) =>
    new ethers.Contract(addressOf(name), artifacts[artifactName].abi, signer);
  const governance = contract("governance");
  const timelock = ethers.getAddress(await governance.getAddress());
  const entries = [];

  const checkpointClient = contract("checkpointClient");
  entries.push(roleEntry("checkpointClient", checkpointClient, [
    await checkpointClient.CHECKPOINT_ADMIN_ROLE(),
    ethers.ZeroHash,
  ], [await checkpointClient.GUARDIAN_ROLE()]));

  const gateway = contract("gateway");
  entries.push(roleEntry("gateway", gateway, [await gateway.GATEWAY_ADMIN_ROLE(), ethers.ZeroHash], [
    await gateway.GUARDIAN_ROLE(),
  ]));

  const identityRegistry = contract("identityRegistry");
  entries.push(roleEntry("identityRegistry", identityRegistry, [ethers.ZeroHash], [
    await identityRegistry.IDENTITY_ISSUER_ROLE(),
    await identityRegistry.COMPLIANCE_ROLE(),
    await identityRegistry.GUARDIAN_ROLE(),
  ]));

  const policyEngine = contract("policyEngine");
  entries.push(roleEntry("policyEngine", policyEngine, [await policyEngine.POLICY_ADMIN_ROLE(), ethers.ZeroHash], []));

  const collateralApp = contract("collateralApp");
  entries.push(roleEntry("collateralApp", collateralApp, [await collateralApp.APP_ADMIN_ROLE(), ethers.ZeroHash], [
    await collateralApp.GUARDIAN_ROLE(),
  ]));

  const restitutionVault = contract("restitutionVault");
  entries.push(roleEntry("restitutionVault", restitutionVault, [
    await restitutionVault.APP_ADMIN_ROLE(),
    await restitutionVault.CLAIM_ADMIN_ROLE(),
    ethers.ZeroHash,
  ], []));

  if (chainKey === "A") {
    const escrowVault = contract("escrowVault");
    entries.push(roleEntry("escrowVault", escrowVault, [await escrowVault.APP_ADMIN_ROLE(), ethers.ZeroHash], [
      await escrowVault.GUARDIAN_ROLE(),
    ]));
    const canonicalToken = contract("canonicalToken", "bankToken");
    entries.push(roleEntry("canonicalToken", canonicalToken, [ethers.ZeroHash], [await canonicalToken.MINTER_ROLE()]));
  } else {
    const voucherToken = contract("voucherToken");
    entries.push(roleEntry("voucherToken", voucherToken, [await voucherToken.APP_ADMIN_ROLE(), ethers.ZeroHash], [
      await voucherToken.GUARDIAN_ROLE(),
    ]));
    const debtToken = contract("debtToken", "bankToken");
    entries.push(roleEntry("debtToken", debtToken, [ethers.ZeroHash], [await debtToken.MINTER_ROLE()]));
    const oracle = contract("oracle");
    entries.push(roleEntry("oracle", oracle, [ethers.ZeroHash], [await oracle.ORACLE_ADMIN_ROLE()]));
    const lendingPool = contract("lendingPool");
    entries.push(roleEntry("lendingPool", lendingPool, [
      await lendingPool.RISK_ADMIN_ROLE(),
      await lendingPool.RESERVE_MANAGER_ROLE(),
      ethers.ZeroHash,
    ], [await lendingPool.GUARDIAN_ROLE(), await lendingPool.LIQUIDATOR_ROLE()]));
  }

  return { chainKey, owner, timelock, governance, contracts: entries };
}

function roleEntry(name, contract, governedRoles, retainedRoles) {
  return { name, contract, governedRoles, retainedRoles };
}

async function ensureGranted(contract, role, account, label) {
  if (await contract.hasRole(role, account)) return;
  console.log(`[governance] grant ${label} role=${role} to timelock`);
  await waitForTx(await contract.grantRole(role, account, txOptions()), `grant ${label}`);
}

async function ensureRenounced(contract, role, owner, label) {
  if (!(await contract.hasRole(role, owner))) return;
  console.log(`[governance] renounce ${label} role=${role} from operator`);
  await waitForTx(await contract.renounceRole(role, owner, txOptions()), `renounce ${label}`);
}

async function verifyMatrix(matrix) {
  const contracts = [];
  for (const entry of matrix.contracts) {
    for (const role of entry.governedRoles) {
      if (!(await entry.contract.hasRole(role, matrix.timelock))) {
        throw new Error(`${matrix.chainKey}.${entry.name} timelock role handoff is incomplete`);
      }
      if (await entry.contract.hasRole(role, matrix.owner)) {
        throw new Error(`${matrix.chainKey}.${entry.name} operator still has governed role ${role}`);
      }
    }
    for (const role of entry.retainedRoles) {
      if (!(await entry.contract.hasRole(role, matrix.owner))) {
        throw new Error(`${matrix.chainKey}.${entry.name} operator lost required operational role ${role}`);
      }
    }
    contracts.push({
      name: entry.name,
      governedRoleCount: entry.governedRoles.length,
      retainedOperationalRoleCount: entry.retainedRoles.length,
    });
  }
  if (!(await matrix.governance.hasRole(ethers.ZeroHash, matrix.timelock))) {
    throw new Error(`${matrix.chainKey} timelock is not self-administered`);
  }
  if (await matrix.governance.hasRole(ethers.ZeroHash, matrix.owner)) {
    throw new Error(`${matrix.chainKey} bootstrap timelock administrator was not removed`);
  }
  return { chain: matrix.chainKey, timelock: matrix.timelock, operator: matrix.owner, contracts };
}

function rolesWithDefaultAdminLast(roles) {
  return [...roles].sort((left, right) => (left === ethers.ZeroHash ? 1 : right === ethers.ZeroHash ? -1 : 0));
}

function txOptions() {
  return { gasLimit: 5_000_000n };
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
