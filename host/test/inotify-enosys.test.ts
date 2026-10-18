import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const inotifyBinary = tryResolveBinary("programs/inotify-enosys.wasm");

describe("inotify syscall family", () => {
  it.skipIf(!inotifyBinary)(
    "every inotify entry point fails with ENOSYS so watchers take their polling fallbacks",
    async () => {
      const result = await runCentralizedProgram({
        programPath: inotifyBinary!,
        argv: ["inotify-enosys"],
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("PASS\n");
      expect(result.stderr).toBe("");
    },
  );
});
