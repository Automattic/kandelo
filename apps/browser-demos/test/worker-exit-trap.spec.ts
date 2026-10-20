import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from "./support/browser-memory-boundary";

test("memory probe detects reloads, main allocations, and guest backing in worker messages", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const beforeReload = await memoryBoundaryRealmId(page);
  await page.reload();
  expect(await memoryBoundaryRealmId(page)).not.toBe(beforeReload);
  await page.evaluate(async () => {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const url = URL.createObjectURL(new Blob([`
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
      postMessage({ type: "response", result: {
        memory, view: new Uint8Array(memory.buffer, 0, 1)
      } });
    `], { type: "text/javascript" }));
    const worker = new Worker(url);
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = () => resolve();
        worker.onerror = event => reject(new Error(event.message));
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  expect(await memoryBoundaryFailures(page)).toEqual([
    "browser main allocated shared Wasm memory",
    "message.result.memory: whole WebAssembly.Memory reached browser main",
    "message.result.view: shared view retains its entire backing memory",
  ]);
});

// Source-only: this must run in the routine three-engine smoke gate.
test("process exit escapes guest exception handlers", async ({ page, baseURL }) => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ importsUrl, abiUrl }) => {
    const { buildKernelImportsForTest, isExecRetirementMarker } = await import(/* @vite-ignore */ importsUrl);
    const { CH_SIG_SIGNUM, CH_SIG_SI_CODE } = await import(/* @vite-ignore */ abiUrl);
    const { EXEC_RETIRE_SIGNAL_CODE } = await import(/* @vite-ignore */ importsUrl.replace("worker-main.ts", "worker-protocol.ts"));
    // A Wasm try_table/catch_all returns 1 if the import's exception is catchable.
    const guest = new WebAssembly.Module(new Uint8Array([
      0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,2,13,1,4,104,
      111,115,116,4,101,120,105,116,0,0,3,2,1,1,7,7,1,3,114,117,110,0,
      1,10,23,1,21,0,2,64,31,64,1,2,0,65,137,1,16,0,11,65,0,15,11,65,1,11,
    ]));
    const runWith = (exit: CallableFunction) =>
      new WebAssembly.Instance(guest, { host: { exit } }).exports.run as () => number;
    const caught = runWith(() => { throw new WebAssembly.RuntimeError("unreachable"); })();
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(channelOffset + CH_SIG_SI_CODE, EXEC_RETIRE_SIGNAL_CODE, true);
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);
    let trapped = false;
    try {
      runWith(imports.kernel_exit)();
    } catch (error) {
      trapped = error instanceof WebAssembly.RuntimeError;
    }
    return { caught, trapped, marker: isExecRetirementMarker(view, channelOffset) };
  }, {
    importsUrl: new URL(`/@fs/${repoRoot}/host/src/worker-main.ts`, baseURL).href,
    abiUrl: new URL(`/@fs/${repoRoot}/host/src/generated/abi.ts`, baseURL).href,
  });
  expect(result).toEqual({ caught: 1, trapped: true, marker: true });
});
