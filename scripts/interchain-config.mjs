import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { signerForRpc } from "./besu-runtime.mjs";

export const RUNTIME_CONFIG_PATH = resolve(process.cwd(), process.env.RUNTIME_CONFIG_PATH || ".interchain-lending.local.json");

export function toConfigValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toConfigValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toConfigValue(child)]));
  }
  return value;
}

export async function loadRuntimeConfig() {
  const config = JSON.parse(await readFile(RUNTIME_CONFIG_PATH, "utf8"));
  if (config.version !== "interchain-lending") {
    throw new Error(`Expected interchain lending config at ${RUNTIME_CONFIG_PATH}, got version=${config.version || "unknown"}.`);
  }
  return config;
}

export async function saveRuntimeConfig(config) {
  await writeFile(RUNTIME_CONFIG_PATH, `${JSON.stringify(toConfigValue(config), null, 2)}\n`);
}

export function providerForChain(config, chainKey) {
  return new ethers.JsonRpcProvider(config.chains[chainKey].rpc);
}

export async function signerForChain(config, chainKey, index = 0) {
  return signerForRpc(config.chains[chainKey].rpc, chainKey, index);
}
