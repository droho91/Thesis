const STORAGE_KEY = "crosschain-lending-theme";
const LEGACY_STORAGE_KEY = "chainlend-theme";

function preferredTheme() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {}

  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : null;
}

function persistTheme(theme) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {}
}

function syncButtons(theme) {
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    const isActive = button.dataset.themeOption === theme;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  syncButtons(document.documentElement.dataset.theme);
}

function bindThemeToggle() {
  const theme = currentTheme() ?? preferredTheme();
  applyTheme(theme);

  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    if (button.dataset.themeBound === "true") return;
    button.dataset.themeBound = "true";
    button.addEventListener("click", () => {
      const nextTheme = button.dataset.themeOption;
      if (nextTheme !== "light" && nextTheme !== "dark") return;
      applyTheme(nextTheme);
      persistTheme(nextTheme);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindThemeToggle, { once: true });
} else {
  bindThemeToggle();
}
