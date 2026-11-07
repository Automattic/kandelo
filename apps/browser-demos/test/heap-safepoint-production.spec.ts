import { expect, test } from "../playwright-test";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";

test("production tree shaking preserves each host heap checkpoint allocation", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "kandelo-heap-checkpoint-"));
  const entry = join(directory, "entry.ts");
  const source = fileURLToPath(new URL("../../../host/src/heap-safepoint.ts", import.meta.url));
  await writeFile(entry, `export { createHeapSafepointImport } from ${JSON.stringify(source)};`);
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: "terser",
      lib: { entry, name: "HeapSafepointProduction", formats: ["iife"] },
    },
  }).finally(() => rm(directory, { recursive: true, force: true }));
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap(output => "output" in output ? output.output : [])
    .find(output => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("No production checkpoint bundle");
  await page.addScriptTag({ content: chunk.code });
  const observed = await page.evaluate(() => {
    const runtime = (window as unknown as {
      HeapSafepointProduction: { createHeapSafepointImport: (ua: string) => () => bigint };
    }).HeapSafepointProduction;
    const original = window.ArrayBuffer;
    const allocations: ArrayBuffer[] = [];
    window.ArrayBuffer = new Proxy(original, {
      construct(target, args) {
        const allocation = Reflect.construct(target, args) as ArrayBuffer;
        allocations.push(allocation);
        return allocation;
      },
    });
    try {
      const checkpoint = runtime.createHeapSafepointImport("Version/26.6 Safari/605.1.15");
      const bounds = [checkpoint().toString(), checkpoint().toString(), checkpoint().toString()];
      return { bounds, sizes: allocations.map(buffer => buffer.byteLength),
        distinct: new Set(allocations).size };
    } finally {
      window.ArrayBuffer = original;
    }
  });
  expect(observed).toEqual({
    bounds: ["100000000", "100000000", "100000000"], sizes: [8, 8, 8], distinct: 3,
  });
});
