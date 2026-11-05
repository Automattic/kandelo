import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const xattrBinary = tryResolveBinary("programs/xattr-unsupported.wasm");

describe("extended attributes without filesystem support", () => {
  it.skipIf(!xattrBinary)(
    "get/set/remove report ENOTSUP, list is empty, and path errors come first",
    async () => {
      const result = await runCentralizedProgram({
        programPath: xattrBinary!,
        argv: ["xattr-unsupported"],
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("PASS\n");
      expect(result.stderr).toBe("");
    },
  );
});
