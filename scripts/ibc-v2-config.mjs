import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { signerForRpc } from "./ibc-lite-common.mjs";

export const V2_CONFIG_PATH = resolve(process.cwd(), process.env.V2_CONFIG_PATH || ".ibc-v2.local.json");

export function toConfigValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toConfigValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toConfigValue(child)]));
  }
  return value;
}

export async function loadV2Config() {
  const config = JSON.parse(await readFile(V2_CONFIG_PATH, "utf8"));
  if (config.version !== "v2") {
    throw new Error(`Expected v2 config at ${V2_CONFIG_PATH}, got version=${config.version || "unknown"}.`);
  }
  return config;
}

export async function saveV2Config(config) {
  await writeFile(V2_CONFIG_PATH, `${JSON.stringify(toConfigValue(config), null, 2)}\n`);
}

export function providerForV2(config, chainKey) {
  return new ethers.JsonRpcProvider(config.chains[chainKey].rpc);
}

export async function signerForV2(config, chainKey, index = 0) {
  return signerForRpc(config.chains[chainKey].rpc, chainKey, index);
}
