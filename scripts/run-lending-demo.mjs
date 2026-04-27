import { getCurrentPhase } from "./demo/context.mjs";
import { helpText, runDemoStep, scenarioEntrypoint } from "./demo/dispatcher.mjs";

export { runDemoStep };

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(helpText());
    return Promise.resolve();
  }

  const stepArgIndex = process.argv.indexOf("--step");
  const stepArg = stepArgIndex >= 0 ? process.argv[stepArgIndex + 1] : null;
  if (stepArgIndex >= 0 && !stepArg) {
    throw new Error(`Missing action after --step.\n${helpText()}`);
  }

  const scenarioArg = argValue("--scenario") || process.env.DEMO_SCENARIO || "risk";
  return stepArg ? runDemoStep(stepArg) : scenarioEntrypoint(scenarioArg)();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    error.phase = typeof error?.phase === "string" && error.phase.length > 0 ? error.phase : getCurrentPhase();
    console.error(`run-lending-demo failed during phase: ${error.phase}`);
    console.error(error);
    process.exit(1);
  });
