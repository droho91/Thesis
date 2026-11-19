import AxeBuilder from "@axe-core/playwright";
import { expect, test as base } from "@playwright/test";
import { statusFixture } from "./fixture-data.mjs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
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
      const matchingIndexes = unexpectedIssues.flatMap((issue, index) => (
        pattern.test(issue) ? [index] : []
      ));
      if (matchingIndexes.length === 0) {
        missingIssues.push(`expected issue was not observed: ${pattern}`);
        continue;
      }
      for (const index of matchingIndexes.reverse()) unexpectedIssues.splice(index, 1);
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
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Route ready");
  await expect(page.locator("#readinessTitle")).toHaveText("Ready to transfer");
  await expect(page.locator("#evidenceStepStatus")).toHaveText("Current pass");
  await expect(page.locator("#evidenceVerdictTitle")).toHaveText("Evidence matches the current reviewed source");
  await page.evaluate(() => document.fonts?.ready);
  await page.locator("img[src]").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
}

async function expectNoAccessibilityViolations(page, context) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(result.violations, `${context}: ${JSON.stringify(result.violations, null, 2)}`).toEqual([]);
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

test("an outdated evidence validator requests restart instead of reporting failed gates", async ({ page }) => {
  await page.context().addCookies([{
    name: "institutional_test_stale_validator",
    value: "1",
    url: page.url(),
  }]);
  await page.locator("#workflowTabEvidence").click();
  await expect(page.locator("#evidenceStepStatus")).toHaveText("Restart UI");
  await expect(page.locator("#evidenceVerdictLabel")).toHaveText("UI VALIDATOR RESTART REQUIRED");
  await expect(page.locator("#evidenceVerdictTitle")).toContainText("Restart the UI");
  await expect(page.locator("#evidenceSourceState")).toHaveText("Restart UI to load the current validator");
  await expect(page.locator("#evidenceVerdict")).toHaveClass(/is-warning/);
  await expect(page.locator("#evidenceVerdict")).not.toHaveClass(/is-error/);
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

test("brand symbol replaces mascot imagery while workflow guidance stays visible", async ({ page }) => {
  const requests = [];
  page.on("request", r => { if (r.url().includes("/assets/linky/generated/")) requests.push(r.url()); });
  await page.reload();
  await expect(page.locator("#readinessTitle")).toHaveText("Ready to transfer");
  await expect(page.locator(".brand-mark")).toHaveAttribute("src", "/assets/linky-mark.svg");
  for (const [tab, copy] of [["Identity", "readinessCopy"], ["Transfer", "relayRouteStatus"], ["Lending", "riskHealthLabel"], ["Position", "riskHealthLabel"], ["Return", "settlementGuardCopy"], ["Evidence", "evidenceVerdictCopy"]]) {
    await page.locator(`#workflowTab${tab}`).click();
    await expect(page.locator(`#${copy}`)).toBeVisible();
    await expect(page.locator(`#${copy}`)).not.toBeEmpty();
  }
  expect(requests).toEqual([]);
});

test("transfer progress remains visible without a mascot", async ({ page }) => {
  const messageId = "0xd100000000000000000000000000000000000000000000000000000000000001";
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...statusFixture,
        controller: {
          busy: true,
          activeOperation: {
            action: "bridge",
            stage: "attestor-quorum",
            messageId,
            sourceTransaction: "0xd200000000000000000000000000000000000000000000000000000000000002",
          },
        },
        relay: {
          ...statusFixture.relay,
          latestJob: { messageId, state: "source_checkpointed" },
        },
        workflow: { stage: "processing", nextAction: "bridge" },
      }),
    });
  });

  await page.locator("#refreshButton").click();
  await page.locator("#workflowTabTransfer").click();
  const progress = page.locator("#transferActionProgress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "63");
  await expect(progress.locator("span")).toHaveAttribute("style", /width: 63%/);
  await expect(page.locator("#transferPipeline")).toHaveClass(/\bis-processing\b/);
  await expect(page.locator("[data-proof-step=proof]")).toHaveClass(/is-active/);
  await expect(page.locator("#relayRouteStatus")).toContainText(/source checkpointed/i);
});

test("completed transfer keeps a dismissible notification", async ({ page }) => {
  await page.route("**/api/action", route => route.fulfill({status:200, contentType:"application/json", body:JSON.stringify({ok:true, operation:{action:"bridge",status:"completed"},status:statusFixture})}));
  await page.locator("#workflowTabTransfer").click();
  await page.locator('[data-action="bridge"]').click();
  await expect(page.locator("#workspacePanelLending")).toBeVisible();
  const toast=page.locator(".toast");
  await expect(toast).toHaveAttribute("role","status");
  await expect(toast.locator(".toast-icon svg")).toHaveCount(1);
  await expect(toast.locator("img")).toHaveCount(0);
  await toast.getByRole("button",{name:"Dismiss notification"}).click();
  await expect(toast).toHaveCount(0);
});

