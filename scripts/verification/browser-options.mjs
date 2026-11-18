import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

// Prefer the pinned browser. On Windows, reuse installed Edge if Chromium has
// not been downloaded; preflight and Playwright must choose the same executable.
export function browserLaunchOptions() {
  if (existsSync(chromium.executablePath()) || process.platform !== "win32") return {};
  const edge = join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft/Edge/Application/msedge.exe");
  return existsSync(edge) ? { executablePath: edge } : {};
}
