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
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

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

  // FCEUmm takes an iNES 1.0 ROM's TV system from tags in its file name,
  // "(E)" or "(Europe)" for PAL (src/ines.c). A launcher that renames ROMs
  // must keep those tags, or a European game runs at NTSC speed and pitch.
  const nes = tryResolveBinary("programs/kandelo-retro/kandelo-retro.wasm");
  const rom = tryResolveBinary("programs/kandelo-retro/share/kandelo-retro/roms/240pee.nes");
  it.skipIf(!nes || !rom || !existsSync(rom))("the NES core takes PAL timing from a European ROM's name", async () => {
    // The test-suite ROM has an NES 2.0 header, whose region field FCEUmm
    // trusts over any name. Rewrite it as iNES 1.0 (no region field), the
    // header most dumps of commercial games carry, so the name decides.
    const bytes = Uint8Array.from(readFileSync(rom!));
    expect(bytes[7] & 0x0c).toBe(0x08);
    bytes[7] &= 0xf0;
    bytes.fill(0, 8, 16);
    const fps = async (name: string) => {
      const image = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
      image.mkdir("/roms", 0o755);
      image.createFileWithOwner(`/roms/${name}`, 0o644, 0, 0, bytes);
      // --info loads the ROM, reports the core's timing, and exits.
      const result = await runCentralizedProgram({
        programPath: nes!,
        argv: ["kandelo-retro", `/roms/${name}`, "--info"],
        rootfsImage: await image.saveImage(),
        timeout: 30_000,
      });
      const match = /\[retro\] av: \S+ fps=([0-9.]+)/.exec(result.stderr);
      expect(match, `exit=${result.exitCode} stderr=${result.stderr}`).not.toBeNull();
      expect(result.exitCode).toBe(0);
      return Number(match![1]);
    };
    expect(await fps("rom.nes")).toBeCloseTo(60.1, 1);
    expect(await fps("Demo (E).nes")).toBeCloseTo(50.0, 1);
  }, 90_000);
});
