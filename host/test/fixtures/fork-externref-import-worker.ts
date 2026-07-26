import { parentPort, workerData } from "node:worker_threads";
import {
  defineForkExternrefImport,
  type ForkExternrefImportBinding,
  type ForkExternrefImportWake,
  ForkExternrefImportWorkerCaller,
} from "../../src/fork-externref-import-mailbox";
import { ForkExternrefTokenCache } from "../../src/fork-reference-broker";

const {
  mailbox,
  binding,
  inputHandle,
} = workerData as {
  mailbox: SharedArrayBuffer;
  binding: ForkExternrefImportBinding;
  inputHandle: number;
};

const aliasDescriptor = defineForkExternrefImport(
  30,
  ["externref", "i64"],
  ["externref", "i64"],
);
const throwingDescriptor = defineForkExternrefImport(
  31,
  ["i32"],
  ["i32"],
);
const tokens = new ForkExternrefTokenCache(binding.generationId);
const caller = new ForkExternrefImportWorkerCaller(
  mailbox,
  binding,
  tokens,
  (wake: ForkExternrefImportWake) => {
    parentPort!.postMessage({ type: "wake", wake });
  },
);

try {
  const input = tokens.materialize(inputHandle);
  const [alias, scalar] = caller.call(
    aliasDescriptor,
    [input, -9n],
  ) as [unknown, bigint];

  let exception: unknown;
  try {
    caller.call(throwingDescriptor, [7]);
    throw new Error("owner import unexpectedly returned");
  } catch (error) {
    exception = error;
  }

  parentPort!.postMessage({
    type: "complete",
    resultHandle: tokens.encode(alias),
    resultScalar: scalar,
    exceptionHandle: tokens.encode(exception),
  });
} catch (error) {
  parentPort!.postMessage({
    type: "failed",
    message: error instanceof Error
      ? error.stack ?? error.message
      : String(error),
  });
}
