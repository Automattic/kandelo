import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAbiVersion } from "../../../../../host/src/constants";
import { tryResolveBinary } from "../../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../../..");

function currentAbiVersion(): number {
  const snapshot = JSON.parse(
    readFileSync(join(repoRoot, "abi/snapshot.json"), "utf8"),
  ) as { abi_version: number };
  return snapshot.abi_version;
}

function loadArrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const hasKernelWasm = tryResolveBinary("kernel.wasm") !== null;
const jsWasm = tryResolveBinary("programs/js.wasm");
const jsWasmAbi = jsWasm ? extractAbiVersion(loadArrayBuffer(jsWasm)) : null;
const abiVersion = currentAbiVersion();

test.skip(!hasKernelWasm, "kernel.wasm is not built or fetched");
test.skip(!jsWasm, "SpiderMonkey js.wasm is not built or fetched");
test.skip(
  jsWasmAbi !== abiVersion,
  `SpiderMonkey js.wasm ABI ${jsWasmAbi ?? "unknown"} does not match current ABI ${abiVersion}; rebuild spidermonkey before running this stress test`,
);

test("repeated /usr/bin/js browser launches stay compact and do not leak processes", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return status && (status.textContent === "done" || status.textContent === "error");
    },
    { timeout: 180_000 },
  );

  const status = await page.locator("#status").textContent();
  const stderr = await page.locator("#stderr").textContent();
  const resultsText = await page.locator("#results").textContent();
  if (status === "error") {
    console.log("STDERR:", stderr);
    console.log("RESULTS:", resultsText);
  }

  expect(status).toBe("done");
  const results = JSON.parse(resultsText!);
  expect(results.iterations).toBe(7);
  expect(results.maxObservedMemoryBytes).toBeLessThan(512 * 1024 * 1024);
  expect(results.leakedPids).toEqual([]);
  expect(results.stdout).toContain("stress-ok-6");
});
