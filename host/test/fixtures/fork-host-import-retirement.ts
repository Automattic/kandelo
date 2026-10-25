import { ForkHostImportOwnerRuntime } from "../../src/fork-host-import-runtime";
import { ForkExternrefProcessOwner } from "../../src/fork-externref-process-owner";

const gc = globalThis.gc;
if (typeof gc !== "function") throw new Error("requires --expose-gc");

const processOwner = new ForkExternrefProcessOwner();
const runtime = new ForkHostImportOwnerRuntime(processOwner);

function createWorker(pid: number) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  const generation = processOwner.startGeneration(pid);
  const worker = runtime.createWorker({
    pid,
    generationId: generation.id,
    authorizeSender: () => {
      if (memory.buffer.byteLength === 0) throw new Error("missing memory");
    },
  });
  return { worker, memory: new WeakRef(memory) };
}

const open = createWorker(401);
const closed = createWorker(402);
closed.worker.close();
closed.worker.close();

for (let attempt = 0; attempt < 200; attempt++) {
  // End the job that dereferenced the preceding WeakRef before collecting.
  await new Promise<void>(resolve => setImmediate(resolve));
  gc();
  await new Promise<void>(resolve => setImmediate(resolve));
  if (closed.memory.deref() === undefined) break;
}

const released = closed.memory.deref() === undefined;
const openRetained = open.memory.deref() !== undefined;
// Retain both endpoint handles through the observations. Closing authority
// must release its captured Memory even when the handle itself stays rooted.
const closedPid = closed.worker.binding.pid;
open.worker.close();
process.stdout.write(`${JSON.stringify({ released, openRetained, closedPid })}\n`);
