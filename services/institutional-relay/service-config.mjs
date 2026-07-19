import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers } from "ethers";

export async function loadRelayServiceConfig(path = process.env.INSTITUTIONAL_RELAY_CONFIG || "config/institutional-relay.json") {
  const absolutePath = resolve(process.cwd(), path);
  const config = JSON.parse(await readFile(absolutePath, "utf8"));
  if (config.version !== "institutional-relay-v1") throw new Error(`Unsupported relay config at ${absolutePath}`);
  if (!Array.isArray(config.lanes) || config.lanes.length === 0) throw new Error("Relay config must contain at least one lane");
  const ids = new Set();
  for (const lane of config.lanes) {
    if (!lane.id || ids.has(lane.id)) throw new Error(`Relay lane id is missing or duplicated: ${lane.id}`);
    ids.add(lane.id);
    validateEndpoint(lane.source, `${lane.id}.source`);
    validateEndpoint(lane.destination, `${lane.id}.destination`);
    if (BigInt(lane.source.chainId) === BigInt(lane.destination.chainId)) throw new Error(`${lane.id} must connect different chains`);
    if (!Array.isArray(lane.attestors) || lane.attestors.length < 3) {
      throw new Error(`${lane.id} requires independently configured attestor endpoints`);
    }
    lane.attestors = lane.attestors.map((endpoint) => ({
      url: endpoint.url,
      token: endpoint.tokenEnv ? requiredEnvironment(endpoint.tokenEnv) : undefined,
    }));
  }
  return { ...config, path: absolutePath };
}

export async function loadAttestorServiceConfig(path = process.env.INSTITUTIONAL_ATTESTOR_CONFIG || "config/institutional-attestor.json") {
  const absolutePath = resolve(process.cwd(), path);
  const config = JSON.parse(await readFile(absolutePath, "utf8"));
  if (config.version !== "institutional-attestor-v1") throw new Error(`Unsupported attestor config at ${absolutePath}`);
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new Error("Attestor config has no source chains");
  const sources = {};
  for (const source of config.sources) {
    if (!source.rpc || BigInt(source.chainId) <= 0n) throw new Error("Attestor source chain configuration is invalid");
    sources[BigInt(source.chainId).toString()] = source;
  }
  const privateKey = requiredEnvironment(config.privateKeyEnv || "ATTESTOR_PRIVATE_KEY");
  if (!ethers.isHexString(privateKey, 32)) throw new Error("Attestor private key must be 32 bytes");
  const token = config.apiTokenEnv ? requiredEnvironment(config.apiTokenEnv) : undefined;
  const host = config.listen?.host || "127.0.0.1";
  if (!isLoopback(host) && !token) throw new Error("A non-loopback attestor listener requires apiTokenEnv");
  return { ...config, path: absolutePath, sources, privateKey, token, listen: { host, port: Number(config.listen?.port || 8701) } };
}

export function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function validateEndpoint(endpoint, label) {
  if (!endpoint?.rpc || BigInt(endpoint.chainId) <= 0n) throw new Error(`${label} RPC or chainId is invalid`);
  ethers.getAddress(endpoint.gateway);
  ethers.getAddress(endpoint.checkpointClient);
  if (!endpoint.privateKeyEnv && endpoint.operatorIndex == null) {
    throw new Error(`${label} requires privateKeyEnv or a local operatorIndex`);
  }
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
