import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.2/+esm";

const DECIMALS = 18;
const ORACLE_DECIMALS = 1e8;
const MARKET_STORAGE_KEY = "thesis-active-market";

const ABI = {
  erc20: [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function mint(address to, uint256 amount)",
  ],
  vault: [
    "function lock(uint256 amount)",
    "function lockedBalance(address user) view returns (uint256)",
    "event Locked(address indexed user, uint256 amount)",
    "event UnlockedFromBurn(address indexed user, uint256 amount, bytes32 indexed burnEventId)",
  ],
  wrapped: [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "event BridgeMintedFromLock(address indexed to, uint256 amount, bytes32 indexed lockEventId)",
  ],
  gateway: [
    "function computeMessageId(bytes32 srcTxHash, uint256 srcLogIndex, address user, uint256 amount) view returns (bytes32)",
    "function attestCount(bytes32 messageId) view returns (uint256)",
    "function executed(bytes32 messageId) view returns (bool)",
    "function threshold() view returns (uint256)",
    "function requestBurn(uint256 amount)",
    "event BurnRequested(address indexed user, uint256 amount)",
  ],
  oracle: [
    "function getPrice(address token) view returns (uint256)",
    "function setPrice(address token, uint256 newPrice)",
  ],
  router: [
    "function feeBps() view returns (uint256)",
    "function previewSwap(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  ],
  pool: [
    "function depositCollateral(uint256 amount)",
    "function borrow(uint256 amount)",
    "function repay(uint256 amount)",
    "function repayAvailable() returns (uint256)",
    "function repayAll() returns (uint256)",
    "function repayWithCollateral(uint256 collateralAmount, uint256 minStableOut) returns (uint256 stableReceived, uint256 debtRepaid, uint256 stableRefunded)",
    "function withdrawCollateral(uint256 amount)",
    "function withdrawMax() returns (uint256)",
    "function maxBorrowable(address user) view returns (uint256)",
    "function maxWithdrawable(address user) view returns (uint256)",
    "function previewDebt(address user) view returns (uint256)",
    "function debtBreakdown(address user) view returns (uint256 principal, uint256 interest, uint256 penalty, uint256 total)",
    "function healthFactorBps(address user) view returns (uint256)",
    "function utilizationBps() view returns (uint256)",
    "function borrowRateBps() view returns (uint256)",
    "function isOverdue(address user) view returns (bool)",
    "function positions(address user) view returns (uint256 collateralAmount, uint256 principalAmount, uint256 accruedInterestAmount, uint256 penaltyAmount, uint256 dueTimestamp, bool overduePenaltyApplied)",
    "function collateralFactorBps() view returns (uint256)",
    "function liquidationThresholdBps() view returns (uint256)",
    "function closeFactorBps() view returns (uint256)",
    "function loanDuration() view returns (uint256)",
    "function overduePenaltyBps() view returns (uint256)",
    "function liquidationBonusBps() view returns (uint256)",
    "function collateralValueUsd(address user) view returns (uint256)",
    "function debtValueUsd(address user) view returns (uint256)",
    "function setCollateralFactorBps(uint256 value)",
    "function setLoanDuration(uint256 value)",
    "function setOverduePenaltyBps(uint256 value)",
    "function setLiquidationBonusBps(uint256 value)",
    "function applyOverduePenalty(address user)",
    "function liquidate(address user, uint256 repayAmount)",
    "event Borrowed(address indexed user, uint256 amount)",
    "event Repaid(address indexed user, uint256 amount)",
    "event Liquidated(address indexed user, address indexed liquidator, uint256 repaidDebt, uint256 seizedCollateral, bool overdueLiquidation)",
    "event RepaidWithCollateral(address indexed user, uint256 collateralSold, uint256 stableReceived, uint256 debtRepaid, uint256 stableRefunded)",
  ],
};

const ACTION_META = {
  applyRiskProfileBtn: { role: "owner", chain: "destination", label: "Apply risk baseline" },
  updateFactorBtn: { role: "owner", chain: "destination", label: "Set collateral factor" },
  updateDurationBtn: { role: "owner", chain: "destination", label: "Set loan duration" },
  updatePenaltyBtn: { role: "owner", chain: "destination", label: "Set overdue penalty" },
  updateBonusBtn: { role: "owner", chain: "destination", label: "Set liquidation bonus" },
  updateCollateralPriceBtn: { role: "owner", chain: "destination", label: "Set wrapped price" },
  updateStablePriceBtn: { role: "owner", chain: "destination", label: "Set stable price" },
  mintCollateralToUserBtn: { role: "owner", chain: "source", label: "Mint local collateral to user" },
  mintStableToUserBtn: { role: "owner", chain: "destination", label: "Mint stable to user" },
  mintStableToPoolBtn: { role: "owner", chain: "destination", label: "Mint stable to pool" },
  advanceTimeBtn: { role: "owner", chain: "destination", label: "Advance +1 day" },
  applyPenaltyBtn: { role: "any", chain: "destination", label: "Apply overdue penalty" },
  liquidateBtn: { role: "any", chain: "destination", label: "Liquidate user" },
  lockBtn: { role: "user", chain: "source", label: "Lock collateral" },
  depositBtn: { role: "user", chain: "destination", label: "Deposit wrapped collateral" },
  borrowBtn: { role: "user", chain: "destination", label: "Borrow stable" },
  repayBtn: { role: "user", chain: "destination", label: "Repay stable" },
  repayMaxBtn: { role: "user", chain: "destination", label: "Repay wallet max debt" },
  repayAllBtn: { role: "user", chain: "destination", label: "Repay all debt" },
  autoCloseDebtBtn: { role: "user", chain: "destination", label: "Sell collateral to repay debt" },
  withdrawMaxBtn: { role: "user", chain: "destination", label: "Withdraw max collateral" },
  burnMaxBtn: { role: "user", chain: "destination", label: "Burn max wrapped collateral" },
  closeWithCollateralBtn: { role: "user", chain: "destination", label: "Sell custom collateral amount" },
  withdrawBtn: { role: "user", chain: "destination", label: "Withdraw wrapped collateral" },
  requestBurnBtn: { role: "user", chain: "destination", label: "Request burn" },
};

const $ = (id) => document.getElementById(id);

let cfg;
let ctx = null;
let latestState = null;
let portalType = "user";
let booted = false;
let selectedMarketId = "A_TO_B";
let toastHost = null;
let positionSummaryScrollBound = false;
let advancedTabsBound = false;
const busyActions = new Set();
let suppressChainChangedRefresh = false;

function saveSelectedMarket() {
  try {
    window.localStorage?.setItem(MARKET_STORAGE_KEY, selectedMarketId);
  } catch {}
}

function loadSavedMarket() {
  try {
    return window.localStorage?.getItem(MARKET_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function padRight(value, length) {
  return value.length >= length ? value : value + "0".repeat(length - value.length);
}

function fmtToken(amount, options = {}) {
  const { decimals = 4, tinyLabel = true, floor = true } = options;
  const rawAmount = amount ?? 0n;
  if (rawAmount === 0n) {
    return `0.${"0".repeat(decimals)}`;
  }

  const normalized = ethers.formatUnits(rawAmount, DECIMALS);
  const [intPart, fracPart = ""] = normalized.split(".");
  const truncatedFraction = padRight(fracPart, decimals).slice(0, decimals);
  const truncated = `${intPart}.${truncatedFraction}`;

  if (intPart === "0" && /^0+$/.test(truncatedFraction) && tinyLabel) {
    return `<0.${"0".repeat(Math.max(0, decimals - 1))}1`;
  }

  if (floor) {
    return truncated;
  }

  return Number(normalized).toFixed(decimals);
}

function debtDustBuffer(amount) {
  return amount / 1_000_000n > 1_000_000_000_000n ? amount / 1_000_000n : 1_000_000_000_000n;
}

function exactTokenString(amount) {
  const normalized = ethers.formatUnits(amount ?? 0n, DECIMALS);
  if (!normalized.includes(".")) return normalized;
  return normalized.replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, "$1");
}

function fmtPctBps(bps) {
  return `${(Number(bps ?? 0n) / 100).toFixed(2)}%`;
}

function fmtUsdWad(amount) {
  return fmtToken(amount, { decimals: 4, tinyLabel: true, floor: true });
}

function ceilDiv(a, b) {
  if (b === 0n) throw new Error("Division by zero.");
  if (a === 0n) return 0n;
  return ((a - 1n) / b) + 1n;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function setTitle(id, value) {
  const node = $(id);
  if (node) node.title = value;
}

function setPlaceholder(id, value) {
  const node = $(id);
  if (node) node.placeholder = value;
}

function setInputValue(id, value) {
  const node = $(id);
  if (node) node.value = value;
}

function clearInputs(ids = []) {
  for (const id of ids) {
    const node = $(id);
    if (node && "value" in node) {
      node.value = "";
    }
  }
}

function setButtonText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function setClass(id, className, enabled) {
  const node = $(id);
  if (node) node.classList.toggle(className, Boolean(enabled));
}

function setTooltip(id, value) {
  const node = $(id);
  if (!node) return;
  node.setAttribute("data-tooltip", value || "");
  node.setAttribute("aria-label", value || "");
}

function setStatusChip(id, text, variant) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.classList.remove("status-safe", "status-caution", "status-risk", "status-info");
  node.classList.add(variant || "status-info");
}

function setActionReason(id, message, tone = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = message || "-";
  node.classList.remove("reason-good", "reason-bad");
  if (tone) {
    node.classList.add(tone);
  }
}

function setActionFeedback(message, kind = "info") {
  const node = $("actionInlineFeedback");
  if (!node) return;
  node.textContent = message || "";
  node.classList.remove("action-feedback-info", "action-feedback-pending", "action-feedback-success", "action-feedback-error");
  node.classList.add(`action-feedback-${kind}`);
}

function setBridgeStep(id, textId, status, text) {
  setText(textId, text);
  setClass(id, "is-done", status === "done");
  setClass(id, "is-active", status === "active");
  setClass(id, "is-idle", status === "idle");
}

function getToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.className = "toast-stack";
  document.body.appendChild(toastHost);
  return toastHost;
}

function toastKind(message, isError) {
  if (isError) return "error";
  if (message.includes("pending...")) return "pending";
  if (message.includes("success")) return "success";
  return "info";
}

function showToast(message, isError = false) {
  const host = getToastHost();
  const toast = document.createElement("div");
  const kind = toastKind(message, isError);
  toast.className = `toast toast-${kind}`;

  const title = document.createElement("strong");
  title.className = "toast-title";
  title.textContent =
    kind === "error" ? "Error" :
    kind === "pending" ? "Pending" :
    kind === "success" ? "Success" :
    "Info";

  const body = document.createElement("span");
  body.className = "toast-body";
  body.textContent = message;

  toast.append(title, body);
  host.prepend(toast);

  while (host.children.length > 4) {
    host.lastElementChild?.remove();
  }

  requestAnimationFrame(() => toast.classList.add("visible"));

  const ttl =
    kind === "error" ? 5200 :
    kind === "pending" ? 2200 :
    3200;

  window.setTimeout(() => {
    toast.classList.remove("visible");
    window.setTimeout(() => toast.remove(), 220);
  }, ttl);
}

function addLog(message, isError = false) {
  const list = $("logList");
  if (!list) return;

  const li = document.createElement("li");
  li.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  if (isError) li.classList.add("error");
  list.prepend(li);
  showToast(message, isError);
}

function parseAmount(inputId, fallback, label) {
  const input = $(inputId);
  const raw = (input?.value || "").trim();
  if (raw === "" && (fallback === null || fallback === undefined || fallback === "")) {
    throw new Error(`${label}: enter an amount first.`);
  }

  const value = raw === "" ? fallback : raw;

  let amount;
  try {
    amount = ethers.parseUnits(value, DECIMALS);
  } catch {
    throw new Error(`${label}: invalid number.`);
  }

  if (amount <= 0n) {
    throw new Error(`${label}: must be > 0.`);
  }

  return amount;
}

function parseBps(inputId, fallback, min, max, label) {
  const input = $(inputId);
  const raw = (input?.value || "").trim();
  const value = raw === "" ? fallback : raw;
  const n = Number(value);

  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label}: must be integer in [${min}, ${max}].`);
  }

  return n;
}

function parseHours(inputId, fallback, label) {
  const input = $(inputId);
  const raw = (input?.value || "").trim();
  const value = raw === "" ? fallback : raw;
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label}: must be positive integer.`);
  }

  return n;
}

