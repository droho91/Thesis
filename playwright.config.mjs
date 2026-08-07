import { defineConfig } from "@playwright/test";
import { fixtureOrigin } from "./test/ui/fixture-environment.mjs";

const desktopProjects = [
  { name: "laptop-1100", viewport: { width: 1100, height: 600 } },
  { name: "desktop-1366", viewport: { width: 1366, height: 768 } },
  { name: "desktop-1600", viewport: { width: 1600, height: 900 } },
  { name: "desktop-1920", viewport: { width: 1920, height: 1080 } },
];

export default defineConfig({
  testDir: "./test/ui",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.001,
      scale: "css",
    },
  },
  outputDir: ".runtime/playwright-results",
  reporter: "line",
  use: {
    baseURL: fixtureOrigin,
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: desktopProjects.map(({ name, viewport }) => ({
    name,
    use: { viewport },
  })),
  webServer: {
    command: "node test/ui/fixture-server.mjs",
    url: fixtureOrigin,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
