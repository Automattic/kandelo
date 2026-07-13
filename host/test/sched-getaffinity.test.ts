import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

describe("sched_getaffinity", () => {
  it.each([
    ["wasm32", "programs/sched-getaffinity.wasm"],
    ["wasm64", "programs/wasm64/sched-getaffinity.wasm"],
  ])(
    "preserves Linux raw and libc semantics for %s",
    async (_arch, path) => {
      const result = await runCentralizedProgram({
        programPath: resolveBinary(path),
        timeout: 10_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("sched-getaffinity-ok raw=4 cpus=1\n");
      expect(result.stderr).toBe("");
    },
    30_000,
  );
});
