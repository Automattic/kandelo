import { parentPort, workerData } from "node:worker_threads";
import {
  defineForkExternrefImport,
  type ForkExternrefImportBinding,
} from "../../src/fork-externref-import-mailbox";
import {
  type ForkHostImportWorkerInit,
  ForkHostImportWorkerRuntime,
} from "../../src/fork-host-import-runtime";
import { ForkExternrefTokenCache } from "../../src/fork-reference-broker";

if (!parentPort) throw new Error("fork exception fixture requires parentPort");

const data = workerData as {
  readonly mode: "parent" | "child";
  readonly binding: ForkExternrefImportBinding;
  readonly init: ForkHostImportWorkerInit;
  readonly inheritedHandle?: number;
};
const tokens = new ForkExternrefTokenCache(data.binding.generationId);
const runtime = new ForkHostImportWorkerRuntime(
  data.init,
  data.binding.pid,
  data.binding.generationId,
  tokens,
  (wake) => parentPort.postMessage({ type: "wake", wake }),
);

const echo = defineForkExternrefImport(
  77,
  ["externref"],
  ["externref"],
);

try {
  if (data.mode === "parent") {
    const localOnly = Object.freeze({
      source: "parent Worker",
      callback: () => 42,
    });
    const wrapped = runtime.localExceptions.wrap(5, () => {
      throw localOnly;
    });
    let thrown: unknown;
    try {
      wrapped();
      throw new Error("expected Worker-local exception");
    } catch (value) {
      thrown = value;
    }
    if (thrown !== localOnly) {
      throw new Error("Worker-local import changed exception identity");
    }
    const token =
      runtime.localExceptions.normalizeUnclaimedForkException(thrown);
    const handle = tokens.encode(token);
    if (handle === null) {
      throw new Error("parent Worker received a noncanonical token");
    }
    parentPort.postMessage({ type: "complete", handle });
  } else {
    if (data.inheritedHandle === undefined) {
      throw new Error("child Worker is missing its inherited handle");
    }
    const inherited = tokens.materialize(data.inheritedHandle);
    const echoed = runtime.caller.call(echo, [inherited]);
    const handle = tokens.encode(echoed);
    if (handle === null) {
      throw new Error("child Worker received a noncanonical echo");
    }
    parentPort.postMessage({ type: "complete", handle });
  }
} catch (error) {
  parentPort.postMessage({
    type: "failed",
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
