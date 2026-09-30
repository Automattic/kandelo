import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/sdl2_evdev_smoke.wasm");

describe("SDL2 evdev input backend", () => {
  it.skipIf(!programBinary)(
    "SDL_Init(EVENTS) + SDL_PumpEvents() round-trips on the wasm32 single-threaded path",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["sdl2_evdev_smoke"],
        timeout: 10_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("OK evdev");
      expect(result.stderr).not.toContain("FAIL:");
    },
    // The program is granted 10s above, but vitest's default test timeout
    // is 5s, so the outer limit fired first and the program's own timeout
    // could never apply -- kernel boot plus SDL_Init runs ~12s here. Give
    // the test room for the budget it already hands the program.
    60_000,
  );
});
