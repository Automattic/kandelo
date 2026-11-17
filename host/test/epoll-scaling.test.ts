import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Dedicated diagnostic selection; all cases run normally when selected. The
// output keeps SDK/channel work inside each phase and setup/cleanup visible.
describe("epoll scaling diagnostic", () => {
  for (const count of [32, 2048]) {
    for (const mode of ["lt", "et"]) {
      it(`${count} registrations, ${mode}`, async () => {
        const result = await runCentralizedProgram({
          programPath: resolve(root, "examples/epoll_semantics_test.wasm"),
          argv: ["epoll-scale", "--bench", String(count), mode],
          useDefaultRootfs: false, timeout: 120_000,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.hostDiagnostics).toEqual([]);
        expect(result.stdout).toContain('"phase":"total"');
        console.log(`EPOLL_SCALE_CONTEXT ${JSON.stringify({ host: "node", count, mode, node: process.version })}`);
        console.log(result.stdout);
      }, 135_000);
    }
  }
});
