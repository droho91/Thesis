import AxeBuilder from "@axe-core/playwright";
import { expect, test as base } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { statusFixture } from "./fixture-data.mjs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const workspaceScreenshotStyle = fileURLToPath(new URL("./screenshot.css", import.meta.url));
const test = base.extend({
  browserIntegrity: [async ({ page }, use) => {
    const issues = [];
    const expectedIssues = [];
    page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") issues.push(`console.error: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      issues.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText || "unknown"})`);
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && !loopbackHosts.has(url.hostname)) {
        issues.push(`external request blocked: ${route.request().method()} ${url.href}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    await use({
      expectIssue(pattern) {
        expectedIssues.push(pattern);
      },
    });
    const unexpectedIssues = [...issues];
    const missingIssues = [];
    for (const pattern of expectedIssues) {
      const index = unexpectedIssues.findIndex((issue) => pattern.test(issue));
      if (index < 0) missingIssues.push(`expected issue was not observed: ${pattern}`);
      else unexpectedIssues.splice(index, 1);
    }
    const integrityFailures = [...unexpectedIssues, ...missingIssues];
    expect(integrityFailures, integrityFailures.join("\n")).toEqual([]);
  }, { auto: true }],
});

const workflowTabs = [
  "workflowTabIdentity",
  "workflowTabTransfer",
  "workflowTabLending",
  "workflowTabPosition",
  "workflowTabReturn",
  "workflowTabEvidence",
];

async function waitForInstitutionalSnapshot(page) {
  await page.goto("/");
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Lane ready");
  await expect(page.locator("#readinessTitle")).toHaveText("Readiness checks passed");
  await expect(page.locator("#evidenceStepStatus")).toHaveText("Current pass");
  await expect(page.locator("#evidenceVerdictTitle")).toHaveText("Evidence matches the current reviewed source");
  await page.evaluate(() => document.fonts?.ready);
  await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
}

async function expectNoAccessibilityViolations(page, context) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(result.violations, `${context}: ${JSON.stringify(result.violations, null, 2)}`).toEqual([]);
}

async function resetScreenshotScroll(page) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

async function waitForPanelEntry(page, tab) {
  const panelId = await tab.getAttribute("aria-controls");
  const panel = page.locator(`#${panelId}`);
  await expect(panel).toBeVisible();
  await panel.evaluate((node) => Promise.all(node.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished.catch(() => undefined))));
}

test.beforeEach(async ({ page }) => {
  await waitForInstitutionalSnapshot(page);
});

test("workflow supports roving keyboard navigation and disclosure controls", async ({ page }) => {
  const identityTab = page.locator("#workflowTabIdentity");
  await identityTab.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#workflowTabEvidence")).toBeFocused();
  await expect(page.locator("#workspacePanelEvidence")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(identityTab).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#workflowTabTransfer")).toBeFocused();
  await expect(page.locator("#workflowTabTransfer")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#workspacePanelTransfer")).toBeVisible();

  await page.keyboard.press("End");
  await expect(page.locator("#workflowTabEvidence")).toBeFocused();
  await expect(page.locator("#workspacePanelEvidence")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(identityTab).toBeFocused();
  await expect(page.locator("#workspacePanelIdentity")).toBeVisible();

  const runtimeButton = page.locator("#runtimeStatus");
  await runtimeButton.focus();
  await page.keyboard.press("Enter");
  await expect(runtimeButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#runtimePopover")).toBeVisible();
  await expect(page.locator("#runtimePopover")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(runtimeButton).toHaveAttribute("aria-expanded", "false");
  await expect(runtimeButton).toBeFocused();

  const credentialButton = page.locator("#identityAStatusToggle");
  await credentialButton.focus();
  await page.keyboard.press("Space");
  await expect(credentialButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#identityAStatusDetail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(credentialButton).toHaveAttribute("aria-expanded", "false");
  await expect(credentialButton).toBeFocused();

  const lendingWorkflowTab = page.locator("#workflowTabLending");
  await lendingWorkflowTab.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspacePanelLending")).toBeVisible();
  const depositTab = page.locator("#lendingModeDepositTab");
  await depositTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#lendingModeWithdrawTab")).toBeFocused();
  await expect(page.locator("#lendingModeWithdrawTab")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(depositTab).toBeFocused();
  await expect(depositTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.locator("#lendingModeWithdrawTab")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(depositTab).toBeFocused();
});

test("all workflow views pass axe checks and stay within the desktop canvas", async ({ page }) => {
  const overflows = [];
  for (const tabId of workflowTabs) {
    const tab = page.locator(`#${tabId}`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await waitForPanelEntry(page, tab);
    await expectNoAccessibilityViolations(page, tabId);
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    if (dimensions.documentWidth > dimensions.viewportWidth + 1) overflows.push({ tabId, ...dimensions });
  }
  expect(overflows, JSON.stringify(overflows, null, 2)).toEqual([]);
});

test("projector typography remains legible", async ({ page }) => {
  const undersized = [];
  for (const tabId of workflowTabs) {
    await page.locator(`#${tabId}`).click();
    const findings = await page.locator("body *").evaluateAll((nodes) => nodes
      .flatMap((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden") return [];
        const fontSize = Number.parseFloat(style.fontSize);
        const hasDirectText = [...node.childNodes].some((child) => (
          child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0
        ));
        const isControl = node.matches("button, input, label, select, textarea");
        if ((!hasDirectText || fontSize >= 12) && (!isControl || fontSize >= 13)) return [];
        return [{
          element: node.tagName.toLowerCase(),
          className: typeof node.className === "string" ? node.className : "",
          fontSize: style.fontSize,
          requiredFloor: isControl ? "13px control" : "12px text",
          text: node.textContent.trim().slice(0, 80),
        }];
      }));
    undersized.push(...findings.map((finding) => ({ tabId, ...finding })));
  }
  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
});

test("motion follows readiness state and reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const readyMotion = await page.evaluate(() => ({
    live: getComputedStyle(document.querySelector(".live-dot"), "::after").animationName,
    seal: getComputedStyle(document.querySelector(".readiness-seal")).animationName,
    status: getComputedStyle(document.querySelector("#identityAStatusToggle .status-signal"), "::after").animationName,
  }));
  expect(Object.values(readyMotion).every((animation) => animation !== "none")).toBe(true);

  const readinessCard = page.locator(".readiness-card").first();
  await readinessCard.hover();
  await expect.poll(() => readinessCard.evaluate((node) => getComputedStyle(node).transform)).not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() => ({
    live: getComputedStyle(document.querySelector(".live-dot"), "::after").animationName,
    seal: getComputedStyle(document.querySelector(".readiness-seal")).animationName,
    status: getComputedStyle(document.querySelector("#identityAStatusToggle .status-signal"), "::after").animationName,
  }));
  expect(reducedMotion).toEqual({ live: "none", seal: "none", status: "none" });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/status", async (route) => {
    const reviewStatus = {
      ...statusFixture,
      ready: false,
      laneReady: false,
      identitiesEligible: false,
      message: "Fixture readiness review is required.",
      participants: {
        ...statusFixture.participants,
        identity: {
          ...statusFixture.participants.identity,
          A: { active: false, label: "suspended" },
        },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewStatus),
    });
  });
  await page.locator("#refreshButton").click();
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Lane review");
  const reviewMotion = await page.evaluate(() => ({
    live: getComputedStyle(document.querySelector(".live-dot"), "::after").animationName,
    seal: getComputedStyle(document.querySelector(".readiness-seal")).animationName,
    sheen: getComputedStyle(document.querySelector("#readinessPill"), "::after").animationName,
    credential: getComputedStyle(document.querySelector("#identityAStatusToggle .status-signal"), "::after").animationName,
  }));
  expect(reviewMotion).toEqual({ live: "none", seal: "none", sheen: "none", credential: "none" });
});

test("ready status tones reset when the runtime snapshot becomes unavailable", async ({ page, browserIntegrity }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  browserIntegrity.expectIssue(/^console\.error: Failed to load resource: the server responded with a status of 503/);
  const statusButtons = [
    "identityAStatusToggle",
    "identityBStatusToggle",
    "governanceStatusToggle",
    "quorumStatusToggle",
  ];
  const statusFields = [
    "identityAStatus",
    "identityBStatus",
    "identityGovernance",
    "identityQuorum",
  ];

  for (const buttonId of statusButtons) {
    await expect(page.locator(`#${buttonId}`)).toHaveClass(/\bis-verified\b/);
  }

  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture status endpoint is offline." }),
    });
  });
  await page.locator("#refreshButton").click();
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Runtime unavailable");
  await expect(page.locator("#runtimeStatus")).toHaveClass(/\bis-error\b/);
  await expect(page.locator("#runtimeStatus")).not.toHaveClass(/\bis-ready\b/);
  await expect(page.locator("#readinessVerdict")).toHaveClass(/\bis-review\b/);
  await expect(page.locator("#readinessPill")).toHaveClass(/\bis-warning\b/);

  for (const fieldId of statusFields) {
    await expect(page.locator(`#${fieldId}`)).toHaveText("Unavailable");
  }
  for (const buttonId of statusButtons) {
    const button = page.locator(`#${buttonId}`);
    await expect(button).toHaveClass(/\bis-review\b/);
    await expect(button).not.toHaveClass(/\bis-verified\b/);
  }

  const statusMotion = await page.evaluate((buttonIds) => Object.fromEntries(buttonIds.map((buttonId) => [
    buttonId,
    getComputedStyle(document.querySelector(`#${buttonId} .status-signal`), "::after").animationName,
  ])), statusButtons);
  expect(statusMotion).toEqual(Object.fromEntries(statusButtons.map((buttonId) => [buttonId, "none"])));
});

test("identity workspace matches the approved visual baseline", async ({ page }) => {
  await resetScreenshotScroll(page);
  await expect(page).toHaveScreenshot("institutional-identity.png", { fullPage: true });
});

test("canonical desktop workspace states match approved visual baselines", async ({ page }, testInfo) => {
  if (testInfo.project.name !== "desktop-1600") return;
  const workspace = page.locator(".workspace-shell");
  const captureWorkflow = async (tabId, name) => {
    await page.locator(`#${tabId}`).click();
    await expect(workspace).toHaveScreenshot(`${name}.png`, { stylePath: workspaceScreenshotStyle });
  };

  await captureWorkflow("workflowTabTransfer", "workspace-transfer");
  await page.locator("#workflowTabLending").click();
  for (const mode of ["Deposit", "Borrow", "Repay", "Withdraw"]) {
    await page.locator(`#lendingMode${mode}Tab`).click();
    await expect(workspace).toHaveScreenshot(`workspace-lending-${mode.toLowerCase()}.png`, {
      stylePath: workspaceScreenshotStyle,
    });
  }
  await captureWorkflow("workflowTabReturn", "workspace-settlement");
  await captureWorkflow("workflowTabEvidence", "workspace-evidence");
});