function parsePriceE8(inputId, fallback, label) {
  const input = $(inputId);
  const raw = (input?.value || "").trim();
  const value = raw === "" ? fallback : raw;
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label}: must be positive number.`);
  }

  return BigInt(Math.round(n * ORACLE_DECIMALS));
}

function normalizeConfig(raw) {
  if (raw.chains && raw.markets && raw.roles) return raw;
  throw new Error("Invalid multichain-addresses.json. Run deploy:multichain again.");
}

function getMarketConfig(marketId = selectedMarketId) {
  return cfg.markets[marketId];
}

function getChainByKey(chainKey) {
  return cfg.chains[chainKey];
}

function getChainConfig(roleOrKey) {
  const market = getMarketConfig();
  if (roleOrKey === "source") return cfg.chains[market.sourceChain];
  if (roleOrKey === "destination") return cfg.chains[market.destinationChain];
  return cfg.chains[roleOrKey];
}

function getSourceChain() {
  return getChainConfig("source");
}

function getDestinationChain() {
  return getChainConfig("destination");
}

function getUserAddress() {
  return cfg.roles.user;
}

function getOwnerAddress() {
  return cfg.roles.owner;
}

function chainNameById(chainId) {
  const cid = Number(chainId);
  if (!cfg) return `Unknown (${cid})`;

  for (const [key, chain] of Object.entries(cfg.chains)) {
    if (Number(chain.chainId) === cid) return `${chain.name || `Chain ${key}`} (${cid})`;
  }

  return `Unknown (${cid})`;
}

function roleText(role) {
  if (role === "owner") return "Owner";
  if (role === "validator") return "Validator";
  if (role === "user") return "User";
  if (role === "any") return "Any";
  return "Unknown";
}

function currentRole() {
  if (!ctx || !cfg) return "unknown";
  const address = ctx.address.toLowerCase();

  if (address === getOwnerAddress().toLowerCase()) return "owner";
  if (address === getUserAddress().toLowerCase()) return "user";
  if ((cfg.roles.validators || []).some((v) => v.toLowerCase() === address)) return "validator";
  return "unknown";
}

function clearRecommendedButton() {
  for (const id of Object.keys(ACTION_META)) {
    const btn = $(id);
    if (btn) btn.classList.remove("recommended");
  }
}

function setRecommendedButton(buttonId) {
  clearRecommendedButton();
  if (!buttonId) return;
  const btn = $(buttonId);
  if (btn) btn.classList.add("recommended");
}

function syncPositionSummaryToggle() {
  const strip = document.querySelector(".position-strip");
  const toggle = $("positionSummaryToggle");
  const icon = $("positionSummaryToggleIcon");
  if (!strip || !toggle || !icon) return;

  const collapsed = strip.classList.contains("is-collapsed");
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute("aria-label", collapsed ? "Expand position summary" : "Collapse position summary");
  icon.textContent = collapsed ? "▾" : "▴";
}

function updatePositionSummaryStickyState() {
  const strip = document.querySelector(".position-strip");
  const toggle = $("positionSummaryToggle");
  if (!strip || !toggle) return;

  const sticky = window.scrollY > 0 && strip.getBoundingClientRect().top <= 12;
  strip.classList.toggle("is-sticky", sticky);
  toggle.disabled = !sticky;

  if (!sticky) {
    strip.classList.remove("is-collapsed");
  }

  syncPositionSummaryToggle();
}

function bindPositionSummaryToggle() {
  const toggle = $("positionSummaryToggle");
  const strip = document.querySelector(".position-strip");
  if (!toggle || !strip) return;

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    strip.classList.toggle("is-collapsed");
    syncPositionSummaryToggle();
  });

  if (!positionSummaryScrollBound) {
    window.addEventListener("scroll", updatePositionSummaryStickyState, { passive: true });
    window.addEventListener("resize", updatePositionSummaryStickyState);
    positionSummaryScrollBound = true;
  }

  updatePositionSummaryStickyState();
}

function bindAdvancedTabs() {
  if (advancedTabsBound) return;
  advancedTabsBound = true;

  document.querySelectorAll(".advanced-tabs").forEach((tabBar) => {
    tabBar.addEventListener("click", (event) => {
      const button = event.target.closest(".advanced-tab");
      if (!button) return;

      const shell = tabBar.closest(".advanced-shell");
      if (!shell) return;

      const target = button.dataset.tabTarget;
      tabBar.querySelectorAll(".advanced-tab").forEach((tab) => {
        tab.classList.toggle("active", tab === button);
      });
      shell.querySelectorAll(".advanced-section").forEach((section) => {
        section.classList.toggle("active", section.dataset.tabPanel === target);
      });
    });
  });
}

async function ensureContractDeployed(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} is not deployed at ${address}. Run deploy:multichain again.`);
  }
}

function physicalChainDetails(chain) {
  return `${chain.rpc} (chainId ${chain.chainId})`;
}

function renderStaticConfig() {
  const chainA = getChainByKey("A");
  const chainB = getChainByKey("B");

  setText("chainAHeader", physicalChainDetails(chainA));
  setText("chainBHeader", physicalChainDetails(chainB));
  setText("infraSourceTitle", chainA.name || "Chain A");
  setText("infraDestinationTitle", chainB.name || "Chain B");

  setText("a-vault", chainA.collateralVault || "-");
  setText("a-gateway", `mint ${chainA.mintGateway || "-"} | unlock ${chainA.unlockGateway || "-"}`);
  setText("a-token", chainA.localCollateralToken || "-");
  setText("a-router", chainA.swapRouter || "-");

  setText("b-gateway", `mint ${chainB.mintGateway || "-"} | unlock ${chainB.unlockGateway || "-"}`);
  setText("b-wrapped", chainB.wrappedRemoteToken || "-");
  setText("b-stable", chainB.stableToken || "-");
  setText("b-pool", chainB.lendingPool || "-");
  setText("b-router", chainB.swapRouter || "-");

  setText("owner-address", getOwnerAddress());
  setText("user-address", getUserAddress());
  setText("validators-addresses", (cfg.roles.validators || []).join(", "));
  setText("bridge-threshold", String(cfg.roles.bridgeThreshold));
}

function marketDescription(market) {
  const source = getChainByKey(market.sourceChain);
  const destination = getChainByKey(market.destinationChain);
  return `${source.name} collateral -> ${destination.name} borrowing`;
}

function marketIdForChains(sourceChain, destinationChain) {
  for (const [marketId, market] of Object.entries(cfg.markets || {})) {
    if (market.sourceChain === sourceChain && market.destinationChain === destinationChain) {
      return marketId;
    }
  }
  return null;
}

function renderMarketSelectors() {
  const collateralSelect = $("collateralChainSelect");
  const lendingSelect = $("lendingChainSelect");
  if (!collateralSelect || !lendingSelect || !cfg?.chains) return;

  const chainEntries = Object.entries(cfg.chains);
  const sourceKey = getMarketConfig().sourceChain;
  const destinationKey = getMarketConfig().destinationChain;

  if (!collateralSelect.dataset.bootstrapped) {
    const options = chainEntries
      .map(([chainKey, chain]) => `<option value="${chainKey}">${chain.name || chainKey}</option>`)
      .join("");
    collateralSelect.innerHTML = options;
    lendingSelect.innerHTML = options;
    collateralSelect.dataset.bootstrapped = "true";
    lendingSelect.dataset.bootstrapped = "true";
  }

  collateralSelect.value = sourceKey;
  lendingSelect.value = destinationKey;
}

function renderMarketLabels() {
  const market = getMarketConfig();
  const source = getSourceChain();
  const destination = getDestinationChain();
  const symbols = market.symbols;

  setText("activeMarketText", `${market.id}: ${marketDescription(market)}`);
  setText("sourceCardTitle", `${source.name}`);
  setText("destinationCardTitle", `${destination.name}`);
  setText("sourceBalanceLabel", `${symbols.collateral} wallet`);
  setText("sourceLockedLabel", `Locked ${symbols.collateral}`);
  setText("destinationWrappedLabel", `${symbols.wrapped} wallet`);
  setText("destinationStableLabel", `${symbols.stable} wallet`);
  setText("poolCollateralLabel", `${symbols.wrapped} in pool`);
  setText("debtLabel", `Total debt (${symbols.stable})`);
  setText("maxBorrowLabel", `Max borrow (${symbols.stable})`);
  setText("healthFactorLabel", "Health factor");

  setButtonText("mintCollateralToUserBtn", `Mint ${symbols.collateral}`);
  setButtonText("mintStableToUserBtn", `Mint ${symbols.stable}`);
  setButtonText("mintStableToPoolBtn", `Mint ${symbols.stable}`);
  setButtonText("lockBtn", `Lock ${symbols.collateral}`);
  setButtonText("depositBtn", `Deposit ${symbols.wrapped}`);
  setButtonText("borrowBtn", `Borrow ${symbols.stable}`);
  setButtonText("repayBtn", `Repay ${symbols.stable}`);
  setButtonText("repayMaxBtn", `Repay Wallet Max ${symbols.stable}`);
  setButtonText("repayAllBtn", `Repay All ${symbols.stable}`);
  setButtonText("autoCloseDebtBtn", `Sell ${symbols.wrapped} to Repay`);
  setButtonText("withdrawMaxBtn", `Withdraw Max ${symbols.wrapped}`);
  setButtonText("burnMaxBtn", `Burn Max ${symbols.wrapped}`);
  setButtonText("closeWithCollateralBtn", `Sell Custom ${symbols.wrapped}`);
  setButtonText("withdrawBtn", `Withdraw ${symbols.wrapped}`);
  setButtonText("requestBurnBtn", `Burn ${symbols.wrapped}`);

  setPlaceholder("mintCollateralAmount", `${symbols.collateral} to user`);
  setPlaceholder("mintStableToUserAmount", `${symbols.stable} to user`);
  setPlaceholder("mintStableAmount", `${symbols.stable} to pool`);
  setPlaceholder("lockAmount", `Lock amount (${symbols.collateral})`);
  setPlaceholder("burnAmount", `Burn amount (${symbols.wrapped})`);
  setPlaceholder("depositAmount", `Deposit ${symbols.wrapped}`);
  setPlaceholder("borrowAmount", `Borrow ${symbols.stable}`);
  setPlaceholder("repayAmount", `Repay ${symbols.stable}`);
  setPlaceholder("closeWithCollateralAmount", `Sell custom ${symbols.wrapped} amount`);
  setPlaceholder("withdrawAmount", `Withdraw ${symbols.wrapped}`);
  setPlaceholder("collateralPriceInput", `${symbols.wrapped} price (USD)`);
  setPlaceholder("stablePriceInput", `${symbols.stable} price (USD)`);

  setText("collateralActionsTitle", "Collateral In");
  setText("lendingActionsTitle", "Debt");
  setText("releaseActionsTitle", "Release");
  setText("riskPanelTitle", `Market Configuration (${destination.name})`);
  setText("liquidityPanelTitle", "Liquidity Management");
  setTooltip("openFlowInfo", `Move collateral into the lending side: lock on ${source.name}, then deposit ${symbols.wrapped} on ${destination.name}.`);
  setTooltip("debtFlowInfo", `Open or reduce debt on ${destination.name}. Borrow ${symbols.stable}, repay from wallet, or sell ${symbols.wrapped} collateral to reduce debt. Selling collateral lowers the amount you can later burn to unlock on ${source.name}.`);
  setTooltip("releaseFlowInfo", `After debt is cleared or reduced, withdraw ${symbols.wrapped} back to wallet and burn it on ${destination.name} to unlock ${symbols.collateral} on ${source.name}.`);
  setTooltip("closeWithCollateralInfo", `Sell ${symbols.wrapped} collateral to repay debt on ${destination.name}. This reduces the amount of wrapped collateral you can later burn to unlock ${symbols.collateral} on ${source.name}. Use Repay All if you want to preserve as much collateral as possible.`);
  setText("sellCollateralWarning", `Selling ${symbols.wrapped} to repay debt reduces how much ${symbols.collateral} you can later unlock on ${source.name}.`);
  setTooltip("bridgePanelInfo", "Main bridge queue: see what message is pending, how many validator attestations are in, and whether execute is ready.");
  setTooltip("termLtvInfo", "LTV = Loan-To-Value. How much debt is allowed compared to collateral value.");
  setTooltip("termHfInfo", "HF = Health Factor. Above 1.00 is safer; below 1.00 means liquidatable.");
  setTooltip("termPenaltyInfo", "Penalty is extra debt added when a loan is overdue.");
  setTooltip("termCloseFactorInfo", "Close Factor limits how much debt can be liquidated in one normal liquidation.");
  setText("termLtvText", "Borrow limit vs collateral value.");
  setText("termHfText", "Safety score of your position.");
  setText("termPenaltyText", "Extra debt added when overdue.");
  setText("termCloseFactorText", "Max debt chunk liquidated per normal liquidation.");
  setTooltip("ownerBridgeInfo", "Tracks pending bridge messages, validator attestations, and execution status for the active market.");
  setTooltip("riskPanelInfo", `Set market risk parameters and prices for the lending side on ${destination.name}.`);
  setTooltip("advancedRiskInfo", "Update one market parameter at a time without reapplying the full baseline.");
  setTooltip("liquidityPanelInfo", `Seed borrower collateral on ${source.name}, mint stable to the borrower on ${destination.name} for Repay All demos, or add stable liquidity to the pool on ${destination.name}.`);
  setTooltip("enforcePanelInfo", "Use admin actions to advance time, apply overdue penalty, or liquidate unsafe positions.");

  renderMarketSelectors();
}

async function loadConfig() {
  const res = await fetch("./multichain-addresses.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("multichain-addresses.json not found. Run deploy:multichain first.");
  }

  cfg = normalizeConfig(await res.json());
  if (!cfg.markets?.A_TO_B) {
    throw new Error("Config is missing markets.A_TO_B.");
  }

  const savedMarket = loadSavedMarket();
  if (savedMarket && cfg.markets[savedMarket]) {
    selectedMarketId = savedMarket;
  } else {
    selectedMarketId = cfg.markets.B_TO_A ? selectedMarketId : "A_TO_B";
  }

  renderStaticConfig();
  renderMarketLabels();
}

