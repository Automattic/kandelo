import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const ptrWidth of [4, 8] as const) {
  test(`shared memory${ptrWidth * 8} growth distinguishes fresh and competing pages`, async ({ page, baseURL }) => {
    await page.goto("/trap-signal-test.html");
    const moduleUrl = new URL(`/@fs/${repo}/host/src/process-memory.ts`, baseURL!).href;
    const result = await page.evaluate(async ({ moduleUrl, ptrWidth }) => {
      const { growMemoryToCover, growMemoryToCoverWithFreshBoundary: grow } =
        await import(/* @vite-ignore */ moduleUrl);
      const pageBytes = 65_536;
      const create = (maximum = 8) => new WebAssembly.Memory((ptrWidth === 8
        ? { initial: 1n, maximum: BigInt(maximum), shared: true, address: "i64" }
        : { initial: 1, maximum, shared: true }) as unknown as WebAssembly.MemoryDescriptor);
      const count = (pages: number) => ptrWidth === 8 ? BigInt(pages) : pages;
      const unchanged = create();
      new Uint8Array(unchanged.buffer).fill(0xa5);
      const noGrowth = grow(unchanged, pageBytes, ptrWidth);

      const fresh = create();
      new Uint8Array(fresh.buffer).fill(0xa5);
      const freshBoundary = grow(fresh, 3 * pageBytes, ptrWidth);

      const competing = create();
      const realGrow = competing.grow.bind(competing) as (pages: number | bigint) => number | bigint;
      Object.defineProperty(competing, "grow", { value(delta: number | bigint) {
        realGrow(count(1));
        new Uint8Array(competing.buffer, pageBytes, pageBytes).fill(0x7e);
        return realGrow(delta);
      } });
      const competingBoundary = grow(competing, 3 * pageBytes, ptrWidth);

      const covered = create(3);
      const growCovered = covered.grow.bind(covered) as (pages: number | bigint) => number | bigint;
      Object.defineProperty(covered, "grow", { value(delta: number | bigint) {
        growCovered(count(2));
        new Uint8Array(covered.buffer, pageBytes).fill(0x7e);
        return growCovered(delta); // Our stale delta now exceeds the maximum.
      } });
      const coveredBoundary = grow(covered, 3 * pageBytes, ptrWidth);

      let capacityFailure = false;
      try {
        grow(create(2), 3 * pageBytes, ptrWidth);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        capacityFailure = true;
      }
      return {
        publicReturnIsVoid: growMemoryToCover(create(), 2 * pageBytes, ptrWidth) === undefined,
        noGrowthClaim: noGrowth === undefined,
        existingDataIntact: new Uint8Array(unchanged.buffer).every(value => value === 0xa5),
        freshBoundary,
        prefixIntact: new Uint8Array(fresh.buffer, 0, pageBytes).every(value => value === 0xa5),
        freshPagesZero: new Uint8Array(fresh.buffer, pageBytes).every(value => value === 0),
        competingBoundary,
        competingDataIntact: new Uint8Array(competing.buffer, pageBytes, pageBytes).every(value => value === 0x7e),
        ownPagesZero: new Uint8Array(competing.buffer, 2 * pageBytes).every(value => value === 0),
        coveredHasNoFreshPages: coveredBoundary === undefined,
        coveredDataIntact: new Uint8Array(covered.buffer, pageBytes).every(value => value === 0x7e),
        capacityFailure,
      };
    }, { moduleUrl, ptrWidth });
    expect(result).toEqual({
      publicReturnIsVoid: true,
      noGrowthClaim: true,
      existingDataIntact: true,
      freshBoundary: 65_536,
      prefixIntact: true,
      freshPagesZero: true,
      competingBoundary: 2 * 65_536,
      competingDataIntact: true,
      ownPagesZero: true,
      coveredHasNoFreshPages: true,
      coveredDataIntact: true,
      capacityFailure: true,
    });
  });
}

for (const pointerWidth of [4, 8] as const) {
  for (const mode of ["append", "covered", "insufficient"] as const) {
    test(`shared memory${pointerWidth * 8} handles ${mode} growth from another worker`, async ({ page, baseURL }) => {
      await page.goto("/trap-signal-test.html");
      const workerUrl = new URL(`/@fs/${repo}/host/test/fixtures/process-memory-growth-browser-worker.ts`, baseURL!).href;
      const result = await page.evaluate(async ({ workerUrl, pointerWidth, mode }) => {
        const maximum = mode === "append" ? 8 : mode === "covered" ? 3 : 2;
        const memory = new WebAssembly.Memory((pointerWidth === 8
          ? { initial: 1n, maximum: BigInt(maximum), shared: true, address: "i64" }
          : { initial: 1, maximum, shared: true }) as unknown as WebAssembly.MemoryDescriptor);
        const gate = new SharedArrayBuffer(4);
        const worker = new Worker(workerUrl, { type: "module" });
        const next = () => new Promise<Record<string, unknown>>((resolveMessage, reject) => {
          const timer = setTimeout(() => reject(new Error("Worker message timed out")), 10_000);
          worker.onmessage = event => { clearTimeout(timer); resolveMessage(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        });
        try {
          const paused = next();
          worker.postMessage({ memory, pointerWidth, gate });
          if ((await paused).type !== "paused") throw new Error("Worker did not reach growth barrier");
          const completed = next();
          const pages = mode === "covered" ? 2 : 1;
          memory.grow((pointerWidth === 8 ? BigInt(pages) : pages) as number);
          new Uint8Array(memory.buffer, 65_536).fill(0x7e);
          Atomics.store(new Int32Array(gate), 0, 1);
          Atomics.notify(new Int32Array(gate), 0);
          return await completed;
        } finally {
          worker.terminate();
        }
      }, { workerUrl, pointerWidth, mode });
      if (mode === "insufficient") {
        expect(result).toMatchObject({ type: "error", name: "RangeError", bytes: 2 * 65_536 });
      } else {
        expect(result).toEqual({
          type: "result", boundary: mode === "append" ? 2 * 65_536 : null,
          bytes: (mode === "append" ? 4 : 3) * 65_536,
          peerByte: 0x7e, freshZero: mode === "append" ? true : null,
        });
      }
    });
  }
}