test("repayment Max closes the full debt in one action even after the quote accrues", async ({ page }) => {
  let current = { ...statusFixture, balances: { ...statusFixture.balances, creditAvailable: "1000" } };
  const requests = [];
  await page.route("**/api/status", route => route.fulfill({ json: current }));
  await page.route("**/api/action", async route => {
    requests.push(route.request().postDataJSON());
    current = { ...current, balances: { ...current.balances, outstandingDebt: "0" } };
    await route.fulfill({ json: { ok: true, operation: { action: "repayAll", status: "completed" }, status: current } });
  });
  await page.locator("#refreshButton").click();
  await page.locator("#workflowTabPosition").click();
  await page.locator("#lendingMaxButton").click();
  await expect(page.locator("#lendingSubmit")).toHaveText("Repay full debt");

  current = { ...current, balances: { ...current.balances, outstandingDebt: "200.0001" } };
  await page.locator("#refreshButton").click();
  await expect(page.locator("#lendingAmount")).toHaveValue("200.0001");
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repayAll");
  await page.locator("#lendingAmount").fill("50");
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repay");
  await page.locator("#lendingMaxButton").click();
  await page.locator("#lendingSubmit").click();
  await expect(page.locator("#debtBalance")).toHaveText("0");
  await expect(page.locator("#riskHealthLabel")).toHaveText("No active debt");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: "repayAll", amount: "200.0001" });
});

test("repayment Max uses only the available wallet balance when full repayment is unaffordable", async ({ page }) => {
  let current = { ...statusFixture, balances: { ...statusFixture.balances, creditAvailable: "100" } };
  const requests = [];
  await page.route("**/api/status", route => route.fulfill({ json: current }));
  await page.route("**/api/action", async route => {
    requests.push(route.request().postDataJSON());
    current = { ...current, balances: { ...current.balances, outstandingDebt: "100.0001", creditAvailable: "0" } };
    await route.fulfill({ json: { ok: true, operation: { action: "repay", status: "completed" }, status: current } });
  });
  await page.locator("#refreshButton").click();
  await page.locator("#workflowTabPosition").click();
  await page.locator("#lendingMaxButton").click();
  await expect(page.locator("#lendingAmount")).toHaveValue("100");
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repay");
  await expect(page.locator("#lendingMessage")).toContainText("Add bCASH to repay in full");
  await page.locator("#refreshButton").click();
  await expect(page.locator("#lendingMessage")).toContainText("Add bCASH to repay in full");
  await page.locator("#lendingAmount").fill("50");
  await expect(page.locator("#lendingMessage")).toBeEmpty();
  await page.locator("#lendingMaxButton").click();
  await page.locator("#lendingSubmit").click();
  await expect(page.locator("#lendingSubmit")).toBeDisabled();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: "repay", amount: "100" });
});

test("repayment Max blocks an unaffordable accrued balance and editing restores partial repayment", async ({ page }) => {
  let current = { ...statusFixture, balances: { ...statusFixture.balances, creditAvailable: "200.00005" } };
  await page.route("**/api/status", route => route.fulfill({ json: current }));
  await page.locator("#refreshButton").click();
  await page.locator("#workflowTabPosition").click();
  await page.locator("#lendingMaxButton").click();
  await expect(page.locator("#lendingSubmit")).toBeEnabled();
  current = { ...current, balances: { ...current.balances, outstandingDebt: "200.0001" } };
  await page.locator("#refreshButton").click();
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repayAll");
  await expect(page.locator("#lendingSubmit")).toBeDisabled();
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("title", /insufficient/);
  await page.locator("#lendingAmount").fill("50");
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repay");
  await expect(page.locator("#lendingSubmit")).toBeEnabled();
  await page.locator("#lendingMaxButton").click();
  await expect(page.locator("#lendingSubmit")).toHaveAttribute("data-action", "repay");
  await expect(page.locator("#lendingAmount")).toHaveValue("200.00005");
});