function sourceContracts(signerOrProvider) {
  const source = getSourceChain();
  return {
    collateral: new ethers.Contract(source.localCollateralToken, ABI.erc20, signerOrProvider),
    vault: new ethers.Contract(source.collateralVault, ABI.vault, signerOrProvider),
    unlockGateway: new ethers.Contract(source.unlockGateway, ABI.gateway, signerOrProvider),
  };
}

function isLocalDevChain(chain) {
  if (!chain) return false;
  const rpc = String(chain.rpc || "").toLowerCase();
  return (
    chain.chainId === 31337 ||
    chain.chainId === 31338 ||
    rpc.includes("127.0.0.1") ||
    rpc.includes("localhost")
  );
}

function chainContracts(chain, signerOrProvider) {
  return {
    collateral: new ethers.Contract(chain.localCollateralToken, ABI.erc20, signerOrProvider),
    vault: new ethers.Contract(chain.collateralVault, ABI.vault, signerOrProvider),
    wrapped: new ethers.Contract(chain.wrappedRemoteToken, ABI.wrapped, signerOrProvider),
    stable: new ethers.Contract(chain.stableToken, ABI.erc20, signerOrProvider),
    pool: new ethers.Contract(chain.lendingPool, ABI.pool, signerOrProvider),
  };
}

function destinationContracts(signerOrProvider) {
  const destination = getDestinationChain();
  return {
    wrapped: new ethers.Contract(destination.wrappedRemoteToken, ABI.wrapped, signerOrProvider),
    stable: new ethers.Contract(destination.stableToken, ABI.erc20, signerOrProvider),
    oracle: new ethers.Contract(destination.priceOracle, ABI.oracle, signerOrProvider),
    router: new ethers.Contract(destination.swapRouter, ABI.router, signerOrProvider),
    pool: new ethers.Contract(destination.lendingPool, ABI.pool, signerOrProvider),
    mintGateway: new ethers.Contract(destination.mintGateway, ABI.gateway, signerOrProvider),
  };
}

function getEventLogIndex(ev) {
  if (ev.logIndex !== undefined && ev.logIndex !== null) return BigInt(ev.logIndex);
  if (ev.index !== undefined && ev.index !== null) return BigInt(ev.index);
  return 0n;
}

async function findPendingEventForGateway(events, gateway, userArgName) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const user = ev.args[userArgName];
    const amount = ev.args.amount;
    const logIndex = getEventLogIndex(ev);
    const messageId = await gateway.computeMessageId(ev.transactionHash, logIndex, user, amount);
    if (await gateway.executed(messageId)) continue;

    const attestCount = await gateway.attestCount(messageId);
    return {
      txHash: ev.transactionHash,
      logIndex,
      user,
      amount,
      messageId,
      attestCount,
    };
  }

  return null;
}

function updateBridgeStatus(state) {
  setText("pendingLockMessage", state.pendingLockEvent ? short(state.pendingLockEvent.messageId) : "-");
  setText("pendingBurnMessage", state.pendingBurnEvent ? short(state.pendingBurnEvent.messageId) : "-");
  setText("pendingLockAttests", `${state.pendingLockAttestCount}/${state.destinationMintThreshold}`);
  setText("pendingBurnAttests", `${state.pendingBurnAttestCount}/${state.sourceUnlockThreshold}`);

  const lockReady = state.pendingLockEvent && state.pendingLockAttestCount >= state.destinationMintThreshold;
  const burnReady = state.pendingBurnEvent && state.pendingBurnAttestCount >= state.sourceUnlockThreshold;
  const hasLock = state.lockEvents > 0;
  const lockAttested = state.pendingLockEvent ? lockReady : state.mintEvents > 0;
  const mintExecuted = state.mintEvents > 0;
  const hasBurn = state.burnRequestEvents > 0;
  const burnAttested = state.pendingBurnEvent ? burnReady : state.unlockEvents > 0;
  const unlockExecuted = state.unlockEvents > 0;

  setText("pendingLockState", state.pendingLockEvent ? (lockReady ? "Ready for execute" : "Waiting attest") : "No pending lock");
  setText("pendingBurnState", state.pendingBurnEvent ? (burnReady ? "Ready for execute" : "Waiting attest") : "No pending burn");

  setClass("pendingLockState", "state-good", Boolean(lockReady));
  setClass("pendingLockState", "state-bad", Boolean(state.pendingLockEvent) && !lockReady);
  setClass("pendingBurnState", "state-good", Boolean(burnReady));
  setClass("pendingBurnState", "state-bad", Boolean(state.pendingBurnEvent) && !burnReady);

  setBridgeStep(
    "bridgeStepLock",
    "bridgeStepLockText",
    hasLock ? "done" : "active",
    hasLock ? `Detected (${state.lockEvents})` : "Waiting user lock tx"
  );
  setBridgeStep(
    "bridgeStepAttestLock",
    "bridgeStepAttestLockText",
    lockAttested ? "done" : hasLock ? "active" : "idle",
    `${state.pendingLockAttestCount}/${state.destinationMintThreshold} attestations`
  );
  setBridgeStep(
    "bridgeStepMint",
    "bridgeStepMintText",
    mintExecuted ? "done" : lockAttested ? "active" : "idle",
    mintExecuted ? `Minted (${state.mintEvents})` : lockAttested ? "Executor can mint now" : "Waiting lock attest"
  );
  setBridgeStep(
    "bridgeStepBurn",
    "bridgeStepBurnText",
    hasBurn ? "done" : mintExecuted ? "active" : "idle",
    hasBurn ? `Requested (${state.burnRequestEvents})` : mintExecuted ? "Waiting user burn request" : "Waiting mint first"
  );
  setBridgeStep(
    "bridgeStepAttestBurn",
    "bridgeStepAttestBurnText",
    burnAttested ? "done" : hasBurn ? "active" : "idle",
    `${state.pendingBurnAttestCount}/${state.sourceUnlockThreshold} attestations`
  );
  setBridgeStep(
    "bridgeStepUnlock",
    "bridgeStepUnlockText",
    unlockExecuted ? "done" : burnAttested ? "active" : "idle",
    unlockExecuted ? `Unlocked (${state.unlockEvents})` : burnAttested ? "Executor can unlock now" : "Waiting burn attest"
  );
}

function roleExpectedText(role) {
  if (role === "owner") return short(getOwnerAddress());
  if (role === "user") return short(getUserAddress());
  if (role === "validator") return (cfg.roles.validators || []).map(short).join(", ");
  return "Any";
}

function guardForUserAction(actionId, state) {
  if (!state) {
    if (["borrowBtn", "repayBtn", "repayMaxBtn", "repayAllBtn", "withdrawBtn", "withdrawMaxBtn", "requestBurnBtn", "burnMaxBtn"].includes(actionId)) {
      return { disabled: true, reason: "Refresh state to load current limits.", tone: "reason-bad" };
    }
    return null;
  }

  const symbols = state.symbols;
  if (actionId === "borrowBtn") {
    if (state.isOverdue) return { disabled: true, reason: "Cannot borrow: loan overdue.", tone: "reason-bad" };
    if (state.maxBorrow <= 0n) return { disabled: true, reason: `Cannot borrow: max borrow is 0 ${symbols.stable}.`, tone: "reason-bad" };
    if (state.poolLiquidity <= 0n) return { disabled: true, reason: `Cannot borrow: pool has no ${symbols.stable} liquidity.`, tone: "reason-bad" };
    return { disabled: false, reason: `Ready: max borrow ${fmtToken(state.maxBorrow)} ${symbols.stable}.`, tone: "reason-good" };
  }

  if (actionId === "repayBtn") {
    if (state.debt <= 0n) return { disabled: true, reason: "Cannot repay: no outstanding debt.", tone: "reason-bad" };
    if (state.userStable <= 0n) return { disabled: true, reason: `Cannot repay: wallet has 0 ${symbols.stable}.`, tone: "reason-bad" };
    return { disabled: false, reason: "Ready: enter exact amount in Advanced Repay.", tone: "reason-good" };
  }

  if (actionId === "repayMaxBtn") {
    if (state.debt <= 0n) return { disabled: true, reason: "Cannot repay: no outstanding debt.", tone: "reason-bad" };
    if (state.userStable <= 0n) return { disabled: true, reason: `Cannot repay: wallet has 0 ${symbols.stable}.`, tone: "reason-bad" };
    const amount = minBigInt(state.debt, state.userStable);
    return { disabled: false, reason: `Ready: repay wallet max up to ${fmtToken(amount)} ${symbols.stable}.`, tone: "reason-good" };
  }

  if (actionId === "repayAllBtn") {
    if (state.debt <= 0n) return { disabled: true, reason: "Cannot repay all: no outstanding debt.", tone: "reason-bad" };
    if (state.userStable < state.debt) {
      return {
        disabled: true,
        reason: `Cannot repay all: need ${fmtToken(state.debt)} ${symbols.stable}, wallet has ${fmtToken(state.userStable)}.`,
        tone: "reason-bad",
      };
    }
    return { disabled: false, reason: `Ready: repay full debt ${fmtToken(state.debt)} ${symbols.stable}.`, tone: "reason-good" };
  }

  if (actionId === "withdrawBtn" || actionId === "withdrawMaxBtn") {
    if (state.isOverdue) return { disabled: true, reason: "Cannot withdraw: loan overdue.", tone: "reason-bad" };
    if (state.positionCollateral <= 0n) return { disabled: true, reason: `Cannot withdraw: no ${symbols.wrapped} in pool.`, tone: "reason-bad" };
    if (state.maxWithdraw <= 0n) return { disabled: true, reason: `Cannot withdraw: max safe withdraw is 0 ${symbols.wrapped}.`, tone: "reason-bad" };
    return { disabled: false, reason: `Ready: max safe withdraw ${fmtToken(state.maxWithdraw)} ${symbols.wrapped}.`, tone: "reason-good" };
  }

  if (actionId === "requestBurnBtn" || actionId === "burnMaxBtn") {
    if (state.debt > 0n) return { disabled: true, reason: `Cannot burn: repay ${symbols.stable} debt first.`, tone: "reason-bad" };
    if (state.userWrapped <= 0n) return { disabled: true, reason: `Cannot burn: wallet has 0 ${symbols.wrapped}.`, tone: "reason-bad" };
    if (state.pendingBurnEvent && state.pendingBurnAttestCount < state.sourceUnlockThreshold) {
      return {
        disabled: true,
        reason: `Cannot burn now: bridge burn already queued (${state.pendingBurnAttestCount}/${state.sourceUnlockThreshold} attests).`,
        tone: "reason-bad",
      };
    }
    return { disabled: false, reason: `Ready: burn up to ${fmtToken(state.userWrapped)} ${symbols.wrapped}.`, tone: "reason-good" };
  }

  return null;
}

function pickReasonFromButtons(buttonIds) {
  let fallback = null;

  for (const id of buttonIds) {
    const btn = $(id);
    if (!btn) continue;

    const reason = btn.dataset.guardReason || (btn.disabled ? "Action unavailable." : "Ready.");
    const tone = btn.dataset.guardTone || (btn.disabled ? "reason-bad" : "reason-good");
    if (!fallback) fallback = { reason, tone };
    if (!btn.disabled) {
      return { reason, tone: "reason-good" };
    }
  }

  return fallback || { reason: "-", tone: "" };
}

function renderPrimaryActionReasons() {
  const borrow = pickReasonFromButtons(["borrowBtn"]);
  const repay = pickReasonFromButtons(["repayAllBtn", "repayMaxBtn", "repayBtn"]);
  const withdraw = pickReasonFromButtons(["withdrawMaxBtn", "withdrawBtn"]);
  const burn = pickReasonFromButtons(["burnMaxBtn", "requestBurnBtn"]);

  setActionReason("borrowBtnReason", borrow.reason, borrow.tone);
  setActionReason("repayBtnReason", repay.reason, repay.tone);
  setActionReason("withdrawBtnReason", withdraw.reason, withdraw.tone);
  setActionReason("burnBtnReason", burn.reason, burn.tone);
}

function updateActionGuards() {
  const role = currentRole();
  setText("roleText", roleText(role));

  for (const [id, meta] of Object.entries(ACTION_META)) {
    const btn = $(id);
    if (!btn) continue;

    const expectedChain = getChainConfig(meta.chain);
    const roleOk = meta.role === "any" || role === meta.role;
    const busy = busyActions.has(id);
    let disabled = !ctx || !roleOk || busy;
    let reason = "";
    let tone = "";

    if (!ctx) {
      reason = "Connect wallet to continue.";
      tone = "reason-bad";
    } else if (!roleOk) {
      reason = `Only ${roleText(meta.role)} can run this action.`;
      tone = "reason-bad";
    } else if (busy) {
      reason = "Action pending confirmation...";
      tone = "reason-bad";
    }

    if (!disabled && role === "user") {
      const stateGuard = guardForUserAction(id, latestState);
      if (stateGuard) {
        disabled = stateGuard.disabled;
        reason = stateGuard.reason;
        tone = stateGuard.tone;
      }
    }

    if (!reason) {
      reason = disabled ? "Action unavailable." : "Ready.";
    }
    if (!tone) {
      tone = disabled ? "reason-bad" : "reason-good";
    }

    const chainMismatch = ctx ? Number(ctx.chainId) !== Number(expectedChain.chainId) : false;
    if (!disabled && chainMismatch) {
      reason = `${reason} Wallet will auto-switch to ${expectedChain.name}.`;
    }

    btn.disabled = disabled;
    btn.dataset.guardReason = reason;
    btn.dataset.guardTone = tone;

    btn.title = `Expected role: ${roleText(meta.role)} (${roleExpectedText(meta.role)}) | Expected chain: ${expectedChain.name} (${expectedChain.chainId})`;
  }

  renderPrimaryActionReasons();
}

