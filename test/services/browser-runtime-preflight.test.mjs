import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateBrowserRuntime,
  parseMissingSharedLibraries,
} from "../../scripts/verification/browser-runtime-preflight.mjs";

test("browser preflight parser extracts unique unresolved Linux libraries", () => {
  const output = [
    "linux-vdso.so.1 (0x00007fff)",
    "libnspr4.so => not found",
    "libnss3.so => not found",
    "libnspr4.so => not found",
    "libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0001)",
  ].join("\n");
  assert.deepEqual(parseMissingSharedLibraries(output), ["libnspr4.so", "libnss3.so"]);
  assert.deepEqual(parseMissingSharedLibraries(null), []);
});

test("browser preflight fails closed for a missing executable or shared library", () => {
  const missingExecutable = evaluateBrowserRuntime({
    executablePath: "/missing/chromium",
    executablePresent: false,
    lddOk: false,
    missingLibraries: [],
  });
  assert.equal(missingExecutable.status, "failed");

  const missingLibrary = evaluateBrowserRuntime({
    executablePath: "/playwright/chromium",
    executablePresent: true,
    lddOk: true,
    missingLibraries: ["libnspr4.so"],
  });
  assert.equal(missingLibrary.status, "failed");
  assert.match(missingLibrary.checks.at(-1).detail, /libnspr4/);
});

test("browser preflight accepts a present executable with resolved dependencies", () => {
  const result = evaluateBrowserRuntime({
    executablePath: "/playwright/chromium",
    executablePresent: true,
    lddOk: true,
    missingLibraries: [],
  });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
});
