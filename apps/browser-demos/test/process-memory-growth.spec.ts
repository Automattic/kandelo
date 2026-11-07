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