test("confirmed repayment history releases a stale retry before a new debt is repaid", async ({ page }) => {
  const staleRequestId = "request-repayment-old-complete";
  const completed = { requestId: staleRequestId, action: "repayAll", amount: "100", status: "completed" };
  let current = {
    ...statusFixture,
    balances: { ...statusFixture.balances, creditAvailable: "1000" },
    activity: { latest: completed, history: [completed] },
  };
  await page.evaluate(request => sessionStorage.setItem("institutional-request:repayAll", JSON.stringify(request)), completed);
  const requests = [];
  await page.route("**/api/status", route => route.fulfill({ json: current }));
  await page.route("**/api/action", async route => {
    const request = route.request().postDataJSON();
    requests.push(request);
    current = { ...current, balances: { ...current.balances, outstandingDebt: "0" } };
    await route.fulfill({ json: { ok: true, operation: { ...request, status: "completed" }, status: current } });
  });
  await page.locator("#refreshButton").click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("institutional-request:repayAll"))).toBeNull();
  await page.locator("#workflowTabPosition").click();
  await page.locator("#lendingMaxButton").click();
  await page.locator("#lendingSubmit").click();
  await expect(page.locator("#debtBalance")).toHaveText("0");
  expect(requests).toHaveLength(1);
  expect(requests[0].requestId).not.toBe(staleRequestId);
  expect(requests[0]).toMatchObject({ action: "repayAll", amount: "200" });
});

test("outstanding debt retains the borrowed principal when accrued interest is below display precision", async ({ page }) => {
  const current = { ...statusFixture, balances: { ...statusFixture.balances, outstandingDebt: "2100.00001", creditAvailable: "2200" } };
  await page.route("**/api/status", route => route.fulfill({ json: current }));
  await page.locator("#refreshButton").click();
  await expect(page.locator("#debtBalance")).toHaveText("2,100.0000…");
  await page.locator("#workflowTabPosition").click();
  await page.locator("#lendingMaxButton").click();
  await expect(page.locator("#lendingAmount")).toHaveValue("2100.00001");
  await expect(page.locator("#lendingSubmit")).toHaveText("Repay full debt");
  await expectNoAccessibilityViolations(page, "Debt with sub-precision accrued interest");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test("shared type roles use bundled fonts across views", async ({ page }) => {
  for (const weight of [400,500,600]) {
    expect(await page.evaluate(async w => (await document.fonts.load(`${w} 16px "Nunito"`)).length,weight)).toBeGreaterThan(0);
  }
  for (const weight of [500,600]) {
    expect(await page.evaluate(async w => (await document.fonts.load(`${w} 26px "Lora"`)).length,weight)).toBeGreaterThan(0);
  }
  let expected;
  for(const id of workflowTabs) {
    await page.locator(`#${id}`).click();
    const type=await page.locator('[data-panel]:not([hidden]) .section-heading h2').evaluate(n => {const s=getComputedStyle(n);return [s.fontFamily,s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing];});
    expected ??= type;
    expect(type).toEqual(expected);
    expect(type[0]).toContain("Lora");
  }
});

test("semantic value groups stay intact with long chain heights across the workflow", async ({ page }) => {
  const stressedStatus = {
    ...statusFixture,
    chains: {
      A: { ...statusFixture.chains.A, blockNumber: 123456789, trustedRemoteHeight: 987654319 },
      B: { ...statusFixture.chains.B, blockNumber: 987654321, trustedRemoteHeight: 123456787 },
    },
  };
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stressedStatus),
    });
  });

  await page.locator("#refreshButton").click();
  await expect(page.locator("#overviewChainABlock")).toHaveText("#123,456,789");
  await expect(page.locator("#overviewChainBBlock")).toHaveText("#987,654,321");
  const overviewGroups = page.locator("#overviewChainHeights > span");
  await expect(overviewGroups).toHaveCount(2);
  for (const group of await overviewGroups.all()) {
    await expect(group).toHaveCSS("white-space", "nowrap");
    expect(await group.evaluate((node) => node.getClientRects().length)).toBe(1);
  }

  await page.locator("#runtimeStatus").click();
  await expect(page.locator("#runtimeChainA")).toHaveText("A #123,456,789");
  await expect(page.locator("#runtimeChainB")).toHaveText("B #987,654,321");
  await page.keyboard.press("Escape");

  const layoutIssues = [];
  for (const tabId of workflowTabs) {
    await page.locator(`#${tabId}`).click();
    await waitForPanelEntry(page, page.locator(`#${tabId}`));
    const issues = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const atomicWithoutContract = [...document.querySelectorAll(".ui-atomic")]
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) => getComputedStyle(node).whiteSpace !== "nowrap")
        .map((node) => node.id || node.textContent.trim());
      return {
        atomicWithoutContract,
        documentOverflow: document.documentElement.scrollWidth > viewportWidth + 1,
      };
    });
    if (layoutIssues.length === 0 && (issues.documentOverflow || issues.atomicWithoutContract.length > 0)) {
      layoutIssues.push({ tabId, ...issues });
    }
  }
  expect(layoutIssues, JSON.stringify(layoutIssues, null, 2)).toEqual([]);
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

