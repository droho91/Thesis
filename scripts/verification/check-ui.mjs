import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import {
  deriveInstitutionalWorkflow,
  parseActionAmount,
  summarizeRelayJournal,
} from "../ui/read-model.mjs";

const root = process.cwd();
const [packageJson, html, app, styles, service, runtime, readModel] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8"),
  readFile(resolve(root, "demo/index.html"), "utf8"),
  readFile(resolve(root, "demo/app.js"), "utf8"),
  readFile(resolve(root, "demo/styles.css"), "utf8"),
  readFile(resolve(root, "scripts/ui/service.mjs"), "utf8"),
  readFile(resolve(root, "services/institutional-demo-runtime.mjs"), "utf8"),
  readFile(resolve(root, "scripts/ui/read-model.mjs"), "utf8"),
]);

assert.equal(parseActionAmount("12.5"), ethers.parseEther("12.5"));
assert.throws(() => parseActionAmount("0"), /greater than zero/);
assert.throws(() => parseActionAmount("2", { maximum: ethers.parseEther("1") }), /exceeds/);

const relay = summarizeRelayJournal({
  jobs: {
    one: { messageId: "one", state: "completed", updatedAt: "2026-01-01T00:00:00.000Z" },
    two: { messageId: "two", state: "received", updatedAt: "2026-01-02T00:00:00.000Z" },
  },
}, 4);
assert.equal(relay.online, true);
assert.equal(relay.completedMessages, 1);
assert.equal(relay.pendingMessages, 1);
assert.equal(relay.latestJob.messageId, "two");

const baseStatus = {
  ready: true,
  controller: { activeOperation: null },
  balances: {
    canonicalAvailable: "100",
    voucherAvailable: "0",
    activeCollateral: "0",
    outstandingDebt: "0",
  },
  risk: { availableBorrowRaw: "0" },
  activity: { latest: null },
};
assert.deepEqual(deriveInstitutionalWorkflow(baseStatus), { stage: "transfer", nextAction: "bridge" });
assert.deepEqual(
  deriveInstitutionalWorkflow({
    ...baseStatus,
    balances: { ...baseStatus.balances, voucherAvailable: "25" },
  }),
  { stage: "lend", nextAction: "deposit" },
);
assert.deepEqual(
  deriveInstitutionalWorkflow({
    ...baseStatus,
    balances: { ...baseStatus.balances, activeCollateral: "25", outstandingDebt: "10" },
  }),
  { stage: "manage", nextAction: "repay" },
);

const parsedPackage = JSON.parse(packageJson);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:deploy/);
assert.match(parsedPackage.scripts["demo:prepare"], /institutional:governance/);
assert.equal(parsedPackage.scripts["demo:ui"], "node scripts/ui/serve.mjs");
assert.equal(parsedPackage.scripts.deploy, undefined);
assert.equal(parsedPackage.scripts.seed, undefined);

for (const action of ["bridge", "deposit", "borrow", "repay", "repayAll", "withdraw", "return"]) {
  assert.match(app, new RegExp(`\\b${action}\\b`), `UI controller should expose ${action}`);
  assert.match(runtime, new RegExp(`\\b${action}\\b`), `runtime should execute ${action}`);
}
assert.match(html, /Institutional Cross-chain Operations/);
assert.match(html, /data-panel="evidence"/);
assert.match(html, /3-of-4 attested/);
assert.doesNotMatch(html, /finalizeForwardHeader|updateForwardClient|proveForwardMint|openRoute/);
assert.doesNotMatch(app, /deploy-seed|reset-seeded|resume-session/);
assert.doesNotMatch(app, /settleDust/);
assert.doesNotMatch(runtime, /settleDust/);
assert.doesNotMatch(styles, /@media/);
assert.match(styles, /min-width:\s*1280px/);
assert.match(service, /InstitutionalDemoRuntime/);
assert.match(runtime, /InstitutionalRelayEngine/);
assert.match(runtime, /CheckpointAttestor/);
assert.match(runtime, /lockAndMint/);
assert.match(runtime, /burnAndUnlock/);
assert.match(runtime, /InstitutionalActionJournal/);
assert.match(runtime, /getTransactionReceipt/);
assert.match(runtime, /reconciling-relay/);
assert.match(runtime, /messageTimedOut/);
assert.match(app, /requestId/);
assert.match(app, /sessionStorage/);
assert.match(readModel, /timelock-enforced|governanceMode/);

console.log("Institutional UI/read-model checks passed.");
