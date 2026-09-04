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
  await expect(page.locator("#runtimeStatusLabel")).toHaveText("Lane ready");
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

test("Linky moments stay contextual, separated from copy, and preserve image proportions", async ({ page }) => {
  await expect(page.locator(".linky-command-center")).toHaveCount(0);
  await expect(page.locator(".linky-widget")).toHaveCount(5);
  const panels = [
    ["#workflowTabIdentity", "#linkyIdentityImage", "#readinessVerdict > div[role='status']"],
    ["#workflowTabTransfer", "#linkyTransferImage", ".route-relay > b"],
    ["#workflowTabLending", "#linkyLendingImage", ".risk-meter-summary"],
    ["#workflowTabPosition", "#linkyLendingImage", ".risk-meter-summary"],
    ["#workflowTabReturn", "#linkySettlementImage", ".settlement-guard > div[role='status']"],
    ["#workflowTabEvidence", "#linkyEvidenceImage", ".evidence-verdict > div[role='status']"],
  ];
  for (const [tabSelector, imageSelector, copySelector] of panels) {
    await page.locator(tabSelector).click();
    const mascot = page.locator(imageSelector);
    await expect(mascot).toBeVisible();
    await expect.poll(() => mascot.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const geometry = await page.evaluate(({ imageSelector: imageQuery, copySelector: copyQuery }) => {
      const image = document.querySelector(imageQuery);
      const copy = document.querySelector(copyQuery);
      const widget = image.closest(".linky-widget");
      const companion = widget?.closest(".linky-companion-layout");
      const primarySurface = companion?.firstElementChild;
      const imageRect = image.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();
      const widgetRect = widget?.getBoundingClientRect();
      const primaryRect = primarySurface?.getBoundingClientRect();
      const widgetStyle = widget ? getComputedStyle(widget) : null;
      const primaryStyle = primarySurface ? getComputedStyle(primarySurface) : null;
      return {
        objectFit: getComputedStyle(image).objectFit,
        naturalRatio: image.naturalWidth / image.naturalHeight,
        hasIndependentWidget: Boolean(widget && companion && companion.contains(copy) && !widget.contains(copy)),
        dockGap: widgetRect && primaryRect ? Math.abs(widgetRect.left - primaryRect.right) : null,
        paletteMatches: Boolean(widgetStyle && primaryStyle
          && widgetStyle.backgroundColor === primaryStyle.backgroundColor
          && widgetStyle.borderTopColor === primaryStyle.borderRightColor),
        displaySize: { width: imageRect.width, height: imageRect.height },
        imageRect: { left: imageRect.left, right: imageRect.right, top: imageRect.top, bottom: imageRect.bottom },
        copyRect: { left: copyRect.left, right: copyRect.right, top: copyRect.top, bottom: copyRect.bottom },
        overlaps: imageRect.left < copyRect.right
          && imageRect.right > copyRect.left
          && imageRect.top < copyRect.bottom
          && imageRect.bottom > copyRect.top,
      };
    }, { imageSelector, copySelector });
    expect(geometry.objectFit).toBe("contain");
    expect(geometry.naturalRatio).toBeGreaterThan(0.7);
    expect(geometry.naturalRatio).toBeLessThan(1.35);
    expect(geometry.hasIndependentWidget).toBe(true);
    expect(geometry.dockGap).toBeLessThanOrEqual(1);
    expect(geometry.paletteMatches).toBe(true);
    expect(geometry.displaySize.width).toBeGreaterThanOrEqual(160);
    expect(geometry.displaySize.height).toBeGreaterThanOrEqual(160);
    expect(geometry.overlaps, JSON.stringify({ tabSelector, imageSelector, copySelector, geometry }, null, 2)).toBe(false);
  }

  await expect(page.locator(".risk-meter > .linky-companion-layout-lending + dl")).toHaveCount(1);
  await expect(page.locator("#workspacePanelLending > .linky-companion-layout-lending")).toHaveCount(0);
  await expect(page.locator(".operation-layout > .linky-companion-layout-settlement")).toHaveCount(1);
});

test("Transfer Linky reports live action progress instead of a decorative accent", async ({ page }) => {
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
  const progress = page.locator("#linkyTransferProgress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "63");
  await expect(progress.locator("span")).toHaveAttribute("style", /width: 63%/);
  await expect(page.locator("#transferPipeline")).toHaveClass(/\bis-processing\b/);
  await expect(page.locator("#linkyTransferImage")).toHaveAttribute("src", /linky-proof-inspect\.png$/);
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

test("motion follows readiness state and reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const readyMotion = await page.evaluate(() => {
    const liveDot = document.querySelector(".live-dot");
    const dotRect = liveDot.getBoundingClientRect();
    const coreStyle = getComputedStyle(liveDot, "::before");
    const ringStyle = getComputedStyle(liveDot, "::after");
    const resolveAnchor = (value, extent) => (
      value.endsWith("%")
        ? Number.parseFloat(value) * extent / 100
        : Number.parseFloat(value)
    );
    const isCentred = (style) => {
      const [originX, originY] = style.transformOrigin.split(" ").map(Number.parseFloat);
      return (
        Math.abs(resolveAnchor(style.left, dotRect.width) - dotRect.width / 2) < 0.1
        && Math.abs(resolveAnchor(style.top, dotRect.height) - dotRect.height / 2) < 0.1
        && Math.abs(originX - Number.parseFloat(style.width) / 2) < 0.1
        && Math.abs(originY - Number.parseFloat(style.height) / 2) < 0.1
      );
    };
    return {
      live: ringStyle.animationName,
      liveCentred: isCentred(coreStyle) && isCentred(ringStyle),
      liveGeometry: {
        dot: { width: dotRect.width, height: dotRect.height },
        core: {
          left: coreStyle.left,
          top: coreStyle.top,
          width: coreStyle.width,
          height: coreStyle.height,
          transformOrigin: coreStyle.transformOrigin,
        },
        ring: {
          left: ringStyle.left,
          top: ringStyle.top,
          width: ringStyle.width,
          height: ringStyle.height,
          transformOrigin: ringStyle.transformOrigin,
        },
      },
      status: getComputedStyle(document.querySelector("#identityAStatusToggle .status-symbol-verified")).animationName,
    };
  });
  expect(readyMotion.live).toBe("live-ring");
  expect(readyMotion.liveCentred, JSON.stringify(readyMotion.liveGeometry)).toBe(true);
  expect(readyMotion.status).toBe("none");

  const readinessCard = page.locator(".readiness-card").first();
  await readinessCard.hover();
  await expect.poll(() => readinessCard.evaluate((node) => getComputedStyle(node).transform)).not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() => ({
    live: getComputedStyle(document.querySelector(".live-dot"), "::after").animationName,
    status: getComputedStyle(document.querySelector("#identityAStatusToggle .status-symbol-verified")).animationName,
  }));
  expect(reducedMotion).toEqual({ live: "none", status: "none" });

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
    sheen: getComputedStyle(document.querySelector("#readinessPill"), "::after").animationName,
    credential: getComputedStyle(document.querySelector("#identityAStatusToggle .status-symbol-review")).animationName,
  }));
  expect(reviewMotion).toEqual({ live: "none", sheen: "none", credential: "none" });
});

