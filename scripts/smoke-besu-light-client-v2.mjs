import { resolve } from "node:path";
import { ethers } from "ethers";
import { buildBesuHeaderUpdate } from "./besu-header-v2.mjs";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  deploy,
  loadArtifact,
  signerForRpc,
  waitForBesuRuntimeReady,
  waitForProviderBlockHeight,
} from "./ibc-lite-common.mjs";
import { writeSmokeFailureReport, writeSmokeReport } from "./smoke-report.mjs";

const SOURCE_CHAIN_ID = BigInt(process.env.SOURCE_CHAIN_ID || "41001");
const DESTINATION_CHAIN_KEY = process.env.DESTINATION_CHAIN_KEY || "B";
const OUT_FILE = resolve(process.cwd(), process.env.OUT_FILE || "proofs/besu/light-client-v2-smoke.json");
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

async function main() {
  CURRENT_PHASE = "wait-runtime";
  await waitForBesuRuntimeReady();

  CURRENT_PHASE = "connect-rpcs";
  const sourceProvider = new ethers.JsonRpcProvider(CHAIN_A_RPC);
  const destinationSigner = await signerForRpc(CHAIN_B_RPC, DESTINATION_CHAIN_KEY, 0);
  CURRENT_PHASE = "load-artifact";
  const artifact = await loadArtifact("v2/clients/BesuLightClient.sol", "BesuLightClient");

  CURRENT_PHASE = "wait-source-blocks";
  const latestHeight = await waitForProviderBlockHeight(sourceProvider, 1n, { label: "Bank A" });

  CURRENT_PHASE = "build-header-updates";
  const parentHeight = latestHeight - 1n;
  const parent = await buildBesuHeaderUpdate({
    provider: sourceProvider,
    blockTag: ethers.toQuantity(parentHeight),
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: 1n,
  });
  const latest = await buildBesuHeaderUpdate({
    provider: sourceProvider,
    blockTag: ethers.toQuantity(latestHeight),
    sourceChainId: SOURCE_CHAIN_ID,
    validatorEpoch: 1n,
  });

  CURRENT_PHASE = "deploy";
  const contract = await deploy(artifact, destinationSigner, [await destinationSigner.getAddress()]);
  const contractAddress = await contract.getAddress();

  CURRENT_PHASE = "initialize-and-update";
  const anchor = trustedAnchorFrom(parent);
  await (await contract.initializeTrustAnchor(SOURCE_CHAIN_ID, anchor, parent.validatorSet)).wait();
  await (await contract.updateClient(latest.headerUpdate, latest.validatorSet)).wait();

  CURRENT_PHASE = "read-trusted-state";
  const trustedRoot = await contract.trustedStateRoot(SOURCE_CHAIN_ID, latest.headerUpdate.height);
  const storedHeader = await contract.trustedHeader(SOURCE_CHAIN_ID, latest.headerUpdate.height);

  CURRENT_PHASE = "write-report";
  const output = {
    status: "ok",
    phase: "complete",
    generatedAt: new Date().toISOString(),
    contractAddress,
    sourceChainId: SOURCE_CHAIN_ID.toString(),
    parentHeight: parent.headerUpdate.height.toString(),
    latestHeight: latest.headerUpdate.height.toString(),
    latestHeaderHash: latest.headerUpdate.headerHash,
    trustedStateRoot: trustedRoot,
    storedHeaderHash: storedHeader.headerHash,
    validatorsHash: latest.derived.validatorsHash,
  };

  await writeSmokeReport(OUT_FILE, output);

  console.log(`Deployed BesuLightClient v2 to ${contractAddress}`);
  console.log(`Trusted header ${latest.headerUpdate.height} with state root ${trustedRoot}`);
  console.log(`Saved smoke report to ${OUT_FILE}`);
}

main().catch(async (error) => {
  try {
    await writeSmokeFailureReport(OUT_FILE, error, { phase: CURRENT_PHASE });
  } catch (writeError) {
    console.error("Failed to write failure report:", writeError);
  }
  error.phase =
    typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : CURRENT_PHASE;
  console.error(`Light-client smoke failed during phase: ${error.phase}`);
  console.error(error);
  process.exit(1);
});
