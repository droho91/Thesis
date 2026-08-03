import { ethers } from "ethers";

export const INSTITUTIONAL_DEPLOYMENT_SCHEMA = "institutional-deployment-v2";

export function artifactFingerprint(artifacts) {
  const hashes = Object.keys(artifacts)
    .sort()
    .map((name) => ethers.keccak256(artifacts[name].deployedBytecode || artifacts[name].bytecode));
  return ethers.keccak256(ethers.concat(hashes));
}

export function createDeploymentManifest({
  fingerprint,
  chainIds,
  chainRpcs,
  accounts,
  attestors,
  threshold,
  maxCheckpointSubmissionAge,
  maxClockDrift,
  finalityDepth,
  governanceDelay,
  now = new Date().toISOString(),
}) {
  return {
    version: INSTITUTIONAL_DEPLOYMENT_SCHEMA,
    status: "deploying",
    artifactFingerprint: fingerprint,
    createdAt: now,
    updatedAt: now,
    securityProfile: {
      checkpointModel: `${threshold}-of-${attestors.length} institutional attestors`,
      attestorThreshold: threshold,
      attestors,
      maxCheckpointSubmissionAgeSeconds: maxCheckpointSubmissionAge.toString(),
      maxClockDriftSeconds: maxClockDrift.toString(),
      finalityDepth: Number(finalityDepth),
      governanceMode: "bootstrap",
      governanceDelaySeconds: governanceDelay.toString(),
      note: "Local integration profile. Production attestor keys must be held by separate institutions/HSMs.",
    },
    accounts: structuredClone(accounts),
    chains: {
      A: { chainId: chainIds.A.toString(), rpc: chainRpcs.A, deploymentBlock: null, contracts: {} },
      B: { chainId: chainIds.B.toString(), rpc: chainRpcs.B, deploymentBlock: null, contracts: {} },
    },
  };
}

export async function runtimeAccountsFromSigners({ owners, users, relayers }) {
  return {
    A: {
      owner: await owners.A.getAddress(),
      user: await users.A.getAddress(),
      relayer: await relayers.A.getAddress(),
    },
    B: {
      owner: await owners.B.getAddress(),
      user: await users.B.getAddress(),
      relayer: await relayers.B.getAddress(),
    },
  };
}

export function deploymentManifestMatchesRuntime({ manifest, fingerprint, chainIds, attestors, accounts }) {
  try {
    return manifest?.version === INSTITUTIONAL_DEPLOYMENT_SCHEMA
      && manifest.artifactFingerprint === fingerprint
      && BigInt(manifest.chains?.A?.chainId || 0) === chainIds.A
      && BigInt(manifest.chains?.B?.chainId || 0) === chainIds.B
      && sameAddressList(manifest.securityProfile?.attestors, attestors)
      && manifestAccountsMatchRuntime(manifest.accounts, accounts);
  } catch {
    return false;
  }
}

export function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

export function compareAddresses(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sameAddressList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  try {
    return left.every((address, index) => sameAddress(address, right[index]));
  } catch {
    return false;
  }
}

export function manifestAccountsMatchRuntime(manifestAccounts, runtimeAccounts) {
  return ["A", "B"].every((chainKey) =>
    ["owner", "user", "relayer"].every((role) => {
      const manifestAddress = manifestAccounts?.[chainKey]?.[role];
      const runtimeAddress = runtimeAccounts?.[chainKey]?.[role];
      return Boolean(manifestAddress && runtimeAddress && sameAddress(manifestAddress, runtimeAddress));
    }),
  );
}
