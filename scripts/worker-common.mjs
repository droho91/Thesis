import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const POLL_MS = Number(process.env.WORKER_POLL_MS || 2500);

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function getEventLogIndex(ev) {
  if (ev.logIndex !== undefined && ev.logIndex !== null) return BigInt(ev.logIndex);
  if (ev.index !== undefined && ev.index !== null) return BigInt(ev.index);
  return 0n;
}

export function prettyHash(value) {
  if (!value) return "-";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

export async function loadConfig() {
  const cfgPath = resolve(process.cwd(), "demo", "multichain-addresses.json");
  return JSON.parse(await readFile(cfgPath, "utf8"));
}

export function getMarketEntries(cfg) {
  return Object.values(cfg.markets || {});
}
