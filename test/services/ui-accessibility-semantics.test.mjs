import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { nextTabIndex } from "../../demo/tab-keyboard.js";

const root = process.cwd();

test("workflow and lending tabs expose complete roving-tab semantics", async () => {
  const html = await readFile(resolve(root, "demo/index.html"), "utf8");
  assert.match(html, /class="journey"[^>]*role="tablist"[^>]*aria-orientation="vertical"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 10);
  for (const [tabId, panelId] of [
    ["workflowTabIdentity", "workspacePanelIdentity"],
    ["workflowTabTransfer", "workspacePanelTransfer"],
    ["workflowTabLending", "workspacePanelLending"],
    ["workflowTabPosition", "workspacePanelLending"],
    ["workflowTabReturn", "workspacePanelReturn"],
    ["workflowTabEvidence", "workspacePanelEvidence"],
  ]) {
    assert.match(html, new RegExp(`id="${tabId}"[^>]*role="tab"[^>]*aria-selected="(?:true|false)"[^>]*aria-controls="${panelId}"[^>]*tabindex="(?:0|-1)"`));
  }
  for (const panelId of [
    "workspacePanelIdentity",
    "workspacePanelTransfer",
    "workspacePanelLending",
    "workspacePanelReturn",
    "workspacePanelEvidence",
  ]) {
    assert.match(html, new RegExp(`id="${panelId}"[^>]*role="tabpanel"[^>]*aria-labelledby="workflowTab`));
  }
  for (const mode of ["Deposit", "Borrow", "Repay", "Withdraw"]) {
    assert.match(html, new RegExp(`id="lendingMode${mode}Tab"[^>]*role="tab"[^>]*aria-selected="(?:true|false)"[^>]*aria-controls="lendingOperationPanel"[^>]*tabindex="(?:0|-1)"`));
  }
  assert.match(html, /id="lendingOperationPanel" role="tabpanel" aria-labelledby="lendingModeDepositTab"/);
});

test("tab keyboard state wraps and supports Home and End", () => {
  assert.equal(nextTabIndex("ArrowRight", 3, 4), 0);
  assert.equal(nextTabIndex("ArrowDown", 1, 4), 2);
  assert.equal(nextTabIndex("ArrowLeft", 0, 4), 3);
  assert.equal(nextTabIndex("ArrowUp", 2, 4), 1);
  assert.equal(nextTabIndex("Home", 3, 4), 0);
  assert.equal(nextTabIndex("End", 0, 4), 3);
  assert.equal(nextTabIndex("Enter", 1, 4), null);
  assert.throws(() => nextTabIndex("Home", 0, 0), /positive safe integer/);
  assert.throws(() => nextTabIndex("End", 4, 4), /identify an item/);
});

test("disclosures, form feedback and disabled controls use semantic DOM state", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(root, "demo/index.html"), "utf8"),
    readFile(resolve(root, "demo/app.js"), "utf8"),
  ]);
  assert.match(html, /id="runtimeStatus"[^>]*aria-expanded="false"[^>]*aria-controls="runtimePopover"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /id="runtimePopover" role="dialog"[^>]*tabindex="-1" hidden inert/);
  assert.equal((html.match(/class="status-detail"[^>]*role="region"[^>]*hidden inert/g) || []).length, 4);
  assert.equal((html.match(/class="form-message"[^>]*role="status"[^>]*aria-live="polite"/g) || []).length, 3);
  assert.equal((html.match(/aria-errormessage="(?:bridge|lending|return)Message" aria-invalid="false"/g) || []).length, 3);
  assert.match(html, /id="toastRegion" role="region"[^>]*aria-live="polite"/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /nextTabIndex\(event\.key, currentIndex, tabs\.length\)/);
  assert.match(app, /toggleAttribute\("inert", !active\)/);
  assert.match(app, /function setSemanticDisabled\(control, disabled\)/);
  assert.match(app, /control\.disabled = Boolean\(disabled\)/);
  assert.match(app, /setAttribute\("aria-disabled", String\(Boolean\(disabled\)\)\)/);
});

test("overview metrics use valid list and definition-list structure", async () => {
  const html = await readFile(resolve(root, "demo/index.html"), "utf8");
  assert.match(html, /class="overview-metrics" role="list" aria-label="Institutional position metrics"/);
  assert.equal((html.match(/class="metric-card [^"]+" role="listitem"/g) || []).length, 4);
  assert.equal((html.match(/<dl class="metric-definition">/g) || []).length, 4);
  assert.doesNotMatch(html, /<dl class="overview-metrics"/);
});

test("evidence definition groups keep supplementary notes inside definitions", async () => {
  const html = await readFile(resolve(root, "demo/index.html"), "utf8");
  assert.equal((html.match(/<small class="definition-note"(?: id="[^"]+")?>/g) || []).length, 8);
  assert.doesNotMatch(html, /<\/dd>\s*<small\b/);
  for (const valueId of [
    "benchmarkSamples", "proofAckP95", "endToEndP95", "securityControlCount",
    "validatorEvidence", "quorumEvidence", "governanceEvidence", "relayEvidence",
  ]) {
    // Attribute order and presentational classes may evolve; the semantic contract is
    // that every primary value remains inside its owning definition (<dd>).
    assert.match(html, new RegExp(`<dd>[^<]*<span[^>]*id="${valueId}"[^>]*>`));
  }
});
