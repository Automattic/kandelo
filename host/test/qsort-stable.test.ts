import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const qsortStableBinary = tryResolveBinary("programs/qsort-stable.wasm");

describe("libc qsort", () => {
  it.skipIf(!qsortStableBinary)(
    "keeps rows with equal keys in their input order",
    async () => {
      const result = await runCentralizedProgram({
        programPath: qsortStableBinary!,
        argv: ["qsort-stable"],
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("PASS\n");
      expect(result.stderr).toBe("");
    },
  );
});
