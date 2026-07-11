import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

describe("sched_getaffinity", () => {
  it("copies the single-CPU mask into process memory", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/sched-getaffinity.wasm"),
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sched-getaffinity-ok cpus=1\n");
    expect(result.stderr).toBe("");
  });
});
