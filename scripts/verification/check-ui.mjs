import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const [
  packageJson,
  html,
  app,
  actionRequest,
  tokenAmount,
  lendingDomain,
  uiPresentation,
  workflowPresentation,
  styles,
  service,
  api,
  runtime,
  readModel,
  doctor,
] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8"),
  readFile(resolve(root, "demo/index.html"), "utf8"),
  readFile(resolve(root, "demo/app.js"), "utf8"),
  readFile(resolve(root, "demo/action-request.js"), "utf8"),
  readFile(resolve(root, "demo/token-amount.js"), "utf8"),
  readFile(resolve(root, "demo/lending-domain.js"), "utf8"),
  readFile(resolve(root, "demo/ui-presentation.js"), "utf8"),
  readFile(resolve(root, "demo/workflow-presentation.js"), "utf8"),
  readFile(resolve(root, "demo/styles.css"), "utf8"),
  readFile(resolve(root, "scripts/ui/service.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ui/api.mjs"), "utf8"),
  readFile(resolve(root, "services/institutional-demo-runtime.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ui/read-model.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ops/demo/doctor.mjs"), "utf8"),
]);
const modularUiSource = [app, lendingDomain, uiPresentation, workflowPresentation].join("\n");

const parsedPackage = JSON.parse(packageJson);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:deploy/);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:governance/);
assert.equal(parsedPackage.scripts["demo:ui"], "node scripts/ui/serve.mjs");
assert.equal(parsedPackage.scripts["demo:doctor"], "node scripts/ops/demo/doctor.mjs");
assert.equal(
  parsedPackage.scripts["institutional:evidence:verify"],
  "node scripts/verification/verify-evidence.mjs",
);
assert.equal(parsedPackage.scripts.deploy, undefined);
assert.equal(parsedPackage.scripts.seed, undefined);

for (const action of ["bridge", "deposit", "borrow", "repay", "repayAll", "withdraw", "return"]) {
  assert.match(modularUiSource, new RegExp(`\\b${action}\\b`), `UI controller should expose ${action}`);
  assert.match(runtime, new RegExp(`\\b${action}\\b`), `runtime should execute ${action}`);
}
assert.match(html, /Institutional Cross-chain Operations/);
assert.match(html, /\/assets\/linky-mark\.svg/);
assert.doesNotMatch(html, /\/assets\/logo\.png/);
assert.doesNotMatch(html, /\/assets\/nexus-mark\.svg/);
assert.match(html, /<strong>Linky<\/strong>/);
assert.match(html, /data-panel="identity"/);
assert.match(html, /id="readinessVerdict"/);
assert.match(html, /class="technical-disclosure"/);
assert.doesNotMatch(html, /Proof-backed liquidity across bank networks|Governed lifecycle|class="linky-runtime"/);
assert.doesNotMatch(html, /class="linky-command-center"|id="linkyWhyButton"/);
assert.doesNotMatch(html, /data-linky-image|class="linky-widget/);
assert.doesNotMatch(app, /assets\/linky\/generated|LINKY_IMAGES|hydrateLinky/);
assert.match(html, /id="transferActionProgress"[^>]+role="progressbar"/);
assert.match(app, /setTransferActionProgress/);
for (const semanticValueId of ["overviewChainABlock", "overviewChainBBlock", "runtimeChainA", "runtimeChainB"]) {
  assert.match(html, new RegExp(`id="${semanticValueId}"`));
}
assert.match(styles, /\.ui-atomic\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(styles, /\.overview-chain-heights\s*\{[^}]*flex-wrap:\s*wrap/s);
assert.doesNotMatch(html, /class="linky-rail"/);
assert.match(html, /id="transferPipeline"/);
assert.match(html, /id="runtimePopover"/);
assert.match(html, /data-status-toggle/);
assert.match(html, /data-panel="evidence"/);
assert.match(html, /id="securityEvidenceList"/);
assert.match(html, /id="benchmarkSamples"/);
assert.match(html, /id="attestorQuorum"/);
assert.doesNotMatch(html, /finalizeForwardHeader|updateForwardClient|proveForwardMint|openRoute/);
assert.doesNotMatch(app, /deploy-seed|reset-seeded|resume-session/);
assert.doesNotMatch(app, /settleDust/);
assert.doesNotMatch(runtime, /settleDust/);
assert.match(styles, /@media\s*\(min-width:\s*1080px\)\s*and\s*\(max-width:\s*1365px\)/i);
assert.doesNotMatch(styles, /@media\s*\([^)]*max-width:\s*(?:[0-9]{1,3}|10[0-7][0-9])px/i);
assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
assert.doesNotMatch(styles, /\.overview-metrics\s*>\s*\.metric-card:hover|\.metric-card:hover\s*>\s*svg/);
assert.match(styles, /\.journey-step:hover/);
assert.match(styles, /min-width:\s*1280px/);
assert.match(styles, /min-width:\s*1080px/);
assert.match(styles, /--canvas:\s*#f4f7fb/i);
assert.match(styles, /Solid Color desktop theme/);
assert.doesNotMatch(styles, /color-mix|linear-gradient|radial-gradient/i);
assert.match(app, /function renderIdentity/);
assert.match(app, /function renderOperationProgress/);
assert.match(service, /InstitutionalDemoRuntime/);
assert.match(service, /formalEvidencePayload/);
assert.match(api, /\/api\/evidence/);
assert.doesNotMatch(api, /institutional-attestor-secrets/);
assert.match(runtime, /InstitutionalRelayEngine/);
assert.match(runtime, /CheckpointAttestor/);
assert.match(runtime, /lockAndMint/);
assert.match(runtime, /burnAndUnlock/);
assert.match(runtime, /InstitutionalActionJournal/);
assert.match(runtime, /getTransactionReceipt/);
assert.match(runtime, /reconciling-relay/);
assert.match(runtime, /messageTimedOut/);
assert.match(app, /createActionRequestStore/);
assert.match(app, /sessionStorage/);
assert.match(actionRequest, /requestId[\s\S]*action[\s\S]*amount/);
assert.match(tokenAmount, /10n \*\* BigInt\(TOKEN_DECIMALS\)/);
assert.match(app, /from "\.\/lending-domain\.js"/);
assert.match(app, /from "\.\/ui-presentation\.js"/);
assert.match(app, /from "\.\/workflow-presentation\.js"/);
assert.match(lendingDomain, /SMALL_BALANCE_THRESHOLD = parseTokenUnits\("0\.01"\)/);
assert.match(lendingDomain, /Enter a decimal amount with at most 18 decimal places\./);
assert.doesNotMatch(modularUiSource, /\+\s*0\.0000001|maximumFractionDigits:\s*8/);
assert.match(app, /catch \(error\) \{\s*currentStatus = null;\s*renderRuntimeFailure/s);
assert.match(app, /const laneReady = Boolean\(currentStatus\?\.laneReady\);[\s\S]*if \(!laneReady\) \{[\s\S]*updateSubmit/);
assert.match(uiPresentation, /applicableToCurrentSource/);
assert.match(uiPresentation, /sourceMatchesCurrent/);
assert.match(readModel, /timelock-enforced|governanceMode/);
assert.match(doctor, /Deployed contract bytecode/);
assert.match(doctor, /classifyDefenseEvidence/);
assert.match(doctor, /readinessVerdict/);

console.log("Institutional UI wiring checks passed.");
