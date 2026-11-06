import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const program = tryResolveBinary("programs/getgroups-large-buffer.wasm");

describe("getgroups", () => {
  it.skipIf(!program)("accepts a buffer larger than NGROUPS_MAX and rejects only a short one", async () => {
    const result = await runCentralizedProgram({
      programPath: program!,
      argv: ["getgroups-large-buffer"],
      useDefaultRootfs: false,
    });
    expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("PASS\n");
  });
});
