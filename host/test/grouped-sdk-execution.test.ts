import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

const repository = resolve(import.meta.dirname, "../..");
const registration = new URL("../node_modules/tsx/dist/esm/api/index.mjs", import.meta.url).href;
const entry = new URL("./fixtures/grouped-sdk-execution-worker.ts", import.meta.url).href;
let ordinary: ReturnType<typeof compileSdkFixture> | undefined;
let groupedPath: string;

beforeAll(() => {
  ordinary = compileSdkFixture(new URL("./fixtures/grouped-sdk-mapping.c", import.meta.url), [], { forkInstrument: true });
  groupedPath = `${ordinary.programPath}.grouped.wasm`;
  execFileSync(join(repository, "sdk/bin/wasm32posix-shared-memory"), [
    ordinary.programPath, "-o", groupedPath,
  ], { cwd: repository, stdio: "pipe" });
}, 180_000);
afterAll(() => ordinary?.cleanup());

for (const grouped of [false, true]) {
  it(`runs real SDK libc mapping and I/O in ${grouped ? "grouped" : "ordinary"} dedicated Workers`, async () => {
    const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(entry)});`, {
      eval: true,
      workerData: { grouped, kernelPath: resolveBinary("kernel.wasm"),
        ordinaryPath: ordinary!.programPath, programPath: grouped ? groupedPath : ordinary!.programPath },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error(`kernel Worker exited before result (${code})`)));
        deadline = setTimeout(() => reject(new Error("kernel Worker execution deadline")), 75_000);
      });
      expect(result.failure, JSON.stringify(result)).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
      expect(result.stderr).toBe("");
      expect(result.kernelExit).toBe(0);
      expect(result.processExit).toBe(0);
      expect(result.processReady).toBe(true);
      expect(result.quiescent).toBe(true);
      expect(result.stdout).toContain("heap-ok\n");
      expect(result.stdout).toContain("protection-io-ok\n");
      expect(result.stdout).toContain("moving-remap-ok\n");
      expect(result.stdout).toMatch(/grouped-sdk-mapping PASS checks=\d+\n$/);
      // Ordinary execution retains its documented partial protection model.
      // Only the grouped arm claims EFAULT with the pipe byte unconsumed.
      expect(String(result.stdout).includes("ordinary-protection-partial")).toBe(!grouped);
    } finally {
      if (deadline) clearTimeout(deadline);
      await worker.terminate();
    }
  }, 90_000);
}
