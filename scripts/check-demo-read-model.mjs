import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  afterLiquidationState,
  healthFactorFor,
  normalizeTraceForUi,
  resolveShockPreviewPriceE18,
  riskPolicySnapshot,
} from "./demo-read-model.mjs";

const e18 = (value) => ethers.parseUnits(value, 18);

function functionBlock(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} function block should exist`);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const demoRunner = await readFile(resolve(process.cwd(), "scripts", "run-lending-demo.mjs"), "utf8");
const packageJson = await readFile(resolve(process.cwd(), "package.json"), "utf8");
const besuGenerator = await readFile(resolve(process.cwd(), "scripts", "generate-besu-qbft-networks.mjs"), "utf8");
const besuClean = await readFile(resolve(process.cwd(), "scripts", "clean-besu-data.mjs"), "utf8");
const seedDemo = await readFile(resolve(process.cwd(), "scripts", "seed-lending-demo.mjs"), "utf8");
const besuRuntime = await readFile(resolve(process.cwd(), "scripts", "besu-runtime.mjs"), "utf8");
const preflightBesu = await readFile(resolve(process.cwd(), "scripts", "preflight-besu-runtime.mjs"), "utf8");
const demoReadModel = await readFile(resolve(process.cwd(), "scripts", "demo-read-model.mjs"), "utf8");
const demoService = await readFile(resolve(process.cwd(), "scripts", "demo-service.mjs"), "utf8");
const demoApi = await readFile(resolve(process.cwd(), "scripts", "demo-api.mjs"), "utf8");
const demoStaticServer = await readFile(resolve(process.cwd(), "scripts", "demo-static-server.mjs"), "utf8");
const lendingActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "lending-actions.mjs"), "utf8");
const liquidationActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "liquidation-actions.mjs"), "utf8");
const forwardBridgeActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "forward-bridge-actions.mjs"), "utf8");
const reverseBridgeActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "reverse-bridge-actions.mjs"), "utf8");
const timeoutActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "timeout-actions.mjs"), "utf8");
const borrowerScenario = await readFile(resolve(process.cwd(), "scripts", "demo", "scenarios", "borrower-closeout.mjs"), "utf8");
const demoApp = await readFile(resolve(process.cwd(), "demo", "app.js"), "utf8");

const repayBlock = functionBlock(lendingActions, "repayStep");
assert.match(repayBlock, /debtBeforeRepay/, "repay should record debtBeforeRepay");
assert.match(repayBlock, /debtAfterRepay/, "repay should record debtAfterRepay");
assert.match(repayBlock, /repayAmount/, "repay should record repayAmount");
assert.match(repayBlock, /repayTxHash/, "repay should record repayTxHash");
assert.doesNotMatch(repayBlock, /debtAfterLiquidation/, "repay must not write debtAfterLiquidation");
assert.doesNotMatch(repayBlock, /collateralAfterLiquidation/, "repay must not write collateralAfterLiquidation");
assert.doesNotMatch(repayBlock, /badDebtWrittenOff|reservesUsed|supplierLoss/, "repay must not write liquidation loss fields");

const withdrawBlock = functionBlock(lendingActions, "withdrawCollateralStep");
assert.match(withdrawBlock, /collateralBeforeWithdrawal/, "withdraw should record collateralBeforeWithdrawal");
assert.match(withdrawBlock, /collateralAfterWithdrawal/, "withdraw should record collateralAfterWithdrawal");
assert.match(withdrawBlock, /withdrawAmount/, "withdraw should record withdrawAmount");
assert.match(withdrawBlock, /withdrawTxHash/, "withdraw should record withdrawTxHash");
assert.doesNotMatch(withdrawBlock, /debtAfterLiquidation/, "withdraw must not write debtAfterLiquidation");
assert.doesNotMatch(withdrawBlock, /collateralAfterLiquidation/, "withdraw must not write collateralAfterLiquidation");
assert.doesNotMatch(withdrawBlock, /badDebtWrittenOff|reservesUsed|supplierLoss/, "withdraw must not write liquidation loss fields");

const timeoutRefundBlock = functionBlock(timeoutActions, "executeTimeoutRefundStep");
assert.match(timeoutRefundBlock, /executeTimeoutRefundAction/, "timeout refund action should use the shared on-chain timeout helper");
assert.match(timeoutRefundBlock, /timeout-refunded/, "timeout refund action should record the timeout-refunded phase");
assert.match(timeoutActions, /export async function executeTimeoutRefundAction/, "timeout execution should live in a reusable helper");

const demoHtml = await readFile(resolve(process.cwd(), "demo", "index.html"), "utf8");
const proofInspectorHeadings = demoHtml.match(/<h2>Proof inspector<\/h2>/g) || [];
assert.equal(proofInspectorHeadings.length, 1, "Proof inspector heading should appear exactly once");
assert.match(demoHtml, /data-workflow-step="return"/, "borrower workflow should expose an explicit return/settle step");
assert.match(demoHtml, /data-workflow-panel="return redeem"/, "redeem panel should be reachable from the return/settle step");
assert.match(demoHtml, /data-action="executeTimeoutRefund"/, "UI should expose the real timeout refund action");
assert.doesNotMatch(demoHtml, /data-action="verifyTimeoutAbsence"/, "UI should not expose the legacy timeout marker");
assert.doesNotMatch(demoHtml, /Show Timeout/, "UI timeout CTA should execute the refund instead of showing an explanation-only model");

const returnReadyBranch = demoApp.indexOf(
  "if (lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher)"
);
const forwardPendingBranch = demoApp.indexOf("if (forwardPending)");
const voucherBranch = demoApp.indexOf("if (lifecycle.freeVoucher && !lifecycle.activeCollateral && !lifecycle.activeDebt)");
assert.ok(returnReadyBranch !== -1, "workflow model should detect withdrawn collateral ready to return");
assert.ok(voucherBranch !== -1, "workflow model should retain initial voucher activation step");
assert.ok(
  returnReadyBranch < forwardPendingBranch,
  "workflow model should prioritize return after withdraw before any bridge continuation"
);
assert.match(
  demoApp,
  /if \(forwardPending\)/,
  "bridge-in-progress should be driven only by a pending forward packet"
);
assert.match(
  demoApp,
  /const returning = lifecycle\.borrowerCollateralWithdrawn \|\| lifecycle\.debtWasOpened;/,
  "activate should only handle newly bridged vouchers, not withdrawn closeout collateral"
);
assert.match(demoApp, /function forwardReceiptConsumed\(status\)/, "UI should use current receipt state for forward packet completion");
assert.match(demoApp, /return !forwardReceiptConsumed\(status\)/, "forward pending state should not trust old visible voucher balances");
assert.match(demoApp, /return !reverseConsumed\(status\) && !settlement\.unlocked/, "reverse pending state should not trust stale trace receive tx hashes");
assert.match(
  demoApp,
  /heightAtLeast\(forward\.finalizedHeight, forward\.commitHeight\)/,
  "forward header controls should compare header state against the current packet height"
);
assert.match(forwardBridgeActions, /receiveTxHash: null/, "new forward packets should clear stale receive proof trace fields");
assert.match(reverseBridgeActions, /liquidatorSettlement: null/, "borrower reverse burns should clear stale liquidation settlement trace");
assert.match(
  reverseBridgeActions,
  /packetReceipts\(trace\.reverse\.packetId\)/,
  "reverse burn should check live receipt state before allowing another reverse packet"
);
assert.match(
  reverseBridgeActions,
  /reverse-header-partial/,
  "reverse client update should persist partial light-client progress instead of failing the UI"
);
assert.match(
  forwardBridgeActions,
  /forward-header-partial/,
  "forward client update should persist partial light-client progress instead of failing the UI"
);
assert.match(
  forwardBridgeActions,
  /Bank B already trusts Bank A header/,
  "forward client update should recover when heartbeat already advanced the trusted header"
);
assert.match(
  reverseBridgeActions,
  /Bank A already trusts Bank B header/,
  "reverse client update should recover when heartbeat already advanced the trusted header"
);
assert.match(demoApp, /settlementMatchesReverse/, "UI should ignore stale settlement traces from a previous reverse packet");
assert.match(besuGenerator, /bonsai-historical-block-limit=\$\{BONSAI_HISTORICAL_BLOCK_LIMIT\}/, "generated Besu config should retain local demo historical Bonsai state");
assert.match(
  besuGenerator,
  /bonsai-trie-logs-pruning-window-size=\$\{BONSAI_TRIE_LOGS_PRUNING_WINDOW_SIZE\}/,
  "generated Besu config should keep Bonsai trie logs pruning window above the historical block limit"
);
assert.match(seedDemo, /writeTrace\(trace\)/, "manual seed should reset stale UI trace to the seeded baseline");
assert.match(demoReadModel, /Resume Session cannot recover deleted chain state/, "stale chain guidance should explain that volume resets require redeploy and seed");
assert.match(forwardBridgeActions, /refreshFreshProofAnchor/, "forward receive should retry stale packet-height proofs at a fresh trusted height");
assert.match(
  forwardBridgeActions,
  /Use Resume Session to refresh the proof anchor/,
  "forward receive stale-proof guidance should direct users to Resume Session"
);
assert.match(
  forwardBridgeActions,
  /writeForwardReceiveTrace/,
  "forward receive should persist a minted voucher even when the acknowledgement proof is deferred"
);
assert.match(
  forwardBridgeActions,
  /Bank A acknowledgement proof was deferred/,
  "forward receive should explain deferred acknowledgement proof recovery"
);
assert.match(demoApi, /\/api\/resume-session/, "API should expose Resume Session");
assert.match(demoService, /resumeSessionPayload/, "service should implement Resume Session");
assert.match(demoService, /RESUME_SESSION_MAX_HEADERS/, "Resume Session should bound light-client catch-up per click");
assert.match(demoService, /Resume Session partially refreshed proof anchors/, "Resume Session should report bounded partial proof-anchor refreshes");
assert.match(demoService, /recoverOpenRouteCompletion/, "Establish Bank Route should recover the UI trace if the on-chain route opened before a final read error");
assert.match(demoService, /startLightClientHeartbeat\(\)/, "demo service should start the optional light-client heartbeat");
assert.match(demoService, /LIGHT_CLIENT_HEARTBEAT_MAX_HEADERS = BigInt\(process\.env\.DEMO_LIGHT_CLIENT_HEARTBEAT_MAX_HEADERS \|\| "24"\)/, "heartbeat should import enough headers per tick to outrun the local 2s block period");
assert.match(demoService, /allowLargeGap: true/, "heartbeat should keep catching up in bounded batches even after a large presentation-time gap");
assert.match(demoService, /setTimeout\(\(\) => \{[\s\S]*lightClientHeartbeatTick\(\)/, "heartbeat should run an initial tick soon after the demo service starts");
assert.match(
  demoService,
  /function actionCanRunDuringHeartbeat\(action\)/,
  "read-only header fetch actions should not fail while the heartbeat is refreshing proof anchors"
);
assert.match(
  demoService,
  /action === "finalizeForwardHeader"/,
  "forward header fetch should be allowed during the light-client heartbeat"
);
assert.match(demoService, /probeOnChainDeploymentHealth\(config, STATUS_READ_TIMEOUT_MS\)/, "heartbeat should verify cached deployment code before touching light clients");
assert.match(demoService, /HEARTBEAT_IDLE_TIMEOUT_MS/, "actions should wait for long heartbeat refreshes instead of failing after a short fixed delay");
assert.match(demoService, /Waiting for light-client heartbeat/, "UI-visible controller stage should explain when an action is waiting for heartbeat refresh");
assert.doesNotMatch(
  demoService,
  /Retry the action in a few seconds/,
  "heartbeat contention should not be surfaced as an immediate user retry failure"
);
assert.match(demoApp, /function actionReachedExpectedState\(action, status = currentStatus, before = null\)/, "UI should verify visible protocol state before resolving a stale controller");
assert.match(demoApp, /recoverCompletedActionFromStatus/, "UI should recover completed long-running actions from refreshed status");
assert.match(demoApp, /STRICT_VISIBLE_COMPLETION_ACTIONS/, "UI should keep financial actions open until the dashboard state actually changes");
assert.match(demoApp, /"resetSeeded"/, "Fresh Reset should be tracked as a strict visible-completion action");
assert.match(demoApp, /currentRunningAction\.uiNextAction = currentWorkflowAction/, "post-action CTAs should record the UI state-machine recommendation");
assert.match(demoApp, /if \(serverFallback && serverEligibility\.ok\)/, "post-action CTAs should prefer the server recommendation computed from the refreshed status");
assert.match(demoApp, /sameCtaIntent\(serverFallback, uiFallback\)/, "post-action CTAs should only merge labels when server and UI select the same action");
assert.match(demoApp, /avoidRepeatingCompletedAction/, "post-action CTAs should not recommend a completed visible action again when only the UI fallback is available");
assert.match(demoApp, /async function runActionButton\(button\)/, "direct action buttons should refresh state before submitting");
assert.match(demoApp, /clearPrimaryGuide\(\)[\s\S]*await refreshStatus\(\)[\s\S]*await runAction\(action, \{ button, workflowRequestLog \}\)/, "direct action buttons should clear stale success cards and run the exact requested action");
assert.match(demoApp, /syncControllerOperationFromStatus/, "UI refresh should attach Linky to controller actions already running on the server");
assert.match(demoApp, /controller\?\.activeOperation/, "UI should read active controller operations from status payloads");
assert.match(demoApp, /function activeControllerOperation\(status = currentStatus\)/, "UI should centralize active controller detection");
assert.match(demoApp, /if \(controllerStillRunning\(status\)\) return false;/, "UI must not mark a visible state change complete while the same controller action is still running");
assert.match(demoApp, /awaitingActionResponse[\s\S]*actionResponseMustSettle\(action\)/, "UI polling must not complete strict actions before their action request returns");
assert.match(demoApp, /controllerBusyMessage\(activeOperation, actionToRun\)/, "primary CTA clicks should block while any controller action is still active");
assert.match(demoApp, /Direct action blocked after refresh:[\s\S]*Active controller action/, "direct action buttons should not submit while the controller is still active");
assert.match(demoService, /phase: phaseMatchesAction \? phase : null/, "controller status should not expose stale phases from previous actions");
assert.match(demoService, /function statusWithIdleController\(status\)/, "completed action responses should not return their own controller operation as still active");
assert.match(demoService, /status: responseStatus,[\s\S]*nextAction: nextActionPayload\(responseStatus\)/, "action responses should compute next actions from the idle final status");
assert.match(demoService, /function finalActionStatusReady\(action, status\)[\s\S]*nextValidActionFromStatus\(status\)\.action !== "depositCollateral"/, "deposit responses should wait until the final recommendation advances beyond deposit");
assert.match(demoApp, /Run \$\{nextCta\.label\}/, "success CTA copy should make clear that the button runs the next action");
assert.match(demoApp, /it does not repeat the completed one/, "success guidance should distinguish next-action execution from the completed action");
assert.match(demoApp, /function defaultAmountForAction\(action, status = currentStatus\)/, "primary recommendations should know safe default amounts for amount-based actions");
assert.match(demoApp, /input\.dataset\.dirty === "true" \|\| numeric\(input\.value\) > POSITION_EPSILON/, "recommended amount priming should preserve manually edited amount fields");
assert.match(demoApp, /nextCta\?\.type === "action"[\s\S]*primeRecommendedAmount\(nextCta\.action, currentStatus\)/, "success recommendations should prime amount fields before enabling the next CTA without forcing over manual edits");
assert.match(demoApp, /button === primaryWorkflowCta[\s\S]*primeRecommendedAmount\(action, currentStatus\)/, "primary recommendation clicks should use the current recommended amount only when the user has not edited the field");
assert.match(demoApp, /refreshStatus\(\)[\s\S]*const actionToRun = cta\.action[\s\S]*primeRecommendedAmount\(actionToRun, currentStatus\)[\s\S]*await runAction\(actionToRun, \{ button, workflowRequestLog \}\)/, "primary recommendation clicks should refresh state and run only the requested CTA action while preserving user-entered amounts");
assert.doesNotMatch(demoApp, /if \(!requestedEligibility\.ok && currentWorkflowAction\?\.type === "action"\)/, "primary recommendation clicks must not silently fall back to a different current action");
assert.match(demoApp, /No alternate action was submitted automatically/, "ineligible refreshed CTAs should explain that no alternate action was submitted");
assert.match(demoApp, /Requested CTA action/, "controller debug output should record the requested CTA action");
assert.match(demoApp, /Action actually submitted/, "controller debug output should record the action actually submitted");
assert.match(demoApp, /function bindPrimaryWorkflowCta\(cta\)/, "primary CTA should bind the exact action displayed on the button");
assert.match(demoApp, /const boundCta = primaryWorkflowCtaBinding\(\)/, "primary CTA clicks should execute the displayed bound action");
assert.match(demoApp, /Server nextAction/, "controller debug output should record the server next action");
assert.match(demoApp, /function freshSeededBaseline\(status = currentStatus\)/, "Fresh Reset completion should require a clean seeded baseline, not merely an old deployed state");
assert.match(demoApp, /action === "resetSeeded" && currentRunningAction\.controller/, "Fresh Reset should not complete while the reset controller is still active");
assert.match(demoApp, /movedUp\(state\.collateral, before\.collateral\) \|\| movedDown\(state\.voucher, before\.voucher\)/, "deposit completion should require before/after balance movement");
assert.match(demoApp, /function updateAmountActionAvailability\(status\)[\s\S]*const busy = document\.body\.classList\.contains\("is-busy"\)[\s\S]*button\.disabled = busy \|\| !safetyAllowed \|\| !validation\.ok/, "amount action buttons must stay disabled while a strict action is still processing");
assert.match(demoApp, /movedDown\(state\.collateral, before\.collateral\) \|\| movedUp\(state\.voucher, before\.voucher\)/, "withdraw completion should require before/after balance movement");
assert.match(demoApp, /traceRisk\.withdrawTxHash \|\| traceRisk\.collateralWithdrawn \|\| lifecycle\.borrowerCollateralWithdrawn/, "withdraw completion should not poll forever after the withdraw trace is recorded");
assert.match(demoService, /if \(lifecycle\.activeDebt\)[\s\S]*repayRequiredShortfallFromStatus\(status\)[\s\S]*topUpRepayCash[\s\S]*repay/, "service recommendations should route active debt through repayment in the main borrower flow");
assert.match(liquidationActions, /priceShockTxHash[\s\S]*liquidationTxHash: null/, "price shock should clear stale liquidation trace so appendix risk evidence is not falsely marked complete");
assert.match(demoService, /return \{ action: "withdrawCollateral", label: "Withdraw Collateral" \}/, "service recommendations should direct debt-closed positions toward collateral withdrawal");
assert.match(demoApp, /function forwardReceiptConsumed\(status\)/, "UI should distinguish the latest packet receipt from older visible voucher balances");
assert.match(demoApp, /function forwardPacketPending\(status\)[\s\S]*return !forwardReceiptConsumed\(status\)/, "UI should re-enable Receive Verified Collateral after a new lock even when old voucher remains visible");
assert.match(demoApp, /!forwardPending &&[\s\S]*state\.voucher > POSITION_EPSILON/, "UI should only treat visible voucher as delivered when no newer packet is pending");
assert.match(demoService, /const forwardDelivered =[\s\S]*forward\.receiveTxHash/, "service recommendations should use the latest forward receipt, not old voucher balances, for packet delivery");
assert.match(demoService, /readDemoStatusAfterVisibleChange/, "action responses should wait for visible state changes before returning next recommendations");
assert.match(demoService, /case "depositCollateral":[\s\S]*movedUp\(balances\.poolCollateral/, "deposit should complete from real collateral/voucher movement");
assert.match(demoService, /case "depositCollateral":[\s\S]*if \(before\)[\s\S]*movedUp\(balances\.poolCollateral, beforeBalances\.poolCollateral\)[\s\S]*return statusPositive\(balances\.poolCollateral\) \|\| Boolean\(traceRisk\.collateralDeposited\)/, "service deposit completion must ignore stale collateralDeposited trace when a before snapshot exists");
assert.match(demoService, /case "withdrawCollateral":[\s\S]*traceRisk\.withdrawTxHash/, "withdraw action responses should stop waiting once the withdraw transaction trace is recorded");
assert.match(demoApp, /function reverseConsumed\(status\)[\s\S]*trace\?\.liquidatorSettlement\?\.unlockTxHash/, "UI should treat reverse unlock trace/settlement state as consumed even if receipt reads lag");
assert.match(demoService, /const reverseDelivered =/, "service recommendations should treat visible reverse settlement/unlock state as reverse delivery");
assert.match(demoApp, /case "executeLiquidation":[\s\S]*afterLiquidation\?\.executed/, "UI should recover completed liquidation from visible accounting state");
assert.match(demoApp, /final status refresh timed out/, "generic action failures caused by transient status reads should stay open for recovery polling");
assert.match(demoService, /nextAction: nextActionPayload\(status\)/, "action API responses should include the server-selected next recommendation");
assert.match(demoApp, /workflowCtaFromServerNext/, "UI should convert server nextAction responses into primary workflow CTAs");
assert.match(demoApp, /next recommendation is/, "successful action cards should point the primary CTA at the next action instead of a generic continue step");
assert.match(demoApp, /1\/3 Fetch Bank A header/, "forward proof workflow should label the header fetch sub-step");
assert.match(demoApp, /2\/3 Import Bank A header on Bank B/, "forward proof workflow should label the client import sub-step");
assert.match(demoApp, /Receive Verified Collateral/, "forward proof workflow should label the proof verification sub-step");
assert.match(demoApp, /1\/3 Fetch Bank B header/, "reverse proof workflow should label the header fetch sub-step");
assert.match(demoApp, /2\/3 Import Bank B header on Bank A/, "reverse proof workflow should label the client import sub-step");
assert.match(demoApp, /3\/3 Verify proof and unlock aBANK/, "reverse proof workflow should label the proof verification sub-step");
assert.match(demoService, /forwardProofActionFromStatus/, "server recommendations should choose explicit forward proof sub-steps");
assert.match(demoService, /forwardProofStepLabel\(action\)/, "server recommendations should expose forward proof sub-step labels");
assert.match(demoService, /reverseProofActionFromStatus/, "server recommendations should choose explicit reverse proof sub-steps");
assert.match(demoService, /reverseProofStepLabel\(action\)/, "server recommendations should expose reverse proof sub-step labels");
assert.match(demoStaticServer, /cache-control": "no-store"/, "demo static assets should not be browser-cached across live UI fixes");
assert.doesNotMatch(demoHtml, /Action duration/, "Linky recommendation cards should avoid exposing raw elapsed-time implementation detail");
assert.match(demoApp, /function isTransientStatusRead\(status\)/, "UI should distinguish transient status read timeouts from action failures");
assert.match(demoApp, /statusWithPreservedVisibleState/, "UI should keep the last visible state during transient status read timeouts");
assert.doesNotMatch(demoApp, /elapsed > 10/, "UI must not fail or resolve long-running actions based only on elapsed time");
assert.match(demoApp, /attachBusyController/, "UI should attach to an already-running controller operation instead of showing a duplicate-submit failure");
assert.match(demoApp, /If the chain was reset with besu:down -v/, "UI Resume recovery copy should distinguish deleted chain state from proof-anchor refresh");
assert.match(demoService, /const timedOut = .*timed out/i, "status read fallback should detect true timeouts explicitly");
assert.match(demoService, /statusReadTimedOut: timedOut/, "status read timeout flag should not be set for every read failure");
assert.match(demoService, /statusReadFailed/, "non-timeout status read failures should not be mislabeled as timeouts");
assert.match(demoService, /readContractCodeWithRetry/, "demo service deployment health should retry transient Besu null-code reads");
assert.match(demoReadModel, /readContractCodeWithRetry/, "demo read model should retry transient Besu null-code reads before reporting world-state loss");
assert.doesNotMatch(
  demoService,
  /deployed: false,[\s\S]*label: "Status read timeout"/,
  "a transient status read timeout should not masquerade as a missing deployment"
);
assert.match(demoReadModel, /Besu world state unavailable/, "read model should report null contract code as Besu world-state corruption");
assert.match(demoReadModel, /code == null/, "read model should not pass null code responses into ethers rendering");
assert.match(besuRuntime, /eth_getCode/, "Besu readiness should verify world-state-backed RPC calls, not only chain id");
assert.match(preflightBesu, /eth_getCode/, "Besu preflight should catch validators that return null code because world state is unavailable");
assert.match(preflightBesu, /worldStateUnavailable/, "Besu preflight should tell the user when local Besu volumes need resetting");
assert.match(packageJson, /clean-besu-data\.mjs/, "besu:down should clear bind-mounted Besu node data, not only Docker volumes");
assert.match(besuClean, /nodesRoot/, "Besu clean script should remove per-node bind-mounted data directories");
assert.match(demoHtml, /id="resumeSession"/, "UI should expose a Resume Session control");
assert.doesNotMatch(
  demoApp,
  /wait for a fresh block and retry the receive-voucher action/i,
  "UI recovery text should not ask users to blindly retry stale historical proof state"
);

assert.match(borrowerScenario, /runBorrowerCloseoutScenario/, "demo modules should include a borrower closeout lifecycle");
assert.match(demoRunner, /--scenario/, "demo runner should support explicit scenario selection");

const traceShock = resolveShockPreviewPriceE18({
  traceRisk: { shockedVoucherPriceE18: e18("0.3").toString() },
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.5",
});
assert.equal(traceShock, e18("0.3"), "trace risk shock price must override parent process default");

const liveOracleShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("0.3"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.5",
});
assert.equal(liveOracleShock, e18("0.3"), "shocked oracle price must be used when trace is missing");

const envShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
  envShockPrice: "0.4",
});
assert.equal(envShock, e18("0.4"), "env shock price should be used before default fallback");

const defaultShock = resolveShockPreviewPriceE18({
  traceRisk: {},
  currentCollateralPrice: e18("2"),
  initialCollateralPrice: e18("2").toString(),
});
assert.equal(defaultShock, e18("0.5"), "default shock price should remain 0.5");

const customShockHealth = healthFactorFor({
  collateral: e18("100"),
  debt: e18("80"),
  collateralPrice: e18("0.3"),
  debtPrice: e18("1"),
  haircutBps: 9_000n,
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
});
assert.equal(customShockHealth.toString(), "2700", "custom 0.3 shock health preview should be 27%");

const separatedRiskHealth = healthFactorFor({
  collateral: e18("100"),
  debt: e18("70"),
  collateralPrice: e18("1"),
  debtPrice: e18("1"),
  haircutBps: 10_000n,
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
});
assert.equal(separatedRiskHealth.toString(), "11428", "health factor should use liquidation threshold, not borrow factor");

const beforeLiquidation = afterLiquidationState({
  traceRisk: {},
  liveDebt: e18("80"),
  liveCollateral: e18("100"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidation.executed, false, "after-liquidation state should be hidden before tx hash");
assert.equal(beforeLiquidation.debt, null, "debt after liquidation should not show before liquidation");

const beforeLiquidationAfterRepay = afterLiquidationState({
  traceRisk: { debtAfterRepay: "40.0" },
  liveDebt: e18("40"),
  liveCollateral: e18("100"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidationAfterRepay.executed, false, "repay trace should not reveal after-liquidation state");
assert.equal(beforeLiquidationAfterRepay.debt, null, "repay trace should not populate after-liquidation debt");

const beforeLiquidationWithSnapshotFields = afterLiquidationState({
  traceRisk: {
    debtAfterLiquidation: "40.0",
    collateralAfterLiquidation: "16.0",
  },
  liveDebt: e18("40"),
  liveCollateral: e18("16"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(beforeLiquidationWithSnapshotFields.executed, false, "after-liquidation state should require liquidation evidence");
assert.equal(beforeLiquidationWithSnapshotFields.debt, null, "snapshot fields alone should stay hidden before liquidation evidence");

const repayOnlyTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    debtAfterRepay: "40.0",
  },
});
assert.equal(repayOnlyTrace.lending.liquidated, false, "debtAfterRepay alone must not mark lending as liquidated");
assert.equal(repayOnlyTrace.lending.debt, "40.0", "normalized lending debt should use repay-specific debt");

const staleLiquidationFieldTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    debtAfterLiquidation: "40.0",
  },
});
assert.equal(
  staleLiquidationFieldTrace.lending.liquidated,
  false,
  "debtAfterLiquidation alone must not mark lending as liquidated"
);

const liquidatedTrace = normalizeTraceForUi({
  risk: {
    borrowed: "80.0",
    liquidationTxHash: "0xabc",
    debtAfterLiquidation: "40.0",
  },
});
assert.equal(liquidatedTrace.lending.liquidated, true, "liquidation tx hash should mark lending as liquidated");

const reverseSettlementTrace = normalizeTraceForUi({
  reverse: {
    packetId: "0xsettlement",
    proofMode: "storage",
  },
  denied: {
    packetId: "0xdenied",
  },
});
assert.equal(reverseSettlementTrace.reverse.packetId, "0xsettlement", "reverse settlement packet should not be overwritten by denied timeout packet");
assert.equal(reverseSettlementTrace.reverse.proofMode, "storage", "reverse settlement proof mode should be preserved");

const timeoutOnlyTrace = normalizeTraceForUi({
  denied: {
    packetId: "0xdenied",
  },
  timeout: {
    trustedHeight: "123",
    receiptStorageKey: "0xtimeoutslot",
  },
  security: {
    timeoutAbsence: {
      receiptSlot: "0xtimeoutslot",
    },
  },
});
assert.equal(timeoutOnlyTrace.reverse.packetId, undefined, "timeout denied packets must not appear as reverse unlock packets");
assert.equal(timeoutOnlyTrace.reverse.proofMode, undefined, "timeout absence proofs must not mark the reverse proof path as pending");
assert.equal(timeoutOnlyTrace.security.timeoutAbsence.receiptSlot, "0xtimeoutslot", "timeout evidence should remain available through the timeout/security model");

const receiptOnlyTrace = normalizeTraceForUi({
  forward: {
    receiveTxHash: "0xreceive",
  },
});
assert.equal(receiptOnlyTrace.security.receiptReplayGuardLive, true, "receipt-only trace should expose live replay guard");
assert.equal(
  receiptOnlyTrace.security.explicitReplayAttackRejected,
  false,
  "receipt-only trace must not claim an explicit replay attack was rejected"
);

const explicitReplayTrace = normalizeTraceForUi({
  security: {
    replayBlocked: true,
  },
});
assert.equal(
  explicitReplayTrace.security.explicitReplayAttackRejected,
  true,
  "legacy replayBlocked trace should map to explicit replay rejection"
);

const afterLiquidation = afterLiquidationState({
  traceRisk: {
    liquidationTxHash: "0xabc",
    debtBeforeLiquidation: "80.0",
    collateralBeforeLiquidation: "100.0",
    debtAfterLiquidation: "40.0",
    collateralAfterLiquidation: "16.0",
    badDebtWrittenOff: "0.0",
    reservesUsed: "0.0",
    supplierLoss: "0.0",
  },
  liveDebt: e18("40"),
  liveCollateral: e18("16"),
  liveReserves: 0n,
  liveBadDebt: 0n,
});
assert.equal(afterLiquidation.executed, true, "after-liquidation state should appear after tx hash exists");
assert.equal(afterLiquidation.debt, "40.0");
assert.equal(afterLiquidation.collateral, "16.0");

const policy = riskPolicySnapshot({
  collateralFactorBps: 7_000n,
  liquidationThresholdBps: 8_000n,
  collateralHaircutBps: 9_000n,
  liquidationCloseFactorBps: 5_000n,
  liquidationBonusBps: 500n,
});
assert.equal(policy.collateralFactorBps, "7000", "collateral factor should stay exposed as max LTV");
assert.equal(policy.liquidationThresholdBps, "8000", "liquidation threshold should be exposed separately");
assert.equal(policy.liquidationHealthFactorTriggerBps, "10000", "liquidation trigger should be HF < 100%");

console.log("demo read-model checks passed");
