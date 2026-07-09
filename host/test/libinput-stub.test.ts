import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/libinput_stub_smoke.wasm");

describe("libinput-lite no-op stub", () => {
  it.skipIf(!programBinary)(
    "all entry points link + return NULL/0 (forces consumers to evdev fallback)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["libinput_stub_smoke"],
        timeout: 5_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout.trim()).toBe("OK");
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