test("compact desktop preserves essential labels and values", async ({ page }, testInfo) => {
  if (!testInfo.project.name.startsWith("laptop-")) return;
  const criticalSelectors = [
    "#canonicalBalance",
    "#collateralBalance",
    "#debtBalance",
    "#healthFactor",
    ".journey-step b",
    ".section-heading h2",
    ".readiness-card h3",
    ".status-button > span",
    ".route-bank strong",
    ".position-strip dd",
    ".settlement-flow b",
    ".benchmark-strip dt",
    ".benchmark-strip dd",
  ];
  const clipped = [];
  for (const tabId of workflowTabs) {
    await page.locator(`#${tabId}`).click();
    const findings = await page.locator(criticalSelectors.join(", ")).evaluateAll((nodes) => nodes.flatMap((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden") return [];
      if (node.scrollWidth <= node.clientWidth + 1) return [];
      return [{
        selector: node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        text: node.textContent.trim().replace(/\s+/g, " ").slice(0, 100),
      }];
    }));
    clipped.push(...findings.map((finding) => ({ tabId, ...finding })));
  }
  expect(clipped, JSON.stringify(clipped, null, 2)).toEqual([]);

  const journeyGeometry = await page.locator(".journey").evaluate((journey) => {
    const journeyRect = journey.getBoundingClientRect();
    const tabs = [...journey.querySelectorAll(".journey-step")].map((tab) => {
      const rect = tab.getBoundingClientRect();
      return { id: tab.id, top: rect.top, bottom: rect.bottom };
    });
    const assuranceRect = journey.querySelector(".journey-assurance")?.getBoundingClientRect();
    return {
      clientHeight: journey.clientHeight,
      scrollHeight: journey.scrollHeight,
      top: journeyRect.top,
      bottom: journeyRect.bottom,
      tabs,
      assuranceBottom: assuranceRect?.bottom ?? null,
    };
  });
  expect(journeyGeometry.scrollHeight).toBeLessThanOrEqual(journeyGeometry.clientHeight + 1);
  expect(journeyGeometry.tabs).toHaveLength(workflowTabs.length);
  expect(journeyGeometry.tabs[0].top).toBeGreaterThanOrEqual(journeyGeometry.top);
  expect(journeyGeometry.tabs.at(-1).bottom).toBeLessThanOrEqual(journeyGeometry.bottom);
  expect(journeyGeometry.assuranceBottom).toBeLessThanOrEqual(journeyGeometry.bottom);
});

test("status controls stay still with either motion preference", async ({ page }) => {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    const motion = await page.evaluate(() => ({
      runtime: getComputedStyle(document.querySelector("#runtimeStatus")).animationName,
      credential: getComputedStyle(document.querySelector("#identityAStatusToggle .status-symbol-verified")).animationName,
    }));
    expect(motion).toEqual({ runtime: "none", credential: "none" });
  }

  const readinessCard = page.locator(".readiness-card").first();
  await readinessCard.hover();
  await expect.poll(() => readinessCard.evaluate((node) => getComputedStyle(node).transform)).toBe("none");

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
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Needs review");
  const reviewMotion = await page.evaluate(() => ({
    runtime: getComputedStyle(document.querySelector("#runtimeStatus")).animationName,
    credential: getComputedStyle(document.querySelector("#identityAStatusToggle .status-symbol-review")).animationName,
  }));
  expect(reviewMotion).toEqual({ runtime: "none", credential: "none" });
});

