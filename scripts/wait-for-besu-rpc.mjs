import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  providerForRpc,
  waitForBesuRuntimeReady,
  waitForProviderBlockHeight,
} from "./besu-runtime.mjs";

async function main() {
  await waitForBesuRuntimeReady();
  await waitForProviderBlockHeight(providerForRpc(CHAIN_A_RPC), 1n, { label: "Bank A" });
  await waitForProviderBlockHeight(providerForRpc(CHAIN_B_RPC), 1n, { label: "Bank B" });
  console.log("[wait] Besu runtime is ready for deploy/demo commands.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
