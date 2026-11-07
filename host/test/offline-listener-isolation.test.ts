import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("two offline guests can listen concurrently without publishing host ports", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--experimental-wasm-exnref", "--import", "tsx/esm",
    fileURLToPath(new URL("./fixtures/offline-listener-run.ts", import.meta.url)),
  ], { timeout: 30_000 });
  expect(stdout).toContain('"overlapping":true');
  expect(stdout).toContain('"exits":[0,0]');
  expect(stderr).not.toContain("TCP listener error");
  expect(stderr).not.toContain("EADDRINUSE");
}, 40_000);
