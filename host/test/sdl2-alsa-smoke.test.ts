import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/sdl2_alsa_smoke.wasm");

describe("SDL2 ALSA audio backend", () => {
  it.skipIf(!programBinary)(
    "SDL_Init(AUDIO) reports `alsa` against /dev/snd/pcmC0D0p",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["sdl2_alsa_smoke"],
        timeout: 10_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("OK alsa alsa");
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
