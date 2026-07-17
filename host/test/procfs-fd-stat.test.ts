import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const program = tryResolveBinary("programs/procfs-foreign-fd-stat.wasm");

describe("procfs fd metadata", () => {
  it.skipIf(!program)(
    "follows a foreign process fd to its live OFD",
    async () => {
      const result = await runCentralizedProgram({
        programPath: program!,
        argv: ["procfs-foreign-fd-stat"],
        timeout: 15_000,
      });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("procfs-foreign-fd-stat-ok\n");
      expect(result.stderr).toBe("");
    },
  );
});