function nextActionInfo(state) {
  const market = getMarketConfig();
  const source = getSourceChain();
  const destination = getDestinationChain();
  const symbols = market.symbols;

  if (!state) {
    return {
      buttonId: null,
      text: "Connect wallet and refresh state.",
      hint: "The dashboard needs on-chain state first.",
    };
  }

  if (state.userCollateral === 0n) {
    return {
      buttonId: "mintCollateralToUserBtn",
      text: `Owner should mint ${symbols.collateral} to user on ${source.name}.`,
      hint: `Use owner ${short(getOwnerAddress())} on ${source.name} (${source.chainId}).`,
    };
  }

  if (state.poolLiquidity === 0n) {
    return {
      buttonId: "mintStableToPoolBtn",
      text: `Owner should mint ${symbols.stable} liquidity to pool on ${destination.name}.`,
      hint: `Use owner ${short(getOwnerAddress())} on ${destination.name} (${destination.chainId}).`,
    };
  }

  if (state.locked === 0n) {
    return {
      buttonId: "lockBtn",
      text: `User should lock ${symbols.collateral} on ${source.name}.`,
      hint: `Use user ${short(getUserAddress())} on ${source.name} (${source.chainId}).`,
    };
  }

  if (state.userWrapped === 0n && state.positionCollateral === 0n) {
    if (state.pendingLockEvent) {
      if (state.pendingLockAttestCount < state.destinationMintThreshold) {
        return {
          buttonId: null,
          text: `Waiting validators to attest ${market.id} lock event.`,
          hint: `Current attestations ${state.pendingLockAttestCount}/${state.destinationMintThreshold}.`,
        };
      }

      return {
        buttonId: null,
        text: `Attest threshold reached; executor should mint ${symbols.wrapped} soon.`,
        hint: `Current attestations ${state.pendingLockAttestCount}/${state.destinationMintThreshold}.`,
      };
    }

    return {
      buttonId: null,
      text: "No lock event detected yet.",
      hint: `Run lock action on ${source.name} first.`,
    };
  }

  if (state.positionCollateral === 0n && state.userWrapped > 0n && state.borrowEvents === 0) {
    return {
      buttonId: "depositBtn",
      text: `User should deposit ${symbols.wrapped} into pool on ${destination.name}.`,
      hint: `Use user ${short(getUserAddress())} on ${destination.name} (${destination.chainId}).`,
    };
  }

  if (state.debt === 0n && state.borrowEvents === 0) {
    return {
      buttonId: "borrowBtn",
      text: `User can borrow ${symbols.stable}.`,
      hint: `Current max borrow: ${fmtToken(state.maxBorrow)} ${symbols.stable}.`,
    };
  }

  if (state.debt > 0n) {
    if (state.healthFactor !== ethers.MaxUint256 && state.healthFactor < 10_000n) {
      return {
        buttonId: "liquidateBtn",
        text: "Position is unsafe (health factor < 1). Liquidation is enabled.",
        hint: "Liquidator can repay debt and seize collateral.",
      };
    }

    if (state.isOverdue) {
      if (!state.overduePenaltyApplied && state.overduePenaltyBps > 0n) {
        return {
          buttonId: "applyPenaltyBtn",
          text: "Loan is overdue; apply penalty before liquidation.",
          hint: `Penalty: ${fmtPctBps(state.overduePenaltyBps)}.`,
        };
      }

      return {
        buttonId: "liquidateBtn",
        text: "Loan is overdue; liquidation path is available.",
        hint: "Liquidator repays debt and receives collateral with bonus.",
      };
    }

    if (state.userStable >= state.debt) {
      return {
        buttonId: "repayAllBtn",
        text: `User can fully repay ${symbols.stable} from wallet.`,
        hint: `Exact debt: ${exactTokenString(state.debt)} ${symbols.stable}.`,
      };
    }

    if (state.positionCollateral > 0n) {
      return {
        buttonId: "closeWithCollateralBtn",
        text: `Wallet stable is insufficient; close debt by selling some ${symbols.wrapped}.`,
        hint: `Current debt ${exactTokenString(state.debt)} ${symbols.stable}, wallet balance ${exactTokenString(state.userStable)} ${symbols.stable}.`,
      };
    }

    return {
      buttonId: "repayAllBtn",
      text: `User should clear debt before full withdrawal.`,
      hint: `Debt breakdown: principal ${fmtToken(state.principalDebt)}, interest ${fmtToken(state.accruedInterest)}, penalty ${fmtToken(state.penaltyAmount)} ${symbols.stable}.`,
    };
  }

  if (state.lockedResidual > 0n && state.userWrapped === 0n && state.positionCollateral === 0n) {
    if (state.liquidationEvents > 0) {
      return {
        buttonId: null,
        text: `Debt is closed, but some ${symbols.collateral} remains locked as backing for collateral seized in liquidation.`,
        hint: "That locked amount is no longer controlled by this borrower.",
      };
    }

    if (state.repaidWithCollateralEvents > 0) {
      return {
        buttonId: null,
        text: `Debt is closed, but some ${symbols.collateral} remains locked as backing for collateral sold to repay debt.`,
        hint: "That locked amount is no longer controlled by this borrower.",
      };
    }
  }

  if (state.positionCollateral > 0n) {
    return {
      buttonId: "withdrawMaxBtn",
      text: `User can withdraw ${symbols.wrapped} from pool.`,
      hint: `Current pool collateral: ${fmtToken(state.positionCollateral)} ${symbols.wrapped}.`,
    };
  }

  if (state.userWrapped > 0n && state.positionCollateral === 0n && state.debt === 0n) {
    if (state.burnRequestEvents === 0) {
      return {
        buttonId: "burnMaxBtn",
        text: `User should burn ${symbols.wrapped} on ${destination.name}.`,
        hint: `Use user ${short(getUserAddress())} on ${destination.name} (${destination.chainId}).`,
      };
    }

    if (state.pendingBurnEvent) {
      if (state.pendingBurnAttestCount < state.sourceUnlockThreshold) {
        return {
          buttonId: null,
          text: `Waiting validators to attest ${market.id} burn event.`,
          hint: `Current attestations ${state.pendingBurnAttestCount}/${state.sourceUnlockThreshold}.`,
        };
      }

      return {
        buttonId: null,
        text: `Attest threshold reached; executor should unlock ${symbols.collateral} on ${source.name}.`,
        hint: `Current attestations ${state.pendingBurnAttestCount}/${state.sourceUnlockThreshold}.`,
      };
    }
  }

  if (state.locked === 0n && state.unlockEvents > 0 && state.burnRequestEvents > 0) {
    return {
      buttonId: null,
      text: `Cycle completed: ${symbols.collateral} unlocked back to user on ${source.name}.`,
      hint: "You can start a new cycle with another market or another amount.",
    };
  }

  return {
    buttonId: null,
    text: "No next action inferred.",
    hint: "Refresh state to sync latest events.",
  };
}

function positionStatusInfo(state) {
  if (!state) {
    return { text: "Awaiting State", variant: "status-info" };
  }

  if (state.debt === 0n && state.lockedResidual > 0n && state.userReleasableLocked === 0n) {
    if (state.liquidationEvents > 0) {
      return { text: "Settled By Liquidation", variant: "status-caution" };
    }
    if (state.repaidWithCollateralEvents > 0) {
      return { text: "Settled By Collateral Sale", variant: "status-caution" };
    }
    return { text: "Residual Backing", variant: "status-caution" };
  }

  if (state.isOverdue) {
    return { text: "Overdue", variant: "status-risk" };
  }

  if (state.healthFactor !== ethers.MaxUint256 && state.healthFactor < 10_000n) {
    return { text: "Unsafe", variant: "status-risk" };
  }

  if (state.debt > 0n && state.userStable < state.debt) {
    return { text: "Shortfall", variant: "status-caution" };
  }

  if (state.debt > 0n) {
    return { text: "Active Debt", variant: "status-caution" };
  }

  if (state.positionCollateral > 0n) {
    return { text: "Ready To Exit", variant: "status-safe" };
  }

  if (state.userWrapped > 0n) {
    return { text: "Ready To Deposit", variant: "status-info" };
  }

  if (state.locked > 0n) {
    return { text: "Bridge In Flight", variant: "status-info" };
  }

  return { text: "No Debt", variant: "status-safe" };
}

function updateNextActionGuide(state) {
  const info = nextActionInfo(state);
  const nextActionText = $("nextActionText");
  const nextActionHint = $("nextActionHint");
  const summaryNextAction = $("summaryNextAction");
  const summaryNextHint = $("summaryNextHint");
  const applySummary = (text, hint) => {
    if (summaryNextAction) summaryNextAction.textContent = text;
    if (summaryNextHint) summaryNextHint.textContent = hint;
  };

  if (!nextActionText || !nextActionHint) return;

  if (!info.buttonId) {
    nextActionText.textContent = info.text;
    nextActionHint.textContent = info.hint;
    applySummary(info.text, info.hint);
    setRecommendedButton(null);
    return;
  }

  const actionMeta = ACTION_META[info.buttonId];
  if (!actionMeta) {
    nextActionText.textContent = info.text;
    nextActionHint.textContent = info.hint;
    applySummary(info.text, info.hint);
    setRecommendedButton(null);
    return;
  }

  if (portalType === "owner" && actionMeta.role === "user") {
    nextActionText.textContent = `${info.text} (Switch to User Portal)`;
    nextActionHint.textContent = "This step belongs to borrower flow.";
    applySummary(`${info.text} (Switch to User Portal)`, "This step belongs to borrower flow.");
    setRecommendedButton(null);
    return;
  }

  if (portalType === "user" && actionMeta.role === "owner") {
    nextActionText.textContent = `${info.text} (Switch to Owner Portal)`;
    nextActionHint.textContent = "This step belongs to admin/risk flow.";
    applySummary(`${info.text} (Switch to Owner Portal)`, "This step belongs to admin/risk flow.");
    setRecommendedButton(null);
    return;
  }

  nextActionText.textContent = info.text;
  nextActionHint.textContent = info.hint;
  applySummary(info.text, info.hint);
  setRecommendedButton(info.buttonId);
}

