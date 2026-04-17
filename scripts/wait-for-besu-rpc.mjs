import { waitForBesuRuntimeReady } from "./ibc-lite-common.mjs";

async function main() {
  await waitForBesuRuntimeReady();
  console.log("[wait] Besu runtime is ready for deploy/demo commands.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
