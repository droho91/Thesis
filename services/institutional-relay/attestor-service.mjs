import { resolve } from "node:path";
import { ethers } from "ethers";
import { providerForRpc } from "../../scripts/ops/besu/runtime.mjs";
import { AttestorJournal } from "./attestor-journal.mjs";
import { CheckpointAttestor } from "./checkpoint-attestor.mjs";
import { createAttestorHttpServer } from "./attestor-http-server.mjs";

export async function startCheckpointAttestorService(config, {
  cwd = process.cwd(),
  createProvider = providerForRpc,
  openJournal = (path) => AttestorJournal.open(path),
  createServer = createAttestorHttpServer,
  logger = console,
} = {}) {
  const providers = [];
  let journal = null;
  let server = null;
  try {
    const sources = Object.fromEntries(Object.entries(config.sources).map(([chainId, source]) => {
      const provider = createProvider(source.rpc);
      providers.push(provider);
      return [chainId, { provider, finalityDepth: Number(source.finalityDepth ?? 2) }];
    }));
    journal = await openJournal(resolve(cwd, config.journalPath || ".runtime/attestor-journal.json"));
    const attestor = new CheckpointAttestor({
      wallet: new ethers.Wallet(config.privateKey),
      sources,
      journal,
      allowedDomains: config.allowedDomains,
    });
    server = createServer({ attestor, token: config.token, logger });
    await listenServer(server, config.listen.port, config.listen.host);

    let closePromise = null;
    return Object.freeze({
      server,
      journal,
      providers: Object.freeze([...providers]),
      signerAddress: attestor.signerAddress,
      close() {
        closePromise ||= closeAttestorResources({ server, journal, providers });
        return closePromise;
      },
    });
  } catch (startError) {
    try {
      await closeAttestorResources({ server, journal, providers });
    } catch (cleanupError) {
      throw new AggregateError(
        [startError, cleanupError],
        "Checkpoint attestor startup and cleanup both failed",
      );
    }
    throw startError;
  }
}

function listenServer(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      rejectListen(error);
    }
  });
}

async function closeAttestorResources({ server, journal, providers }) {
  const failures = [];
  if (server?.listening) {
    try {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections?.();
      });
    } catch (error) {
      failures.push(error);
    }
  }
  const operations = [];
  if (typeof journal?.close === "function") operations.push(journal.close());
  for (const provider of providers) {
    if (typeof provider?.destroy === "function") operations.push(Promise.resolve().then(() => provider.destroy()));
  }
  const results = await Promise.allSettled(operations);
  failures.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Checkpoint attestor cleanup failed");
}