function renderState(state) {
  const symbols = state.symbols;
  const shortfall = state.debt > state.userStable ? state.debt - state.userStable : 0n;
  const userReleasableLocked = state.userReleasableLocked;
  const lockedResidual = state.lockedResidual;

  setText("global-a-collateral-wallet", fmtToken(state.globalAssets.A.collateralWallet));
  setText("global-a-collateral-locked", fmtToken(state.globalAssets.A.collateralLocked));
  setText("global-a-wrapped-wallet", fmtToken(state.globalAssets.A.wrappedWallet));
  setText("global-a-wrapped-pool", fmtToken(state.globalAssets.A.wrappedInPool));
  setText("global-a-stable-wallet", fmtToken(state.globalAssets.A.stableWallet));
  setText("global-b-collateral-wallet", fmtToken(state.globalAssets.B.collateralWallet));
  setText("global-b-collateral-locked", fmtToken(state.globalAssets.B.collateralLocked));
  setText("global-b-wrapped-wallet", fmtToken(state.globalAssets.B.wrappedWallet));
  setText("global-b-wrapped-pool", fmtToken(state.globalAssets.B.wrappedInPool));
  setText("global-b-stable-wallet", fmtToken(state.globalAssets.B.stableWallet));

  setTitle("global-a-collateral-wallet", `${exactTokenString(state.globalAssets.A.collateralWallet)} ${cfg.chains.A.symbols.collateral}`);
  setTitle("global-a-collateral-locked", `${exactTokenString(state.globalAssets.A.collateralLocked)} ${cfg.chains.A.symbols.collateral}`);
  setTitle("global-a-wrapped-wallet", `${exactTokenString(state.globalAssets.A.wrappedWallet)} ${cfg.chains.A.symbols.wrapped}`);
  setTitle("global-a-wrapped-pool", `${exactTokenString(state.globalAssets.A.wrappedInPool)} ${cfg.chains.A.symbols.wrapped}`);
  setTitle("global-a-stable-wallet", `${exactTokenString(state.globalAssets.A.stableWallet)} ${cfg.chains.A.symbols.stable}`);
  setTitle("global-b-collateral-wallet", `${exactTokenString(state.globalAssets.B.collateralWallet)} ${cfg.chains.B.symbols.collateral}`);
  setTitle("global-b-collateral-locked", `${exactTokenString(state.globalAssets.B.collateralLocked)} ${cfg.chains.B.symbols.collateral}`);
  setTitle("global-b-wrapped-wallet", `${exactTokenString(state.globalAssets.B.wrappedWallet)} ${cfg.chains.B.symbols.wrapped}`);
  setTitle("global-b-wrapped-pool", `${exactTokenString(state.globalAssets.B.wrappedInPool)} ${cfg.chains.B.symbols.wrapped}`);
  setTitle("global-b-stable-wallet", `${exactTokenString(state.globalAssets.B.stableWallet)} ${cfg.chains.B.symbols.stable}`);

  setText("a-user-balance", fmtToken(state.userCollateral));
  setText("a-locked", fmtToken(state.locked));
  setText("b-user-wrapped", fmtToken(state.userWrapped));
  setText("b-user-stable", fmtToken(state.userStable));
  setText("pos-collateral", fmtToken(state.positionCollateral));
  setText("pos-debt", fmtToken(state.debt, { decimals: 4, tinyLabel: true, floor: true }));
  setText("pos-max-borrow", fmtToken(state.maxBorrow));
  setText("owner-debt-card", fmtToken(state.debt, { decimals: 4, tinyLabel: true, floor: true }));
  setText("owner-principal-card", fmtToken(state.principalDebt, { decimals: 4, tinyLabel: true, floor: true }));
  setText("owner-interest-card", fmtToken(state.accruedInterest, { decimals: 4, tinyLabel: true, floor: true }));
  setText("owner-penalty-card", fmtToken(state.penaltyAmount, { decimals: 4, tinyLabel: true, floor: true }));
  setText("owner-max-withdraw-card", fmtToken(state.maxWithdraw, { decimals: 4, tinyLabel: false, floor: true }));
  setText("pos-debt-exact", `${exactTokenString(state.debt)} ${symbols.stable}`);
  setText("pos-max-withdraw-exact", `${exactTokenString(state.maxWithdraw)} ${symbols.wrapped}`);
  setTitle("pos-debt", `${exactTokenString(state.debt)} ${symbols.stable}`);
  setText("pool-liquidity", fmtToken(state.poolLiquidity));
  setText("pool-apr", fmtPctBps(state.borrowRateBps));
  setText("pool-utilization", fmtPctBps(state.utilizationBps));

  const hfText = state.healthFactor === ethers.MaxUint256 ? "INF" : (Number(state.healthFactor) / 10000).toFixed(4);
  setText("pos-health-factor", hfText);
  setText("owner-health-card", hfText);

  const dueText = state.dueTimestamp > 0n ? new Date(Number(state.dueTimestamp) * 1000).toLocaleString() : "No active loan";
  setText("pos-due-time", dueText);
  setText("pos-overdue", state.isOverdue ? "YES" : "NO");
  setText("pos-penalty", state.overduePenaltyApplied ? "YES" : "NO");
  setText("summaryDebt", fmtToken(state.debt, { decimals: 4, tinyLabel: true, floor: true }));
  setText("summaryInterest", fmtToken(state.accruedInterest, { decimals: 4, tinyLabel: true, floor: true }));
  setText("summaryPenalty", fmtToken(state.penaltyAmount, { decimals: 4, tinyLabel: true, floor: true }));
  setText("summaryHealth", hfText);
  setText("summaryMaxWithdraw", fmtToken(state.maxWithdraw, { decimals: 4, tinyLabel: false, floor: true }));
  setText("summaryShortfall", shortfall > 0n ? fmtToken(shortfall, { decimals: 4, tinyLabel: true, floor: true }) : `0.0000`);
  setText("debtCardTotal", fmtToken(state.debt, { decimals: 4, tinyLabel: true, floor: true }));
  setText("debtCardWalletStable", fmtToken(state.userStable, { decimals: 4, tinyLabel: true, floor: true }));
  setText("debtCardShortfall", shortfall > 0n ? fmtToken(shortfall, { decimals: 4, tinyLabel: true, floor: true }) : `0.0000`);
  setText("debtCardInterest", fmtToken(state.accruedInterest, { decimals: 4, tinyLabel: true, floor: true }));
  setText("debtCardPenalty", fmtToken(state.penaltyAmount, { decimals: 4, tinyLabel: true, floor: true }));
  setText("debtCardDue", dueText);
  setText("userReleasableLocked", fmtToken(userReleasableLocked, { decimals: 4, tinyLabel: false, floor: true }));
  setText("lockedResidualBacking", fmtToken(lockedResidual, { decimals: 4, tinyLabel: false, floor: true }));

  setTitle("summaryDebt", `${exactTokenString(state.debt)} ${symbols.stable}`);
  setTitle("summaryInterest", `${exactTokenString(state.accruedInterest)} ${symbols.stable}`);
  setTitle("summaryPenalty", `${exactTokenString(state.penaltyAmount)} ${symbols.stable}`);
  setTitle("summaryMaxWithdraw", `${exactTokenString(state.maxWithdraw)} ${symbols.wrapped}`);
  setTitle("summaryShortfall", `${exactTokenString(shortfall)} ${symbols.stable}`);
  setTitle("debtCardTotal", `${exactTokenString(state.debt)} ${symbols.stable}`);
  setTitle("debtCardWalletStable", `${exactTokenString(state.userStable)} ${symbols.stable}`);
  setTitle("debtCardShortfall", `${exactTokenString(shortfall)} ${symbols.stable}`);
  setTitle("owner-debt-card", `${exactTokenString(state.debt)} ${symbols.stable}`);
  setTitle("owner-principal-card", `${exactTokenString(state.principalDebt)} ${symbols.stable}`);
  setTitle("owner-interest-card", `${exactTokenString(state.accruedInterest)} ${symbols.stable}`);
  setTitle("owner-penalty-card", `${exactTokenString(state.penaltyAmount)} ${symbols.stable}`);
  setTitle("owner-max-withdraw-card", `${exactTokenString(state.maxWithdraw)} ${symbols.wrapped}`);
  setTitle("userReleasableLocked", `${exactTokenString(userReleasableLocked)} ${symbols.collateral}`);
  setTitle("lockedResidualBacking", `${exactTokenString(lockedResidual)} ${symbols.collateral}`);

  const status = positionStatusInfo(state);
  setStatusChip("positionStatusChip", status.text, status.variant);

  const collateralActive = state.userWrapped === 0n && state.positionCollateral === 0n && state.debt === 0n;
  const debtActive = state.positionCollateral > 0n || state.debt > 0n;
  const releaseActive = state.debt === 0n && (state.positionCollateral > 0n || state.userWrapped > 0n);

  setClass("collateralControlsCard", "is-active", collateralActive);
  setClass("collateralControlsCard", "is-muted", !collateralActive && (debtActive || releaseActive));
  setClass("debtControlsCard", "is-active", debtActive);
  setClass("debtControlsCard", "is-muted", !debtActive && releaseActive);
  setClass("releaseControlsCard", "is-active", releaseActive);
  setClass("releaseControlsCard", "is-muted", !releaseActive && debtActive);

  setClass("pos-health-factor", "state-bad", state.healthFactor !== ethers.MaxUint256 && state.healthFactor < 10_000n);
  setClass("pos-health-factor", "state-good", state.healthFactor === ethers.MaxUint256 || state.healthFactor >= 10_000n);
  setClass("pos-overdue", "state-bad", state.isOverdue);
  setClass("pos-overdue", "state-good", !state.isOverdue);

  setTooltip(
    "riskPanelInfo",
    `Max debt USD = collateral USD x ${state.factor} / 10000 (${(Number(state.factor) / 100).toFixed(2)}%) | CollateralUSD=${fmtUsdWad(state.collateralValueUsd)} | DebtUSD=${fmtUsdWad(state.debtValueUsd)}`
  );
  setTooltip(
    "advancedRiskInfo",
    `LoanDuration: ${(Number(state.loanDuration) / 3600).toFixed(2)}h | Penalty: ${fmtPctBps(state.overduePenaltyBps)} | Bonus: ${fmtPctBps(state.liquidationBonusBps)} | Close factor: ${fmtPctBps(state.closeFactorBps)} | Liq threshold: ${fmtPctBps(state.liquidationThresholdBps)} | Router fee: ${fmtPctBps(state.routerFeeBps)} | ${symbols.wrapped}: ${(Number(state.collateralPriceE8) / ORACLE_DECIMALS).toFixed(4)} USD | ${symbols.stable}: ${(Number(state.stablePriceE8) / ORACLE_DECIMALS).toFixed(4)} USD`
  );
  setTooltip(
    "termLtvInfo",
    `LTV (Loan-To-Value) is your borrow limit. Here: ${(Number(state.factor) / 100).toFixed(2)}%. If your debt tries to go above this limit, borrow/withdraw will be blocked.`
  );
  setTooltip(
    "termHfInfo",
    `HF (Health Factor) is a safety score. Around ${(state.healthFactor === ethers.MaxUint256 ? "INF" : (Number(state.healthFactor) / 10000).toFixed(4))} now. Below 1.00 means unsafe and liquidation can happen.`
  );
  setTooltip(
    "termPenaltyInfo",
    `Penalty is extra debt added once overdue. Current penalty rate is ${fmtPctBps(state.overduePenaltyBps)} and current penalty amount is ${fmtToken(state.penaltyAmount)} ${symbols.stable}.`
  );
  setTooltip(
    "termCloseFactorInfo",
    `Close Factor limits how much debt a liquidator can repay in one non-overdue liquidation. Current close factor is ${fmtPctBps(state.closeFactorBps)}.`
  );
  setText("termLtvText", `Current limit: ${fmtPctBps(state.factor)}. Borrow/withdraw is blocked if this limit is exceeded.`);
  setText(
    "termHfText",
    `Current HF: ${state.healthFactor === ethers.MaxUint256 ? "INF" : (Number(state.healthFactor) / 10000).toFixed(4)}. Below 1.00 is unsafe.`
  );
  setText("termPenaltyText", `Penalty rate: ${fmtPctBps(state.overduePenaltyBps)}. Current penalty debt: ${fmtToken(state.penaltyAmount)} ${symbols.stable}.`);
  setText("termCloseFactorText", `Current close factor: ${fmtPctBps(state.closeFactorBps)} per non-overdue liquidation.`);

  let sourceBackingHint = `Unlocked ${symbols.collateral} in wallet is directly spendable on ${state.sourceName}.`;
  let destinationBackingHint = `${symbols.wrapped} in wallet or pool is still user-controlled on ${state.destinationName}.`;
  let outcomeTitle = "Ownership & Release";
  let outcomeHint = "The borrower can only release source collateral that is still backed by wrapped collateral they control.";

  if (state.locked === 0n) {
    sourceBackingHint = `No ${symbols.collateral} remains locked on ${state.sourceName}.`;
  } else if (userReleasableLocked > 0n) {
    sourceBackingHint = `Up to ${fmtToken(userReleasableLocked, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.collateral} can still be released by withdrawing/burning borrower-controlled ${symbols.wrapped}.`;
  }

  if (state.positionCollateral === 0n && state.userWrapped === 0n) {
    destinationBackingHint = `Borrower no longer controls any ${symbols.wrapped} on ${state.destinationName}.`;
  } else if (state.positionCollateral > 0n) {
    destinationBackingHint = `${fmtToken(state.positionCollateral, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.wrapped} remains in pool and can still be withdrawn.`;
  } else if (state.userWrapped > 0n) {
    destinationBackingHint = `${fmtToken(state.userWrapped, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.wrapped} remains in wallet and can be burned to unlock source collateral.`;
  }

  if (lockedResidual > 0n) {
    if (state.liquidationEvents > 0 && state.debt === 0n && state.userWrapped === 0n && state.positionCollateral === 0n) {
      outcomeTitle = "Settled By Liquidation";
      outcomeHint = `Debt is cleared, but ${fmtToken(lockedResidual, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.collateral} remains locked as backing for collateral seized during liquidation. It is no longer withdrawable by this borrower.`;
    } else if (state.repaidWithCollateralEvents > 0 && state.debt === 0n && state.userWrapped === 0n && state.positionCollateral === 0n) {
      outcomeTitle = "Settled By Collateral Sale";
      outcomeHint = `Debt is cleared, but ${fmtToken(lockedResidual, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.collateral} remains locked as backing for wrapped collateral sold to repay debt. It is no longer withdrawable by this borrower.`;
    } else {
      outcomeHint = `${fmtToken(lockedResidual, { decimals: 4, tinyLabel: false, floor: true })} ${symbols.collateral} remains locked as bridge backing not currently controlled by this borrower.`;
    }
  } else if (state.locked > 0n && userReleasableLocked > 0n) {
    outcomeHint = `All currently locked ${symbols.collateral} is still traceable to borrower-controlled ${symbols.wrapped} and can be released by withdraw/burn actions.`;
  } else if (state.debt === 0n && state.locked === 0n) {
    outcomeHint = `Debt is cleared and no source collateral remains locked for this market.`;
  }

  setText("sourceBackingHint", sourceBackingHint);
  setText("destinationBackingHint", destinationBackingHint);
  setText("outcomeTitle", outcomeTitle);
  setText("outcomeHint", outcomeHint);

  updateBridgeStatus(state);
  updateNextActionGuide(state);
}

