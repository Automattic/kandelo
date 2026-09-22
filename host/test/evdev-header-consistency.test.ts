/**
 * Proves the vendored Linux UAPI header stays consistent with the kernel's
 * authoritative evdev codes. `INPUT_CODES` is generated from
 * `crates/shared/src/lib.rs::input::CODE_TABLE` (what the kernel produces),
 * and `libc/musl-overlay/include/linux/input-event-codes.h` is the vendored
 * userspace header every evdev consumer (SDL, etc.) compiles against. If the
 * two ever drift, a program would read a different numeric value than the
 * kernel emits — this test fails loudly instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INPUT_CODES } from "../src/generated/abi.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function parseDefines(relPath: string): Record<string, number> {
  const text = readFileSync(new URL(relPath, `file://${repoRoot}`), "utf8");
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    // #define NAME 0x110   |   #define NAME 30   (tab- or space-separated)
    const m = line.match(/^#define\s+([A-Z0-9_]+)\s+(0[xX][0-9a-fA-F]+|\d+)\b/);
    if (m) out[m[1]] = parseInt(m[2], m[2].toLowerCase().startsWith("0x") ? 16 : 10);
  }
  return out;
}

describe("vendored evdev header ↔ kernel INPUT_CODES", () => {
  it("every kernel evdev code has the same value in the vendored header", () => {
    const header = parseDefines(
      "libc/musl-overlay/include/linux/input-event-codes.h",
    );
    const mismatches: string[] = [];
    for (const [name, value] of Object.entries(INPUT_CODES)) {
      if (!(name in header)) {
        mismatches.push(`${name}: absent from vendored header`);
      } else if (header[name] !== value) {
        mismatches.push(
          `${name}: header=${header[name]} kernel=${value as number}`,
        );
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("the vendored header is the complete UAPI, not a subset (sanity anchors)", () => {
    const header = parseDefines(
      "libc/musl-overlay/include/linux/input-event-codes.h",
    );
    // Codes SDL/joystick/touch reference that the original 223-line subset
    // lacked — presence proves we vendored the full header.
    for (const anchor of [
      "ABS_RZ",
      "BTN_TOUCH",
      "BTN_STYLUS",
      "REL_MAX",
      "ABS_MAX",
      "KEY_MAX",
      "BTN_GAMEPAD",
      "SW_MAX",
      "ABS_MT_POSITION_X",
    ]) {
      expect(header, `header missing ${anchor}`).toHaveProperty(anchor);
    }
  });
});