test("settlement and evidence hover only brightens the semantic left accent", async ({ page }) => {
  await page.addStyleTag({ content: ".settlement-guard, .evidence-verdict, .linky-widget { transition: none !important; }" });
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...statusFixture,
        balances: {
          ...statusFixture.balances,
          activeCollateral: "0",
          outstandingDebt: "0",
        },
      }),
    });
  });
  await page.locator("#refreshButton").click();

  const readTone = (card, accentVariable = null) => card.evaluate((node, expectedAccentVariable) => {
    const probe = document.createElement("span");
    if (expectedAccentVariable) probe.style.borderLeft = `1px solid var(${expectedAccentVariable})`;
    document.body.append(probe);
    const nodeStyle = getComputedStyle(node);
    const widgetStyle = getComputedStyle(node.nextElementSibling);
    const probeStyle = getComputedStyle(probe);
    const result = {
      cardBackground: nodeStyle.backgroundColor,
      cardBorder: nodeStyle.borderTopColor,
      cardLeftAccent: nodeStyle.borderLeftColor,
      widgetBackground: widgetStyle.backgroundColor,
      widgetBorder: widgetStyle.borderTopColor,
      expectedAccent: expectedAccentVariable ? probeStyle.borderLeftColor : null,
    };
    probe.remove();
    return result;
  }, accentVariable);
  const expectOnlyAccentChanged = (before, after) => {
    expect(after.cardLeftAccent).toBe(after.expectedAccent);
    expect(after.cardLeftAccent).not.toBe(before.cardLeftAccent);
    expect(after.cardBackground).toBe(before.cardBackground);
    expect(after.cardBorder).toBe(before.cardBorder);
    expect(after.widgetBackground).toBe(before.widgetBackground);
    expect(after.widgetBorder).toBe(before.widgetBorder);
  };

  await page.locator("#workflowTabReturn").click();
  await expect(page.locator("#settlementGuardTitle")).toHaveText("Position is clear");
  const settlementGuard = page.locator(".settlement-guard");
  const settlementBefore = await readTone(settlementGuard);
  await settlementGuard.hover();
  expectOnlyAccentChanged(settlementBefore, await readTone(settlementGuard, "--green-bright"));

  await page.locator("#workflowTabEvidence").click();
  const evidenceVerdict = page.locator(".evidence-verdict");
  const evidenceBefore = await readTone(evidenceVerdict);
  await evidenceVerdict.hover();
  expectOnlyAccentChanged(evidenceBefore, await readTone(evidenceVerdict, "--green-bright"));

  await page.mouse.move(1, 1);
  await evidenceVerdict.evaluate((node) => node.classList.add("is-error"));
  const errorBefore = await readTone(evidenceVerdict);
  await evidenceVerdict.hover();
  expectOnlyAccentChanged(errorBefore, await readTone(evidenceVerdict, "--red-bright"));
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
  const unavailableConsole = page.waitForEvent("console", {
    predicate: (message) => message.type() === "error" && /503 \(Service Unavailable\)/.test(message.text()),
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
  await unavailableConsole;

  const statusMotion = await page.evaluate((buttonIds) => Object.fromEntries(buttonIds.map((buttonId) => [
    buttonId,
    getComputedStyle(document.querySelector(`#${buttonId} .status-symbol-review`)).animationName,
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
