import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/sdl2_kmsdrm_smoke.wasm");

describe("SDL2 KMSDRM video backend", () => {
  it.skipIf(!programBinary)(
    "SDL_Init(VIDEO) selects KMSDRM against /dev/dri/card0",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["sdl2_kmsdrm_smoke"],
        timeout: 10_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      // "KMSDRM" — confirms SDL2 didn't silently downgrade to "dummy".
      expect(result.stdout).toContain("OK kmsdrm KMSDRM");
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
