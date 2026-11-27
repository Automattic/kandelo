import { readFileSync } from "node:fs";
import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { comparisonFileCounts, comparisonRounds } from "../../../benchmarks/namespace-storage";

test("compares current and paged namespace indexes using real OPFS @slow", async ({ page, baseURL }, testInfo) => {
  const path = process.env.KANDELO_NAMESPACE_BENCH_WASM;
  test.skip(path === undefined, "This benchmark requires the namespace-benchmark Wasm artifact");
  test.setTimeout(240_000);
  const route = new URL("/kandelo-namespace-benchmark.wasm", baseURL).href;
  await page.route(route, response => response.fulfill({ body: readFileSync(path!) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const report = await page.evaluate(async (route) => {
    const worker = new Worker("/test/fixtures/namespace-storage-worker.ts", { type: "module" });
    try {
      const bytes = await (await fetch(route)).arrayBuffer();
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.error === undefined ? resolve(data) : reject(new Error(data.error));
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage(bytes, [bytes]);
      });
    } finally { worker.terminate(); }
  }, route) as { samples: unknown[] };
  expect(report.samples).toHaveLength(1 + 2 * comparisonFileCounts.length * comparisonRounds);
  await testInfo.attach("namespace-storage-benchmark", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
});
