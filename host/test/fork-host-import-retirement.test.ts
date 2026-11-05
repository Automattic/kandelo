import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("closed import handles release captured process memory while open handles retain it", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--expose-gc",
    "--import",
    fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./fixtures/fork-host-import-retirement.ts", import.meta.url)),
  ], { timeout: 30_000 });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    released: true,
    openRetained: true,
    closedPid: 402,
  });
});
