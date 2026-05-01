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
const besuGenerator = await readFile(resolve(process.cwd(), "scripts", "generate-besu-qbft-networks.mjs"), "utf8");
const seedDemo = await readFile(resolve(process.cwd(), "scripts", "seed-lending-demo.mjs"), "utf8");
const demoReadModel = await readFile(resolve(process.cwd(), "scripts", "demo-read-model.mjs"), "utf8");
const demoService = await readFile(resolve(process.cwd(), "scripts", "demo-service.mjs"), "utf8");
const demoApi = await readFile(resolve(process.cwd(), "scripts", "demo-api.mjs"), "utf8");
const lendingActions = await readFile(resolve(process.cwd(), "scripts", "demo", "actions", "lending-actions.mjs"), "utf8");
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
  "if (lifecycle.borrowerCollateralWithdrawn && lifecycle.freeVoucher && !lifecycle.borrowerReverseStarted)"
);
const activateBranch = demoApp.indexOf("if (voucherReady && !collateralActive && !debtActive &&");
assert.ok(returnReadyBranch !== -1, "workflow model should detect withdrawn collateral ready to return");
assert.ok(activateBranch !== -1, "workflow model should retain initial voucher activation step");
assert.ok(
  returnReadyBranch < activateBranch,
  "workflow model should prioritize return after withdraw before treating free voucher as a new deposit"
);
assert.match(
  demoApp,
  /if \(bridgeStarted && !voucherReady && !collateralActive && !debtActive && !lifecycle\.returnStarted\)/,
  "bridge-in-progress should not mask the reverse return flow after burn"
);
assert.match(
  demoApp,
  /if \(voucherReady && !collateralActive && !debtActive && !lifecycle\.borrowerCollateralWithdrawn && !lifecycle\.debtWasOpened\)/,
  "activate should only handle newly bridged vouchers, not withdrawn closeout collateral"
);
assert.match(demoApp, /function forwardConsumed\(status\)/, "UI should use current receipt state for forward packet completion");
assert.match(demoApp, /return !forwardConsumed\(status\)/, "forward pending state should not trust stale trace receive tx hashes");
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
assert.match(demoService, /recoverOpenRouteCompletion/, "Open route should recover the UI trace if the on-chain route opened before a final read error");
assert.match(demoService, /startLightClientHeartbeat\(\)/, "demo service should start the optional light-client heartbeat");
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
assert.match(demoApp, /controller is no longer running this action/i, "UI should release stale processing state when the controller is no longer active");
assert.match(demoApp, /attachBusyController/, "UI should attach to an already-running controller operation instead of showing a duplicate-submit failure");
assert.match(demoApp, /If the chain was reset with besu:down -v/, "UI Resume recovery copy should distinguish deleted chain state from proof-anchor refresh");
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