test("information panels preserve their status and geometry on hover", async ({ page }) => {
  const expectStablePanel = (before, after) => {
    const { width: beforeWidth, height: beforeHeight, ...beforeAppearance } = before;
    const { width: afterWidth, height: afterHeight, ...afterAppearance } = after;
    expect(afterWidth).toBeCloseTo(beforeWidth, 1);
    expect(afterHeight).toBeCloseTo(beforeHeight, 1);
    expect(afterAppearance).toEqual(beforeAppearance);
  };
  const readPanel = (panel) => panel.evaluate((node) => {
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    return {
      text: node.innerText,
      background: style.backgroundColor,
      border: style.borderColor,
      borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      shadow: style.boxShadow,
      transform: style.transform,
      width: bounds.width,
      height: bounds.height,
    };
  });
  let commonSurface;
  for (const [tab, selector] of [
    ["Identity", "#readinessVerdict"],
    ["Lending", ".risk-meter-hero"],
    ["Return", ".settlement-guard"],
    ["Evidence", ".evidence-verdict"],
  ]) {
    await page.locator(`#workflowTab${tab}`).click();
    await page.mouse.move(1, 1);
    const panel = page.locator(selector);
    const before = await readPanel(panel);
    expect(before.borderWidths).toEqual(["1px", "1px", "1px", "1px"]);
    expect(before.transform).toBe("none");
    commonSurface ??= before.background;
    expect(before.background).toBe(commonSurface);
    await panel.hover();
    expectStablePanel(before, await readPanel(panel));
  }
  const verdict = page.locator(".evidence-verdict");
  for (const tone of ["is-warning", "is-error"]) {
    await page.mouse.move(1, 1);
    await verdict.evaluate((node, state) => {
      node.classList.remove("is-warning", "is-error");
      node.classList.add(state);
    }, tone);
    const before = await readPanel(verdict);
    await verdict.hover();
    expectStablePanel(before, await readPanel(verdict));
  }
});

test("runtime failures clear stale status and position guidance, then recover", async ({ page, browserIntegrity }) => {
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

  const clearPositionStatus = {
    ...statusFixture,
    balances: { ...statusFixture.balances, outstandingDebt: "0", activeCollateral: "0" },
  };
  let offline = false;
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: offline ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(offline ? { error: "Fixture status endpoint is offline." } : clearPositionStatus),
    });
  });
  await page.locator("#refreshButton").click();
  await expect(page.locator("#settlementGuardTitle")).toHaveText("Position is clear");
  await expect(page.locator(".settlement-guard")).toHaveClass(/\bis-ready\b/);
  await expect(page.locator("#accrualState")).toHaveText("Current for actions");

  offline = true;
  const unavailableConsole = page.waitForEvent("console", {
    predicate: (message) => message.type() === "error" && /503 \(Service Unavailable\)/.test(message.text()),
  });
  await page.locator("#refreshButton").click();
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Unavailable");
  await expect(page.locator("#runtimeStatus")).toHaveClass(/\bis-error\b/);
  await expect(page.locator("#runtimeStatus")).not.toHaveClass(/\bis-ready\b/);
  await expect(page.locator("#readinessVerdict")).toHaveClass(/\bis-review\b/);
  await expect(page.locator("#readinessTitle")).toHaveText("Runtime unavailable");
  await expect(page.locator("#settlementGuardTitle")).toHaveText("Position unavailable");
  await expect(page.locator("#settlementGuardCopy")).toContainText("Reconnect to the runtime");
  await expect(page.locator(".settlement-guard")).not.toHaveClass(/\bis-ready\b/);
  await expect(page.locator("#accrualState")).toHaveText("-");
  await expect(page.locator("#riskHealthLabel")).toHaveText("Unavailable");
  await expect(page.locator(".risk-meter-hero")).toHaveAttribute("data-tone", "unavailable");
  await page.locator("#workflowTabLending").click();
  await expect(page.locator("#riskMeterFill")).toHaveCSS("width", "0px");
  await expect(page.locator("#routePhase")).toHaveText("Unavailable");

  for (const fieldId of statusFields) {
    await expect(page.locator(`#${fieldId}`)).toHaveText("Unavailable");
  }
  for (const buttonId of statusButtons) {
    const button = page.locator(`#${buttonId}`);
    await expect(button).toHaveClass(/\bis-review\b/);
    await expect(button).not.toHaveClass(/\bis-verified\b/);
  }
  await unavailableConsole;

  const statusMotion = await page.evaluate((buttonIds) => Object.fromEntries(buttonIds.map((buttonId) => [
    buttonId,
    getComputedStyle(document.querySelector(`#${buttonId} .status-symbol-review`)).animationName,
  ])), statusButtons);
  expect(statusMotion).toEqual(Object.fromEntries(statusButtons.map((buttonId) => [buttonId, "none"])));

  offline = false;
  await page.locator("#refreshButton").click();
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Route ready");
  await expect(page.locator("#settlementGuardTitle")).toHaveText("Position is clear");
  await expect(page.locator(".settlement-guard")).toHaveClass(/\bis-ready\b/);
  await expect(page.locator("#accrualState")).toHaveText("Current for actions");
  await expect(page.locator("#riskHealthLabel")).toHaveText("No active debt");
  await expect(page.locator(".risk-meter-hero")).toHaveAttribute("data-tone", "safe");
});
