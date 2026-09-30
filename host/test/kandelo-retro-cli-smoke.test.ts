/**
 * CLI smoke for the three kandelo-retro programs. Each is a libretro core
 * linked statically into one shared frontend, and a static frontend has to
 * supply the libretro-common sources a core normally gets from RetroArch.
 * A symbol nobody supplies becomes a wasm import that traps when called, so
 * "it linked" proves nothing: this test runs each program far enough to
 * initialise its core and report its identity.
 *
 * It stops there on purpose. The ROM path does not exist, so the frontend
 * exits 1 before opening /dev/fb0 or /dev/dsp; rendering, audio and input are
 * covered in the browser by apps/browser-demos/test/kandelo-retro.spec.ts.
 *
 * The programs come from the package build (`./run.sh local-build`). The
 * tests skip when the package has not been built.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const CORES = [
  { program: "kandelo-retro", core: /FCEUmm/i },
  { program: "kandelo-retro-genesis", core: /Genesis Plus GX/i },
  { program: "kandelo-retro-snes", core: /Snes9x/i },
] as const;

describe("kandelo-retro CLI", () => {
  for (const { program, core } of CORES) {
    const binary = tryResolveBinary(`programs/kandelo-retro/${program}.wasm`);

    it.skipIf(!binary)(`${program} initialises its core and reports a missing ROM`, async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: [program, "/nonexistent/rom"],
        timeout: 30_000,
      });
      const detail = `stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.stderr, detail).toMatch(/\[retro\] core: /);
      expect(result.stderr, detail).toMatch(core);
      expect(result.stderr, detail).toContain("/nonexistent/rom");
      expect(result.exitCode, detail).toBe(1);
    });

    it.skipIf(!binary)(`${program} rejects a bad command line with a usage message`, async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: [program],
        timeout: 30_000,
      });
      expect(result.stderr).toContain("usage:");
      expect(result.exitCode).toBe(2);
    });
  }
});
