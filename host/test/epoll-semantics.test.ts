import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
describe("guest epoll delivery and lifecycle", () => {
  for (const [arch, suffix] of [["wasm32", ".wasm"], ["wasm64", ".wasm64.wasm"]]) {
    it(`${arch} preserves edges, rearming, data, waits, masks and device readiness`, async () => {
      const result = await runCentralizedProgram({
        programPath: resolve(root, `examples/epoll_semantics_test${suffix}`),
        argv: ["epoll-semantics"], useDefaultRootfs: false, timeout: 60_000,
        execPrograms: new Map([["/epoll-self", resolve(root, `examples/epoll_semantics_test${suffix}`)]]),
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("EPOLL_SEMANTICS_PASS");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    }, 75_000);
  }
});