async function refreshState() {
  if (!cfg) return;

  try {
    const market = getMarketConfig();
    const source = getSourceChain();
    const destination = getDestinationChain();
    const chainA = cfg.chains.A;
    const chainB = cfg.chains.B;
    const providerSource = new ethers.JsonRpcProvider(source.rpc);
    const providerDestination = new ethers.JsonRpcProvider(destination.rpc);
    const providerA = new ethers.JsonRpcProvider(chainA.rpc);
    const providerB = new ethers.JsonRpcProvider(chainB.rpc);

    await Promise.all([
      ensureContractDeployed(providerSource, source.localCollateralToken, `${source.name} local collateral token`),
      ensureContractDeployed(providerSource, source.collateralVault, `${source.name} collateral vault`),
      ensureContractDeployed(providerSource, source.unlockGateway, `${source.name} unlock gateway`),
      ensureContractDeployed(providerDestination, destination.wrappedRemoteToken, `${destination.name} wrapped token`),
      ensureContractDeployed(providerDestination, destination.stableToken, `${destination.name} stable token`),
      ensureContractDeployed(providerDestination, destination.lendingPool, `${destination.name} lending pool`),
      ensureContractDeployed(providerDestination, destination.priceOracle, `${destination.name} price oracle`),
      ensureContractDeployed(providerDestination, destination.swapRouter, `${destination.name} swap router`),
      ensureContractDeployed(providerDestination, destination.mintGateway, `${destination.name} mint gateway`),
      ensureContractDeployed(providerA, chainA.localCollateralToken, `${chainA.name} local collateral token`),
      ensureContractDeployed(providerA, chainA.collateralVault, `${chainA.name} collateral vault`),
      ensureContractDeployed(providerA, chainA.wrappedRemoteToken, `${chainA.name} wrapped token`),
      ensureContractDeployed(providerA, chainA.stableToken, `${chainA.name} stable token`),
      ensureContractDeployed(providerA, chainA.lendingPool, `${chainA.name} lending pool`),
      ensureContractDeployed(providerB, chainB.localCollateralToken, `${chainB.name} local collateral token`),
      ensureContractDeployed(providerB, chainB.collateralVault, `${chainB.name} collateral vault`),
      ensureContractDeployed(providerB, chainB.wrappedRemoteToken, `${chainB.name} wrapped token`),
      ensureContractDeployed(providerB, chainB.stableToken, `${chainB.name} stable token`),
      ensureContractDeployed(providerB, chainB.lendingPool, `${chainB.name} lending pool`),
    ]);

    const sourceRead = sourceContracts(providerSource);
    const destinationRead = destinationContracts(providerDestination);
    const chainARead = chainContracts(chainA, providerA);
    const chainBRead = chainContracts(chainB, providerB);

    const [
      userCollateral,
      locked,
      userWrapped,
      userStable,
      poolLiquidity,
      position,
      debtBreakdown,
      maxBorrow,
      maxWithdraw,
      healthFactor,
      utilizationBps,
      borrowRateBps,
      collateralValueUsd,
      debtValueUsd,
      factor,
      liquidationThresholdBps,
      closeFactorBps,
      loanDuration,
      overduePenaltyBps,
      liquidationBonusBps,
      isOverdue,
      collateralPriceE8,
      stablePriceE8,
      routerFeeBps,
      sourceUnlockThreshold,
      destinationMintThreshold,
      lockEvents,
      unlockEvents,
      mintEvents,
      burnRequestEvents,
      borrowEvents,
      repayEvents,
      liquidationEvents,
      repaidWithCollateralEvents,
      chainACollateralWallet,
      chainACollateralLocked,
      chainAWrappedWallet,
      chainAWrappedPosition,
      chainAStableWallet,
      chainBCollateralWallet,
      chainBCollateralLocked,
      chainBWrappedWallet,
      chainBWrappedPosition,
      chainBStableWallet,
    ] = await Promise.all([
      sourceRead.collateral.balanceOf(getUserAddress()),
      sourceRead.vault.lockedBalance(getUserAddress()),
      destinationRead.wrapped.balanceOf(getUserAddress()),
      destinationRead.stable.balanceOf(getUserAddress()),
      destinationRead.stable.balanceOf(destination.lendingPool),
      destinationRead.pool.positions(getUserAddress()),
      destinationRead.pool.debtBreakdown(getUserAddress()),
      destinationRead.pool.maxBorrowable(getUserAddress()),
      destinationRead.pool.maxWithdrawable(getUserAddress()),
      destinationRead.pool.healthFactorBps(getUserAddress()),
      destinationRead.pool.utilizationBps(),
      destinationRead.pool.borrowRateBps(),
      destinationRead.pool.collateralValueUsd(getUserAddress()),
      destinationRead.pool.debtValueUsd(getUserAddress()),
      destinationRead.pool.collateralFactorBps(),
      destinationRead.pool.liquidationThresholdBps(),
      destinationRead.pool.closeFactorBps(),
      destinationRead.pool.loanDuration(),
      destinationRead.pool.overduePenaltyBps(),
      destinationRead.pool.liquidationBonusBps(),
      destinationRead.pool.isOverdue(getUserAddress()),
      destinationRead.oracle.getPrice(destination.wrappedRemoteToken),
      destinationRead.oracle.getPrice(destination.stableToken),
      destinationRead.router.feeBps(),
      sourceRead.unlockGateway.threshold(),
      destinationRead.mintGateway.threshold(),
      sourceRead.vault.queryFilter(sourceRead.vault.filters.Locked(getUserAddress()), 0, "latest"),
      sourceRead.vault.queryFilter(sourceRead.vault.filters.UnlockedFromBurn(getUserAddress()), 0, "latest"),
      destinationRead.wrapped.queryFilter(destinationRead.wrapped.filters.BridgeMintedFromLock(getUserAddress()), 0, "latest"),
      destinationRead.mintGateway.queryFilter(destinationRead.mintGateway.filters.BurnRequested(getUserAddress()), 0, "latest"),
      destinationRead.pool.queryFilter(destinationRead.pool.filters.Borrowed(getUserAddress()), 0, "latest"),
      destinationRead.pool.queryFilter(destinationRead.pool.filters.Repaid(getUserAddress()), 0, "latest"),
      destinationRead.pool.queryFilter(destinationRead.pool.filters.Liquidated(getUserAddress()), 0, "latest"),
      destinationRead.pool.queryFilter(destinationRead.pool.filters.RepaidWithCollateral(getUserAddress()), 0, "latest"),
      chainARead.collateral.balanceOf(getUserAddress()),
      chainARead.vault.lockedBalance(getUserAddress()),
      chainARead.wrapped.balanceOf(getUserAddress()),
      chainARead.pool.positions(getUserAddress()),
      chainARead.stable.balanceOf(getUserAddress()),
      chainBRead.collateral.balanceOf(getUserAddress()),
      chainBRead.vault.lockedBalance(getUserAddress()),
      chainBRead.wrapped.balanceOf(getUserAddress()),
      chainBRead.pool.positions(getUserAddress()),
      chainBRead.stable.balanceOf(getUserAddress()),
    ]);

    const pendingLockEvent = await findPendingEventForGateway(lockEvents, destinationRead.mintGateway, "user");
    const pendingBurnEvent = await findPendingEventForGateway(burnRequestEvents, sourceRead.unlockGateway, "user");
    const userReleasableLocked = locked < (userWrapped + position.collateralAmount) ? locked : userWrapped + position.collateralAmount;
    const lockedResidual = locked > userReleasableLocked ? locked - userReleasableLocked : 0n;

    latestState = {
      marketId: market.id,
      sourceName: source.name,
      destinationName: destination.name,
      symbols: market.symbols,
      userCollateral,
      locked,
      userWrapped,
      userStable,
      poolLiquidity,
      positionCollateral: position.collateralAmount,
      principalDebt: debtBreakdown.principal,
      accruedInterest: debtBreakdown.interest,
      penaltyAmount: debtBreakdown.penalty,
      debt: debtBreakdown.total,
      dueTimestamp: position.dueTimestamp,
      overduePenaltyApplied: position.overduePenaltyApplied,
      maxBorrow,
      maxWithdraw,
      healthFactor,
      utilizationBps,
      borrowRateBps,
      collateralValueUsd,
      debtValueUsd,
      factor,
      liquidationThresholdBps,
      closeFactorBps,
      loanDuration,
      overduePenaltyBps,
      liquidationBonusBps,
      isOverdue,
      collateralPriceE8,
      stablePriceE8,
      routerFeeBps,
      userReleasableLocked,
      lockedResidual,
      sourceUnlockThreshold,
      destinationMintThreshold,
      pendingLockEvent,
      pendingBurnEvent,
      pendingLockAttestCount: pendingLockEvent?.attestCount ?? 0n,
      pendingBurnAttestCount: pendingBurnEvent?.attestCount ?? 0n,
      lockEvents: lockEvents.length,
      unlockEvents: unlockEvents.length,
      mintEvents: mintEvents.length,
      burnRequestEvents: burnRequestEvents.length,
      borrowEvents: borrowEvents.length,
      repayEvents: repayEvents.length,
      liquidationEvents: liquidationEvents.length,
      repaidWithCollateralEvents: repaidWithCollateralEvents.length,
      globalAssets: {
        A: {
          collateralWallet: chainACollateralWallet,
          collateralLocked: chainACollateralLocked,
          wrappedWallet: chainAWrappedWallet,
          wrappedInPool: chainAWrappedPosition.collateralAmount,
          stableWallet: chainAStableWallet,
        },
        B: {
          collateralWallet: chainBCollateralWallet,
          collateralLocked: chainBCollateralLocked,
          wrappedWallet: chainBWrappedWallet,
          wrappedInPool: chainBWrappedPosition.collateralAmount,
          stableWallet: chainBStableWallet,
        },
      },
    };

    renderState(latestState);
  } catch (err) {
    addLog(`Refresh failed: ${err?.shortMessage || err?.message || err}`, true);
  } finally {
    updateActionGuards();
  }
}

function ensureWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask not found. Please install MetaMask.");
  }
}

async function connectWallet() {
  ensureWallet();
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  await syncWalletContext(provider);

  setText("walletText", short(ctx.address));
  setText("activeChainText", chainNameById(ctx.chainId));
  addLog(`Connected wallet ${short(ctx.address)} on ${chainNameById(ctx.chainId)}`);

  updateActionGuards();
  await refreshState();
}

async function syncWalletContext(provider = null) {
  const activeProvider = provider || new ethers.BrowserProvider(window.ethereum);
  const signer = await activeProvider.getSigner();
  const address = await signer.getAddress();
  const network = await activeProvider.getNetwork();

  ctx = {
    provider: activeProvider,
    signer,
    address,
    chainId: Number(network.chainId),
  };
}

async function switchChain(chain) {
  ensureWallet();

  if (ctx && Number(ctx.chainId) === Number(chain.chainId)) {
    return false;
  }

  const chainIdHex = `0x${Number(chain.chainId).toString(16)}`;
  suppressChainChangedRefresh = true;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    if (err?.code !== 4902) {
      throw err;
    }

    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          rpcUrls: [chain.rpc],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ],
    });
  }

  await syncWalletContext();

  if (ctx.chainId !== Number(chain.chainId)) {
    throw new Error(`Chain guard failed. Expected ${chain.chainId}, got ${ctx.chainId}.`);
  }

  setText("activeChainText", chainNameById(ctx.chainId));
  updateActionGuards();
  return true;
}

async function requireConnected() {
  if (!ctx) {
    await connectWallet();
  }
}

async function prepareAction(actionId) {
  await requireConnected();

  const meta = ACTION_META[actionId];
  if (!meta) return { chainChanged: false };

  const role = currentRole();
  if (meta.role !== "any" && role !== meta.role) {
    throw new Error(`Role guard failed. Expected ${roleText(meta.role)}, got ${roleText(role)}.`);
  }

  const chainChanged = await switchChain(getChainConfig(meta.chain));
  return { chainChanged };
}

async function executeAction(actionId, label, handler) {
  if (busyActions.has(actionId)) return;
  busyActions.add(actionId);
  updateActionGuards();
  setActionFeedback(`${label}: preparing checks...`, "pending");
  try {
    const { chainChanged } = await prepareAction(actionId);
    if (chainChanged) {
      await refreshState();
    }
    await handler();
    const feedback = $("actionInlineFeedback");
    if (feedback?.classList.contains("action-feedback-pending")) {
      setActionFeedback(`${label}: completed.`, "success");
    }
  } catch (err) {
    addLog(`${label}: ${err?.shortMessage || err?.message || err}`, true);
    setActionFeedback(`${label}: ${err?.shortMessage || err?.message || err}`, "error");
  } finally {
    suppressChainChangedRefresh = false;
    busyActions.delete(actionId);
    updateActionGuards();
  }
}

async function runTx(label, txBuilder, refresh = true) {
  setActionFeedback(`${label}: waiting wallet confirmation...`, "pending");
  addLog(`${label}: pending...`);
  const tx = await txBuilder();
  setActionFeedback(`${label}: submitted ${tx.hash.slice(0, 10)}..., waiting block confirmation...`, "pending");
  await tx.wait();
  setActionFeedback(`${label}: confirmed (${tx.hash.slice(0, 10)}...)`, "success");
  addLog(`${label}: success (${tx.hash.slice(0, 10)}...)`);
  if (refresh) await refreshState();
}

async function approveIfNeeded(token, owner, spender, amount) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return;

  setActionFeedback("Approval required: please confirm allowance transaction in wallet.", "pending");
  addLog("Allowance missing. Please confirm approval transaction...");
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait();
  setActionFeedback(`Approval confirmed (${tx.hash.slice(0, 10)}...). Continuing action...`, "success");
  addLog(`Approval success (${tx.hash.slice(0, 10)}...). Sending main transaction...`);
}

async function validateLock(amount, source) {
  const userBalance = await source.collateral.balanceOf(getUserAddress());
  if (amount > userBalance) {
    throw new Error(`Lock exceeds user collateral balance. Max ${fmtToken(userBalance)} ${getMarketConfig().symbols.collateral}.`);
  }
}

