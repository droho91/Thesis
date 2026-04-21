import { resolve } from "node:path";
import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-update.mjs";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  deploy,
  loadArtifact,
  signerForRpc,
  waitForBesuRuntimeReady,
} from "./besu-runtime.mjs";
import { writeVerificationFailureReport, writeVerificationReport } from "./verification-report.mjs";

const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const SOURCE_CHAIN_KEY = process.env.SOURCE_CHAIN_KEY || "A";
const DESTINATION_CHAIN_KEY = process.env.DESTINATION_CHAIN_KEY || "B";
const FIXTURE_VALUE = BigInt(process.env.FIXTURE_VALUE || "42");
const STORAGE_SLOT = BigInt(process.env.FIXTURE_STORAGE_SLOT || "0");
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/storage-proof-verification.json");
let CURRENT_PHASE = "bootstrap";

function trustedAnchorFrom(result) {
  return {
    sourceChainId: result.headerUpdate.sourceChainId,
    height: result.headerUpdate.height,
    headerHash: result.headerUpdate.headerHash,
    parentHash: result.headerUpdate.parentHash,
    stateRoot: result.headerUpdate.stateRoot,
    timestamp: BigInt(result.block.timestamp),
    validatorsHash: result.derived.validatorsHash,
    exists: true,
  };
}

function normalizeQuantityHex(value) {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  return bigint === 0n ? "0x" : ethers.toBeHex(bigint);
}

async function buildStorageProof(provider, fixtureAddress, trustedHeight, stateRoot) {
  const slotKey = ethers.toBeHex(STORAGE_SLOT, 32);
  const proof = await provider.send("eth_getProof", [fixtureAddress, [slotKey], ethers.toQuantity(trustedHeight)]);
  if (!proof?.storageProof?.length) {
    throw new Error("eth_getProof did not return a storage proof entry.");
  }

  const storageEntry = proof.storageProof[0];
  return {
    sourceChainId: SOURCE_CHAIN_ID,
    trustedHeight,
    stateRoot,
    account: fixtureAddress,
    storageKey: slotKey,
    expectedValue: ethers.encodeRlp(normalizeQuantityHex(storageEntry.value)),
    accountProof: proof.accountProof,
    storageProof: storageEntry.proof,
    observedValue: storageEntry.value,
  };
}

async function main() {
  CURRENT_PHASE = "wait-runtime";
  await waitForBesuRuntimeReady();

  CURRENT_PHASE = "connect-rpcs";
  const sourceProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const sourceSigner = await signerForRpc(CHAIN_A_RPC, SOURCE_CHAIN_KEY, 0);
  const destinationSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 0);

  CURRENT_PHASE = "load-artifacts";
  const lightClientArtifact = await loadArtifact("clients/BesuLightClient.sol", "BesuLightClient");
  const proofVerifierArtifact = await loadArtifact("core/BesuEVMProofVerifier.sol", "BesuEVMProofVerifier");
  const fixtureArtifact = await loadArtifact("test/StorageProofFixture.sol", "StorageProofFixture");

  CURRENT_PHASE = "deploy-fixture";
  const fixture = await deploy(fixtureArtifact, sourceSigner, [FIXTURE_VALUE]);
  const fixtureAddress = await fixture.getAddress();
  const deploymentReceipt = await fixture.deploymentTransaction().wait();
  const trustedHeight = BigInt(deploymentReceipt.blockNumber);
  if (trustedHeight == 0n) {
    throw new Error("Need at least one parent block before the fixture deployment block.");
  }

  CURRENT_PHASE = "build-header-updates";
  const parent = await buildBesuHeaderUpdate({
    provider: sourceProvider,
    blockTag: ethers.toQuantity(trustedHeight - 1n),
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: 1n,
  });
  const latest = await buildBesuHeaderUpdate({
    provider: sourceProvider,
    blockTag: ethers.toQuantity(trustedHeight),
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: 1n,
  });

  CURRENT_PHASE = "deploy-light-client";
  const lightClient = await deploy(lightClientArtifact, destinationSigner, [await destinationSigner.getAddress()]);
  const lightClientAddress = await lightClient.getAddress();
  CURRENT_PHASE = "initialize-light-client";
  await (await lightClient.initializeTrustAnchor(SOURCE_CHAIN_ID, trustedAnchorFrom(parent), parent.validatorSet)).wait();
  await (await lightClient.updateClient(latest.headerUpdate, latest.validatorSet)).wait();

  CURRENT_PHASE = "deploy-proof-verifier";
  const proofVerifier = await deploy(proofVerifierArtifact, destinationSigner, [lightClientAddress]);
  const proofVerifierAddress = await proofVerifier.getAddress();

  CURRENT_PHASE = "build-storage-proof";
  const proof = await buildStorageProof(sourceProvider, fixtureAddress, trustedHeight, latest.headerUpdate.stateRoot);
  CURRENT_PHASE = "verify-proof";
  const verificationResult = await proofVerifier.verifyStorageProof.staticCall({
    sourceChainId: proof.sourceChainId,
    trustedHeight: proof.trustedHeight,
    stateRoot: proof.stateRoot,
    account: proof.account,
    storageKey: proof.storageKey,
    expectedValue: proof.expectedValue,
    accountProof: proof.accountProof,
    storageProof: proof.storageProof,
  });
  if (!verificationResult) {
    throw new Error("Besu storage proof boundary returned false for the live storage proof.");
  }

  CURRENT_PHASE = "write-report";
  const output = {
    status: "ok",
    phase: "complete",
    generatedAt: new Date().toISOString(),
    lightClientAddress,
    proofVerifierAddress,
    fixtureAddress,
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    trustedHeight: trustedHeight.toString(),
    headerHash: latest.headerUpdate.headerHash,
    trustedStateRoot: latest.headerUpdate.stateRoot,
    fixtureValue: FIXTURE_VALUE.toString(),
    observedValue: proof.observedValue,
    storageKey: proof.storageKey,
    expectedValue: proof.expectedValue,
    verified: verificationResult,
  };

  await writeVerificationReport(OUT_FILE, output);

  console.log(`Deployed StorageProofFixture to ${fixtureAddress} on chain A`);
  console.log(`Deployed BesuLightClient to ${lightClientAddress} on chain B`);
  console.log(`Deployed BesuEVMProofVerifier to ${proofVerifierAddress} on chain B`);
  console.log(`Verified slot ${proof.storageKey} under trusted state root ${latest.headerUpdate.stateRoot}`);
  console.log(`Saved proof-boundary verification report to ${OUT_FILE}`);
}

main().catch(async (error) => {
  try {
    await writeVerificationFailureReport(OUT_FILE, error, { phase: CURRENT_PHASE });
  } catch (writeError) {
    console.error("Failed to write failure report:", writeError);
  }
  error.phase =
    typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : CURRENT_PHASE;
  console.error(`Proof-boundary verification failed during phase: ${error.phase}`);
  console.error(error);
  process.exit(1);
});
