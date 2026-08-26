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
  );
});
