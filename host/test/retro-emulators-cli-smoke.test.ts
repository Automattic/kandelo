/**
 * CLI smoke for the three retro-emulators programs. Each is a libretro core
 * linked statically into one shared frontend, and a static frontend has to
 * supply the libretro-common sources a core normally gets from RetroArch.
 * A symbol nobody supplies becomes a wasm import that traps when called, so
 * "it linked" proves nothing: this test runs each program far enough to
 * initialise its core and report its identity.
 *
 * The core tests stop there on purpose. The ROM path does not exist, so the
 * frontend exits 1 before opening /dev/fb0 or /dev/dsp. A last test runs the
 * NES core on its starter ROM without a terminal, the way a dropped ROM's
 * exchange handler starts it, and quits it with Esc on the machine keyboard
 * device. Rendering, audio and the drop itself are covered in the browser by
 * apps/browser-demos/test/retro-rom-drop.spec.ts.
 *
 * The programs come from the package build (`./run.sh local-build`). The
 * tests skip when the package has not been built.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";

const CORES = [
  { program: "fceumm", core: /FCEUmm/i },
  { program: "genesis-plus-gx", core: /Genesis Plus GX/i },
  { program: "snes9x", core: /Snes9x/i },
] as const;

describe("retro-emulators CLI", () => {
  for (const { program, core } of CORES) {
    const binary = tryResolveBinary(`programs/retro-emulators/${program}.wasm`);

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
  const nes = tryResolveBinary("programs/retro-emulators/fceumm.wasm");
  const rom = tryResolveBinary("programs/retro-emulators/share/retro-emulators/roms/240pee.nes");
  it.skipIf(!nes || !rom || !existsSync(rom))("the NES core takes PAL timing from a European ROM's name", async () => {
    // The test-suite ROM has an NES 2.0 header, whose region field FCEUmm
    // trusts over any name. Rewrite it as iNES 1.0 (no region field), the
    // header most dumps of commercial games carry, so the name decides.
    const bytes = Uint8Array.from(readFileSync(rom!));
    expect(bytes[7] & 0x0c).toBe(0x08);
    bytes[7] &= 0xf0;
    bytes.fill(0, 8, 16);
    const fps = async (name: string) => {
      const image = KandeloImageFs.create();
      image.setImageCapacity(4 * 1024 * 1024);
      ensureDirRecursive(image, "/roms");
      writeVfsBinary(image, `/roms/${name}`, bytes, 0o644);
      // --info loads the ROM, reports the core's timing, and exits.
      const result = await runCentralizedProgram({
        programPath: nes!,
        argv: ["fceumm", `/roms/${name}`, "--info"],
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

  // Started without a terminal (stdin is a pipe here, /dev/null under the
  // exchange handler), the frontend reads the machine keyboard device
  // instead. Esc there must reach it: it is how a player leaves a game no
  // terminal is attached to.
  it.skipIf(!nes || !rom || !existsSync(rom))("without a terminal it reads /dev/input/event0, and Esc quits", async () => {
    const image = KandeloImageFs.create();
    image.setImageCapacity(4 * 1024 * 1024);
    ensureDirRecursive(image, "/roms");
    ensureDirRecursive(image, "/tmp", 0o1777);
    writeVfsBinary(image, "/roms/240pee.nes", Uint8Array.from(readFileSync(rom!)), 0o644);
    const EV_SYN = 0x00, EV_KEY = 0x01, SYN_REPORT = 0x00, KEY_ESC = 1;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const result = await runCentralizedProgram({
        programPath: nes!,
        argv: ["fceumm", "/roms/240pee.nes"],
        rootfsImage: await image.saveImage(),
        timeout: 60_000,
        // An event reaches only descriptors already open on the device, and
        // nothing says from outside when the emulator has opened it, so tap
        // Esc until it exits.
        onKernelReady: (kernel) => {
          timer = setInterval(() => {
            kernel.injectInputEvent(0, EV_KEY, KEY_ESC, 1);
            kernel.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
            kernel.injectInputEvent(0, EV_KEY, KEY_ESC, 0);
            kernel.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
          }, 250);
        },
      });
      const detail = `exit=${result.exitCode} stderr=${result.stderr}`;
      expect(result.stderr, detail).toContain("[retro] keyboard: /dev/input/event0");
      expect(result.stderr, detail).toMatch(/\[retro\] running/);
      expect(result.stderr, detail).toContain("[retro] quit");
      expect(result.exitCode, detail).toBe(0);
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
  }, 90_000);
});
