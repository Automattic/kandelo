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
    // The program is granted 10s above, but vitest's default test timeout
    // is 5s, so the outer limit fired first and the program's own timeout
    // could never apply -- kernel boot plus SDL_Init runs ~12s here. Give
    // the test room for the budget it already hands the program.
    60_000,
  );
});