async function validateDeposit(amount, destination) {
  const userWrapped = await destination.wrapped.balanceOf(getUserAddress());
  if (amount > userWrapped) {
    throw new Error(`Deposit exceeds user wrapped balance. Max ${fmtToken(userWrapped)} ${getMarketConfig().symbols.wrapped}.`);
  }
}

async function validateBorrow(amount, destination) {
  const [maxBorrowable, poolLiquidity, isOverdue] = await Promise.all([
    destination.pool.maxBorrowable(getUserAddress()),
    destination.stable.balanceOf(getDestinationChain().lendingPool),
    destination.pool.isOverdue(getUserAddress()),
  ]);

  if (isOverdue) {
    throw new Error("Loan is overdue. Repay or resolve overdue before new borrow.");
  }
  if (amount > maxBorrowable) {
    throw new Error(`Borrow exceeds limit. Max additional borrow ${fmtToken(maxBorrowable)} ${getMarketConfig().symbols.stable}.`);
  }
  if (amount > poolLiquidity) {
    throw new Error(`Borrow exceeds pool liquidity. Pool has ${fmtToken(poolLiquidity)} ${getMarketConfig().symbols.stable}.`);
  }
}

async function validateRepay(amount, destination) {
  const [debt, userStable] = await Promise.all([
    destination.pool.previewDebt(getUserAddress()),
    destination.stable.balanceOf(getUserAddress()),
  ]);

  if (amount > debt) {
    throw new Error(`Repay exceeds debt. Current debt ${exactTokenString(debt)} ${getMarketConfig().symbols.stable}.`);
  }
  if (amount > userStable) {
    throw new Error(`Repay exceeds user stable balance. Current balance ${exactTokenString(userStable)} ${getMarketConfig().symbols.stable}.`);
  }
}

async function estimateCollateralForDebt(state, destination) {
  const debt = await destination.pool.previewDebt(getUserAddress());
  if (debt <= 0n) {
    throw new Error("No debt to close.");
  }

  const priceIn = state?.collateralPriceE8 ?? latestState?.collateralPriceE8;
  const priceOut = state?.stablePriceE8 ?? latestState?.stablePriceE8;
  const feeBps = state?.routerFeeBps ?? latestState?.routerFeeBps ?? 0n;
  if (!priceIn || !priceOut) {
    throw new Error("Missing oracle price for close-with-collateral estimate.");
  }

  const denominator = priceIn * (10_000n - feeBps);
  if (denominator <= 0n) {
    throw new Error("Invalid router fee configuration.");
  }

  const debtBuffer = debtDustBuffer(debt);
  return ceilDiv((debt + debtBuffer) * priceOut * 10_000n, denominator);
}

async function validateCloseWithCollateral(amount, destination) {
  const [position, currentDebt, quote, routerStableBalance] = await Promise.all([
    destination.pool.positions(getUserAddress()),
    destination.pool.previewDebt(getUserAddress()),
    destination.router.previewSwap(getDestinationChain().wrappedRemoteToken, getDestinationChain().stableToken, amount),
    destination.stable.balanceOf(getDestinationChain().swapRouter),
  ]);

  if (currentDebt <= 0n) {
    throw new Error("No debt to close.");
  }
  if (amount > position.collateralAmount) {
    throw new Error(`Close amount exceeds collateral in pool. Max ${exactTokenString(position.collateralAmount)} ${getMarketConfig().symbols.wrapped}.`);
  }
  if (quote <= 0n) {
    throw new Error("Router quote is zero. Increase collateral amount or check router liquidity.");
  }
  if (quote > routerStableBalance) {
    throw new Error(`Router stable inventory is too low. Router has ${exactTokenString(routerStableBalance)} ${getMarketConfig().symbols.stable}.`);
  }
}

async function validateWithdraw(amount, destination) {
  const [position, maxWithdrawable, isOverdue] = await Promise.all([
    destination.pool.positions(getUserAddress()),
    destination.pool.maxWithdrawable(getUserAddress()),
    destination.pool.isOverdue(getUserAddress()),
  ]);

  if (isOverdue) {
    throw new Error("Loan is overdue. Cannot withdraw before resolution.");
  }
  if (amount > position.collateralAmount) {
    throw new Error(`Withdraw exceeds deposited collateral. Max ${exactTokenString(position.collateralAmount)} ${getMarketConfig().symbols.wrapped}.`);
  }
  if (amount > maxWithdrawable) {
    throw new Error(`Withdraw exceeds safe limit. Max safe withdraw ${exactTokenString(maxWithdrawable)} ${getMarketConfig().symbols.wrapped}.`);
  }
}

async function validateBurnRequest(amount, destination) {
  const userWrapped = await destination.wrapped.balanceOf(getUserAddress());
  if (amount > userWrapped) {
    throw new Error(`Burn exceeds user wrapped balance. Max ${fmtToken(userWrapped)} ${getMarketConfig().symbols.wrapped}.`);
  }
}

function bindClick(id, handler) {
  const node = $(id);
  if (node) node.addEventListener("click", handler);
}

async function selectMarket(marketId) {
  if (!cfg.markets[marketId]) return;
  selectedMarketId = marketId;
  saveSelectedMarket();
  latestState = null;
  renderMarketLabels();
  updateActionGuards();
  updateNextActionGuide(null);
  addLog(`Switched active market to ${marketId}.`);
  await refreshState();
}

async function selectMarketFromDropdowns() {
  const collateralSelect = $("collateralChainSelect");
  const lendingSelect = $("lendingChainSelect");
  if (!collateralSelect || !lendingSelect || !cfg?.markets) return;

  let sourceChain = collateralSelect.value;
  let destinationChain = lendingSelect.value;

  if (!sourceChain || !destinationChain) return;

  if (sourceChain === destinationChain) {
    const alternate = Object.keys(cfg.chains).find((chainKey) => chainKey !== sourceChain);
    if (!alternate) return;
    destinationChain = alternate;
    lendingSelect.value = destinationChain;
  }

  const marketId = marketIdForChains(sourceChain, destinationChain);
  if (!marketId) {
    addLog(`Unsupported market combination: ${sourceChain} -> ${destinationChain}.`, true);
    renderMarketSelectors();
    return;
  }

  if (marketId === selectedMarketId) return;
  await selectMarket(marketId);
}

async function handleAccountsChanged(accounts) {
  if (!accounts || accounts.length === 0) {
    ctx = null;
    setText("walletText", "Not connected");
    setText("roleText", "Unknown");
    setText("activeChainText", "Unknown");
    addLog("Wallet disconnected.");
    updateActionGuards();
    updateNextActionGuide(latestState);
    return;
  }

  try {
    await syncWalletContext();
    setText("walletText", short(ctx.address));
    setText("activeChainText", chainNameById(ctx.chainId));
    addLog(`Account changed to ${short(ctx.address)}.`);
    updateActionGuards();
    await refreshState();
  } catch (err) {
    addLog(`Account change sync failed: ${err?.shortMessage || err?.message || err}`, true);
  }
}

async function handleChainChanged() {
  if (!window.ethereum || !ctx) return;

  try {
    await syncWalletContext();
    setText("walletText", short(ctx.address));
    setText("activeChainText", chainNameById(ctx.chainId));
    updateActionGuards();
    if (suppressChainChangedRefresh) {
      return;
    }
    addLog(`Chain changed to ${chainNameById(ctx.chainId)}.`);
    await refreshState();
  } catch (err) {
    addLog(`Chain change sync failed: ${err?.shortMessage || err?.message || err}`, true);
  }
}

function bindBaseActions() {
  bindClick("connectBtn", async () => connectWallet());
  bindClick("refreshBtn", async () => refreshState());
  const collateralSelect = $("collateralChainSelect");
  const lendingSelect = $("lendingChainSelect");
  if (collateralSelect) collateralSelect.addEventListener("change", selectMarketFromDropdowns);
  if (lendingSelect) lendingSelect.addEventListener("change", selectMarketFromDropdowns);
}

function bindOwnerActions() {
  bindClick("applyRiskProfileBtn", async () => {
    await executeAction("applyRiskProfileBtn", "Apply risk baseline", async () => {
      const destination = destinationContracts(ctx.signer);
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;

      const currentFactor = latestState?.factor?.toString() || String(destinationChain.risk?.collateralFactorBps || 5000);
      const currentDuration = latestState?.loanDuration ? String(Math.max(1, Math.floor(Number(latestState.loanDuration) / 3600))) : "72";
      const currentPenalty = latestState?.overduePenaltyBps?.toString() || "500";
      const currentBonus = latestState?.liquidationBonusBps?.toString() || "500";
      const currentCollateralPrice = latestState ? String(Number(latestState.collateralPriceE8) / ORACLE_DECIMALS) : "1";
      const currentStablePrice = latestState ? String(Number(latestState.stablePriceE8) / ORACLE_DECIMALS) : "1";

      const factor = parseBps("collateralFactorInput", currentFactor, 1, 10000, "Collateral factor");
      const hours = parseHours("loanDurationHoursInput", currentDuration, "Loan duration");
      const penalty = parseBps("penaltyBpsInput", currentPenalty, 0, 10000, "Overdue penalty");
      const bonus = parseBps("bonusBpsInput", currentBonus, 0, 10000, "Liquidation bonus");
      const collateralPriceE8 = parsePriceE8("collateralPriceInput", currentCollateralPrice, `${symbols.wrapped} price`);
      const stablePriceE8 = parsePriceE8("stablePriceInput", currentStablePrice, `${symbols.stable} price`);

      await runTx(`Set collateral factor (${factor} bps)`, () => destination.pool.setCollateralFactorBps(factor), false);
      await runTx(`Set loan duration (${hours}h)`, () => destination.pool.setLoanDuration(hours * 3600), false);
      await runTx(`Set overdue penalty (${penalty} bps)`, () => destination.pool.setOverduePenaltyBps(penalty), false);
      await runTx(`Set liquidation bonus (${bonus} bps)`, () => destination.pool.setLiquidationBonusBps(bonus), false);
      await runTx(`Set ${symbols.wrapped} price`, () => destination.oracle.setPrice(destinationChain.wrappedRemoteToken, collateralPriceE8), false);
      await runTx(`Set ${symbols.stable} price`, () => destination.oracle.setPrice(destinationChain.stableToken, stablePriceE8), false);

      addLog(`Risk baseline applied for market ${getMarketConfig().id}.`);
      clearInputs([
        "collateralFactorInput",
        "loanDurationHoursInput",
        "penaltyBpsInput",
        "bonusBpsInput",
        "collateralPriceInput",
        "stablePriceInput",
      ]);
      await refreshState();
    });
  });

  bindClick("updateFactorBtn", async () => {
    await executeAction("updateFactorBtn", "Set collateral factor", async () => {
      const destination = destinationContracts(ctx.signer);
      const factor = parseBps("collateralFactorInput", latestState?.factor?.toString() || "5000", 1, 10000, "Collateral factor");
      await runTx(`Set collateral factor (${factor} bps)`, () => destination.pool.setCollateralFactorBps(factor));
      clearInputs(["collateralFactorInput"]);
    });
  });

  bindClick("updateDurationBtn", async () => {
    await executeAction("updateDurationBtn", "Set loan duration", async () => {
      const destination = destinationContracts(ctx.signer);
      const current = latestState?.loanDuration ? String(Math.max(1, Math.floor(Number(latestState.loanDuration) / 3600))) : "72";
      const hours = parseHours("loanDurationHoursInput", current, "Loan duration");
      await runTx(`Set loan duration (${hours}h)`, () => destination.pool.setLoanDuration(hours * 3600));
      clearInputs(["loanDurationHoursInput"]);
    });
  });

  bindClick("updatePenaltyBtn", async () => {
    await executeAction("updatePenaltyBtn", "Set overdue penalty", async () => {
      const destination = destinationContracts(ctx.signer);
      const penalty = parseBps("penaltyBpsInput", latestState?.overduePenaltyBps?.toString() || "500", 0, 10000, "Overdue penalty");
      await runTx(`Set overdue penalty (${penalty} bps)`, () => destination.pool.setOverduePenaltyBps(penalty));
      clearInputs(["penaltyBpsInput"]);
    });
  });

  bindClick("updateBonusBtn", async () => {
    await executeAction("updateBonusBtn", "Set liquidation bonus", async () => {
      const destination = destinationContracts(ctx.signer);
      const bonus = parseBps("bonusBpsInput", latestState?.liquidationBonusBps?.toString() || "500", 0, 10000, "Liquidation bonus");
      await runTx(`Set liquidation bonus (${bonus} bps)`, () => destination.pool.setLiquidationBonusBps(bonus));
      clearInputs(["bonusBpsInput"]);
    });
  });

  bindClick("updateCollateralPriceBtn", async () => {
    await executeAction("updateCollateralPriceBtn", "Set wrapped price", async () => {
      const destination = destinationContracts(ctx.signer);
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const current = latestState ? String(Number(latestState.collateralPriceE8) / ORACLE_DECIMALS) : "1";
      const priceE8 = parsePriceE8("collateralPriceInput", current, `${symbols.wrapped} price`);
      await runTx(`Set ${symbols.wrapped} price`, () => destination.oracle.setPrice(destinationChain.wrappedRemoteToken, priceE8));
      clearInputs(["collateralPriceInput"]);
    });
  });

  bindClick("updateStablePriceBtn", async () => {
    await executeAction("updateStablePriceBtn", "Set stable price", async () => {
      const destination = destinationContracts(ctx.signer);
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const current = latestState ? String(Number(latestState.stablePriceE8) / ORACLE_DECIMALS) : "1";
      const priceE8 = parsePriceE8("stablePriceInput", current, `${symbols.stable} price`);
      await runTx(`Set ${symbols.stable} price`, () => destination.oracle.setPrice(destinationChain.stableToken, priceE8));
      clearInputs(["stablePriceInput"]);
    });
  });

  bindClick("mintCollateralToUserBtn", async () => {
    await executeAction("mintCollateralToUserBtn", "Mint collateral to user", async () => {
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("mintCollateralAmount", null, `${symbols.collateral} amount`);
      const source = sourceContracts(ctx.signer);
      await runTx(`Mint ${fmtToken(amount)} ${symbols.collateral} to user`, () => source.collateral.mint(getUserAddress(), amount));
      clearInputs(["mintCollateralAmount"]);
    });
  });

  bindClick("mintStableToUserBtn", async () => {
    await executeAction("mintStableToUserBtn", "Mint stable to user", async () => {
      const destination = destinationContracts(ctx.signer);
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("mintStableToUserAmount", null, `${symbols.stable} amount`);
      await runTx(`Mint ${fmtToken(amount)} ${symbols.stable} to user`, () => destination.stable.mint(getUserAddress(), amount));
      clearInputs(["mintStableToUserAmount"]);
    });
  });

  bindClick("mintStableToPoolBtn", async () => {
    await executeAction("mintStableToPoolBtn", "Mint stable to pool", async () => {
      const destination = destinationContracts(ctx.signer);
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("mintStableAmount", null, `${symbols.stable} amount`);
      await runTx(`Mint ${fmtToken(amount)} ${symbols.stable} to pool`, () => destination.stable.mint(destinationChain.lendingPool, amount));
      clearInputs(["mintStableAmount"]);
    });
  });

  bindClick("advanceTimeBtn", async () => {
    await executeAction("advanceTimeBtn", "Advance chain time", async () => {
      const destinationChain = getDestinationChain();
      if (!isLocalDevChain(destinationChain)) {
        throw new Error("Advance +1 Day is available only on local dev chains.");
      }

      const rpcProvider = new ethers.JsonRpcProvider(destinationChain.rpc);
      addLog("Advance time (+1 day): pending...");
      await rpcProvider.send("evm_increaseTime", [24 * 3600]);
      await rpcProvider.send("evm_mine", []);
      addLog("Advance time: success (+1 day).");
      await refreshState();
    });
  });

  bindClick("applyPenaltyBtn", async () => {
    await executeAction("applyPenaltyBtn", "Apply overdue penalty", async () => {
      const destination = destinationContracts(ctx.signer);
      await runTx("Apply overdue penalty", () => destination.pool.applyOverduePenalty(getUserAddress()));
    });
  });

  bindClick("liquidateBtn", async () => {
    await executeAction("liquidateBtn", "Liquidate user", async () => {
      const destination = destinationContracts(ctx.signer);
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;

      const debtToRepay = await destination.pool.previewDebt(getUserAddress());
      if (debtToRepay === 0n) {
        throw new Error("No debt to liquidate.");
      }

      const bufferedDebt = debtToRepay + debtDustBuffer(debtToRepay);

      const liquidatorBalance = await destination.stable.balanceOf(ctx.address);
      if (liquidatorBalance < bufferedDebt) {
        if (currentRole() !== "owner") {
          throw new Error(`Liquidator has insufficient ${symbols.stable}. Need at least ${exactTokenString(bufferedDebt)} ${symbols.stable} to avoid residual dust during liquidation.`);
        }

        const mintAmount = bufferedDebt - liquidatorBalance;
        await runTx(`Liquidation prep: mint ${fmtToken(mintAmount)} ${symbols.stable} to owner`, () => destination.stable.mint(ctx.address, mintAmount), false);
      }

      await approveIfNeeded(destination.stable, ctx.address, destinationChain.lendingPool, bufferedDebt);
      await runTx(`Liquidate user debt (max)`, () => destination.pool.liquidate(getUserAddress(), ethers.MaxUint256));
    });
  });
}

