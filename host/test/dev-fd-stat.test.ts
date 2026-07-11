import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const devFdStatBinary = tryResolveBinary("programs/dev-fd-stat.wasm");

describe("devfs descriptor aliases", () => {
  it.skipIf(!devFdStatBinary)(
    "stat follows /dev/std{in,out,err} and /dev/fd/N while lstat reports symlinks",
    async () => {
      const result = await runCentralizedProgram({
        programPath: devFdStatBinary!,
        argv: ["dev-fd-stat"],
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("PASS\n");
      expect(result.stderr).toBe("");
    },
  );
});
