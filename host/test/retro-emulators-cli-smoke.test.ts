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
 * exchange handler starts it, and quits it with Ctrl+C on the machine keyboard
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
  // instead. Ctrl+C there must reach it: it is how a player leaves a game no
  // terminal is attached to, and Esc alone must not.
  it.skipIf(!nes || !rom || !existsSync(rom))("without a terminal it reads /dev/input/event0, and Ctrl+C quits", async () => {
    const image = KandeloImageFs.create();
    image.setImageCapacity(4 * 1024 * 1024);
    ensureDirRecursive(image, "/roms");
    ensureDirRecursive(image, "/tmp", 0o1777);
    writeVfsBinary(image, "/roms/240pee.nes", Uint8Array.from(readFileSync(rom!)), 0o644);
    const EV_SYN = 0x00, EV_KEY = 0x01, SYN_REPORT = 0x00;
    const KEY_ESC = 1, KEY_LEFTCTRL = 29, KEY_C = 46;
    const tap = (kernel: { injectInputEvent(d: 0 | 1, t: number, c: number, v: number): void }, ...keys: number[]) => {
      for (const key of keys) {
        kernel.injectInputEvent(0, EV_KEY, key, 1);
        kernel.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      }
      for (const key of [...keys].reverse()) {
        kernel.injectInputEvent(0, EV_KEY, key, 0);
        kernel.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let started = 0;
    try {
      const result = await runCentralizedProgram({
        programPath: nes!,
        argv: ["fceumm", "/roms/240pee.nes"],
        rootfsImage: await image.saveImage(),
        timeout: 60_000,
        // An event reaches only descriptors already open on the device, and
        // nothing says from outside when the emulator has opened it. So Esc
        // is tapped for the first few seconds (it must not quit), then
        // Ctrl+C until the emulator exits.
        onKernelReady: (kernel) => {
          started = Date.now();
          timer = setInterval(() => {
            if (Date.now() - started < 4_000) tap(kernel, KEY_ESC);
            else tap(kernel, KEY_LEFTCTRL, KEY_C);
          }, 250);
        },
      });
      const detail = `exit=${result.exitCode} stderr=${result.stderr}`;
      expect(result.stderr, detail).toContain("[retro] keyboard: /dev/input/event0");
      expect(result.stderr, detail).toMatch(/\[retro\] running/);
      expect(result.stderr, detail).toContain("[retro] quit");
      expect(result.exitCode, detail).toBe(0);
      // It ran through the Esc taps: only Ctrl+C, sent after them, ended it.
      expect(Date.now() - started, detail).toBeGreaterThanOrEqual(4_000);
      expect(result.stderr, detail).toMatch(/^Keys for FCEUmm:$/m);
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
  }, 90_000);

  // --keys prints which key is which button using the core's own button
  // names, so each system's list says what its controller calls them.
  const KEY_LISTS = [
    {
      program: "fceumm",
      rom: "240pee.nes",
      lines: [["Z", "B"], ["X", "A"], ["Enter", "Start"], ["Right Shift", "Select"], ["Up", "D-Pad Up"]],
    },
    {
      program: "genesis-plus-gx",
      rom: "240pSuite-md-1.21.bin",
      lines: [["A", "A"], ["Z", "B"], ["X", "C"], ["Q", "X"], ["S", "Y"], ["W", "Z"], ["Right Shift", "Mode"]],
    },
    {
      program: "snes9x",
      rom: "240pSuite-snes-1.03.sfc",
      lines: [["Z", "B"], ["X", "A"], ["A", "Y"], ["S", "X"], ["Q", "L"], ["W", "R"], ["Right Shift", "Select"]],
    },
  ] as const;
  for (const { program, rom: romName, lines } of KEY_LISTS) {
    const binary = tryResolveBinary(`programs/retro-emulators/${program}.wasm`);
    const romPath = tryResolveBinary(`programs/retro-emulators/share/retro-emulators/roms/${romName}`);
    it.skipIf(!binary || !romPath || !existsSync(romPath))(`${program} --keys lists its keys by the core's button names`, async () => {
      const image = KandeloImageFs.create();
      image.setImageCapacity(8 * 1024 * 1024);
      ensureDirRecursive(image, "/roms");
      writeVfsBinary(image, `/roms/${romName}`, Uint8Array.from(readFileSync(romPath!)), 0o644);
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: [program, `/roms/${romName}`, "--keys"],
        rootfsImage: await image.saveImage(),
        timeout: 30_000,
      });
      const detail = `exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.exitCode, detail).toBe(0);
      // A core may print its own chatter first (Snes9x prints its memory map).
      expect(result.stdout, detail).toMatch(/^Keys for /m);
      for (const [key, button] of lines) {
        expect(result.stdout, detail).toMatch(new RegExp(`^  ${key.padEnd(12)} ${button}$`, "m"));
      }
      expect(result.stdout, detail).toMatch(/^  Ctrl\+C {7}quit$/m);
    }, 60_000);
  }
});