function bindUserActions() {
  bindClick("lockBtn", async () => {
    await executeAction("lockBtn", "User lock collateral", async () => {
      const sourceChain = getSourceChain();
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("lockAmount", null, "Lock amount");
      const source = sourceContracts(ctx.signer);

      await validateLock(amount, source);
      await approveIfNeeded(source.collateral, getUserAddress(), sourceChain.collateralVault, amount);
      await runTx(`User lock ${fmtToken(amount)} ${symbols.collateral}`, () => source.vault.lock(amount));
      clearInputs(["lockAmount"]);
    });
  });

  bindClick("depositBtn", async () => {
    await executeAction("depositBtn", "User deposit wrapped collateral", async () => {
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("depositAmount", null, "Deposit amount");
      const destination = destinationContracts(ctx.signer);

      await validateDeposit(amount, destination);
      await approveIfNeeded(destination.wrapped, getUserAddress(), destinationChain.lendingPool, amount);
      await runTx(`User deposit ${fmtToken(amount)} ${symbols.wrapped}`, () => destination.pool.depositCollateral(amount));
      clearInputs(["depositAmount"]);
    });
  });

  bindClick("borrowBtn", async () => {
    await executeAction("borrowBtn", "User borrow stable", async () => {
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("borrowAmount", null, "Borrow amount");
      const destination = destinationContracts(ctx.signer);

      await validateBorrow(amount, destination);
      await runTx(`User borrow ${fmtToken(amount)} ${symbols.stable}`, () => destination.pool.borrow(amount));
      clearInputs(["borrowAmount"]);
    });
  });

  bindClick("repayBtn", async () => {
    await executeAction("repayBtn", "User repay stable", async () => {
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("repayAmount", null, "Repay amount");
      const destination = destinationContracts(ctx.signer);

      await validateRepay(amount, destination);
      await approveIfNeeded(destination.stable, getUserAddress(), destinationChain.lendingPool, amount);
      await runTx(`User repay ${fmtToken(amount)} ${symbols.stable}`, () => destination.pool.repay(amount));
      clearInputs(["repayAmount"]);
    });
  });

  bindClick("repayMaxBtn", async () => {
    await executeAction("repayMaxBtn", "User repay wallet max", async () => {
      const destination = destinationContracts(ctx.signer);
      const [debt, userStable] = await Promise.all([
        destination.pool.previewDebt(getUserAddress()),
        destination.stable.balanceOf(getUserAddress()),
      ]);

      if (debt <= 0n) {
        throw new Error("No debt to repay.");
      }
      if (userStable <= 0n) {
        throw new Error("No repayable stable balance or no debt.");
      }

      const amount = debt < userStable ? debt : userStable;
      const destinationChain = getDestinationChain();
      await approveIfNeeded(destination.stable, getUserAddress(), destinationChain.lendingPool, userStable);
      await runTx(`User repay wallet max ${fmtToken(amount)} ${getMarketConfig().symbols.stable}`, () => destination.pool.repayAvailable());
      clearInputs(["repayAmount"]);
    });
  });

  bindClick("repayAllBtn", async () => {
    await executeAction("repayAllBtn", "User repay all debt", async () => {
      const destinationChain = getDestinationChain();
      const symbols = getMarketConfig().symbols;
      const destination = destinationContracts(ctx.signer);
      const [debt, userStable] = await Promise.all([
        destination.pool.previewDebt(getUserAddress()),
        destination.stable.balanceOf(getUserAddress()),
      ]);

      if (debt <= 0n) {
        throw new Error("No debt to repay.");
      }
      if (userStable < debt) {
        throw new Error(`Insufficient ${symbols.stable} for repay all. Need ${exactTokenString(debt)} ${symbols.stable}, wallet has ${exactTokenString(userStable)} ${symbols.stable}.`);
      }

      await approveIfNeeded(destination.stable, getUserAddress(), destinationChain.lendingPool, debt);
      await runTx(`User repay all ${symbols.stable}`, () => destination.pool.repayAll());
      clearInputs(["repayAmount"]);
    });
  });

  bindClick("withdrawMaxBtn", async () => {
    await executeAction("withdrawMaxBtn", "User withdraw max", async () => {
      const destination = destinationContracts(ctx.signer);
      const amount = await destination.pool.maxWithdrawable(getUserAddress());

      if (amount <= 0n) {
        throw new Error("No withdrawable collateral available.");
      }

      await runTx(`User withdraw max ${fmtToken(amount)} ${getMarketConfig().symbols.wrapped}`, () => destination.pool.withdrawMax());
      clearInputs(["withdrawAmount"]);
    });
  });

  bindClick("burnMaxBtn", async () => {
    await executeAction("burnMaxBtn", "User burn max", async () => {
      const destination = destinationContracts(ctx.signer);
      const amount = await destination.wrapped.balanceOf(getUserAddress());

      if (amount <= 0n) {
        throw new Error("No wrapped collateral available in wallet.");
      }

      await runTx(`User request burn max ${fmtToken(amount)} ${getMarketConfig().symbols.wrapped}`, () => destination.mintGateway.requestBurn(amount));
      clearInputs(["burnAmount"]);
    });
  });

  bindClick("autoCloseDebtBtn", async () => {
    await executeAction("autoCloseDebtBtn", "User sell collateral to repay debt", async () => {
      const symbols = getMarketConfig().symbols;
      const destination = destinationContracts(ctx.signer);
      let collateralAmount = await estimateCollateralForDebt(latestState, destination);
      setInputValue("closeWithCollateralAmount", exactTokenString(collateralAmount));
      addLog(`Auto-estimated close amount: ${exactTokenString(collateralAmount)} ${symbols.wrapped}.`);

      await validateCloseWithCollateral(collateralAmount, destination);

      let quote = await destination.router.previewSwap(
        getDestinationChain().wrappedRemoteToken,
        getDestinationChain().stableToken,
        collateralAmount
      );

      const debt = await destination.pool.previewDebt(getUserAddress());
      while (quote < debt) {
        collateralAmount += 1n;
        quote = await destination.router.previewSwap(
          getDestinationChain().wrappedRemoteToken,
          getDestinationChain().stableToken,
          collateralAmount
        );
      }

      const routerStableBalance = await destination.stable.balanceOf(getDestinationChain().swapRouter);
      if (quote > routerStableBalance) {
        throw new Error(`Router stable inventory is too low. Router has ${exactTokenString(routerStableBalance)} ${symbols.stable}.`);
      }

      setInputValue("closeWithCollateralAmount", exactTokenString(collateralAmount));
      await runTx(
        `User sell ${fmtToken(collateralAmount)} ${symbols.wrapped} to repay debt`,
        () => destination.pool.repayWithCollateral(collateralAmount, quote)
      );
      clearInputs(["closeWithCollateralAmount"]);
    });
  });

  bindClick("closeWithCollateralBtn", async () => {
    await executeAction("closeWithCollateralBtn", "User sell custom collateral amount", async () => {
      const symbols = getMarketConfig().symbols;
      const destination = destinationContracts(ctx.signer);
      const collateralAmount = parseAmount("closeWithCollateralAmount", null, "Custom collateral sale amount");

      await validateCloseWithCollateral(collateralAmount, destination);

      const quote = await destination.router.previewSwap(
        getDestinationChain().wrappedRemoteToken,
        getDestinationChain().stableToken,
        collateralAmount
      );

      const routerStableBalance = await destination.stable.balanceOf(getDestinationChain().swapRouter);
      if (quote > routerStableBalance) {
        throw new Error(`Router stable inventory is too low. Router has ${exactTokenString(routerStableBalance)} ${symbols.stable}.`);
      }

      await runTx(
        `User sell ${fmtToken(collateralAmount)} ${symbols.wrapped} to repay debt`,
        () => destination.pool.repayWithCollateral(collateralAmount, quote)
      );
      clearInputs(["closeWithCollateralAmount"]);
    });
  });

  bindClick("withdrawBtn", async () => {
    await executeAction("withdrawBtn", "User withdraw wrapped collateral", async () => {
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("withdrawAmount", null, "Withdraw amount");
      const destination = destinationContracts(ctx.signer);

      await validateWithdraw(amount, destination);
      await runTx(`User withdraw ${fmtToken(amount)} ${symbols.wrapped}`, () => destination.pool.withdrawCollateral(amount));
      clearInputs(["withdrawAmount"]);
    });
  });

  bindClick("requestBurnBtn", async () => {
    await executeAction("requestBurnBtn", "User request burn", async () => {
      const symbols = getMarketConfig().symbols;
      const amount = parseAmount("burnAmount", null, "Burn amount");
      const destination = destinationContracts(ctx.signer);

      await validateBurnRequest(amount, destination);
      await runTx(`User request burn ${fmtToken(amount)} ${symbols.wrapped}`, () => destination.mintGateway.requestBurn(amount));
      clearInputs(["burnAmount"]);
    });
  });
}

async function initialize() {
  try {
    await loadConfig();
    addLog("Platform initialized. Connect wallet to start.");
    updateActionGuards();
    updateNextActionGuide(null);
    await refreshState();
  } catch (err) {
    addLog(err?.message || String(err), true);
  }

  bindBaseActions();
  bindOwnerActions();
  bindUserActions();
  bindPositionSummaryToggle();
  bindAdvancedTabs();

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
  }
}

export async function bootPortalApp(portal) {
  if (booted) return;
  booted = true;
  portalType = portal || document.body?.dataset?.portal || "user";
  await initialize();
}
