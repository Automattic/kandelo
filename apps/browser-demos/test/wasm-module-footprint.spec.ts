import { appendFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { test } from "./support/streamed-artifacts";
import { sampleBrowserNativeMemory } from "./support/browser-native-memory";

const programPath = process.env.KANDELO_WASM_MODULE_FOOTPRINT_INPUT;

// This control never instantiates a module or executes guest code. It isolates
// fetching, compilation and module transfer from a real service's footprint.
test("Wasm module footprint without guest instances", async ({ page, baseURL, serveArtifacts }) => {
  test.setTimeout(120_000);
  test.skip(!programPath, "Select an exact artifact with KANDELO_WASM_MODULE_FOOTPRINT_INPUT");
  const phases: unknown[] = [];
  const evidencePath = test.info().outputPath("module-memory-phases.jsonl");
  await page.exposeFunction("recordModuleMemoryPhase", async (phase: unknown) => {
    const native = await sampleBrowserNativeMemory(page);
    const record = { recordedAt: new Date().toISOString(), phase, native };
    phases.push(record);
    appendFileSync(evidencePath, JSON.stringify(record) + "\n");
  });
  const { program } = await serveArtifacts({
    program: { path: programPath!, contentType: "application/wasm" },
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
  const result = await page.evaluate(async ({ program }) => {
    const source = `
let bytes, module;
self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case "fetch": {
        const response = await fetch(data.url);
        if (!response.ok) throw new Error("artifact HTTP " + response.status);
        bytes = await response.arrayBuffer();
        self.postMessage({ bytes: bytes.byteLength });
        break;
      }
      case "compile":
        module = await WebAssembly.compile(bytes);
        self.postMessage({ module });
        break;
      case "drop-bytes":
        bytes = undefined;
        self.postMessage({ dropped: true });
        break;
      case "hold":
        module = data.module;
        if (!(module instanceof WebAssembly.Module)) throw new Error("not a module");
        self.postMessage({ held: true });
        break;
      default: throw new Error("unexpected control command");
    }
  } catch (error) { self.postMessage({ error: String(error) }); }
};`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const workers = new Set<Worker>();
    let module: WebAssembly.Module | undefined;
    const create = () => {
      const worker = new Worker(url);
      workers.add(worker);
      return worker;
    };
    type Reply = { error?: string; bytes?: number; module?: WebAssembly.Module };
    const request = (worker: Worker, message: unknown) => new Promise<Reply>((resolve, reject) => {
      const receive = (event: MessageEvent<Reply>) => {
        cleanup();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      const fail = (event: ErrorEvent) => { cleanup(); reject(new Error(event.message)); };
      const cleanup = () => {
        worker.removeEventListener("message", receive);
        worker.removeEventListener("error", fail);
      };
      worker.addEventListener("message", receive);
      worker.addEventListener("error", fail);
      worker.postMessage(message);
    });
    const phase = async (name: string) => {
      const startedAt = new Date().toISOString();
      // Leave a window for the optional inspector's periodic samples. This is
      // observation time, not a timed compile or a forced-collection policy.
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await (globalThis as typeof globalThis & {
        recordModuleMemoryPhase(record: unknown): Promise<void>;
      }).recordModuleMemoryPhase({ name, startedAt, finishedAt: new Date().toISOString(),
        directWorkers: workers.size, guestInstances: 0 });
    };
    try {
      await phase("page baseline");
      const compiler = create();
      const fetched = await request(compiler, { type: "fetch", url: program });
      await phase("artifact bytes held");
      module = (await request(compiler, { type: "compile" })).module;
      await phase("module compiled, artifact bytes held");
      await request(compiler, { type: "drop-bytes" });
      await phase("artifact byte reference released");
      for (const count of [1, 4, 8]) {
        while (workers.size < count + 1) {
          await request(create(), { type: "hold", module });
        }
        await phase(`compiled module held by ${count} additional workers`);
      }
      for (const worker of workers) worker.terminate();
      workers.clear();
      module = undefined;
      await phase("workers terminated and module references released");
      return { bytes: fetched.bytes, guestInstances: 0 };
    } finally {
      for (const worker of workers) worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, { program });
  await test.info().attach("module-memory-phases", {
    path: evidencePath, contentType: "application/x-ndjson",
  });
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.guestInstances).toBe(0);
  expect(phases).toHaveLength(8);
});
