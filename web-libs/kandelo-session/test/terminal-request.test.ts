/**
 * The terminal request format: what a program in the machine may ask the app
 * to type at a new terminal's prompt.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidTerminalRequestError,
  MAX_TERMINAL_REQUEST_BYTES,
  parseTerminalRequest,
} from "../src/terminal-request";

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("parseTerminalRequest", () => {
  it("accepts a command, a title and an optional framebuffer display", () => {
    expect(parseTerminalRequest(bytes({ version: 1, command: "retro-run ~/roms/x.nes", title: "x.nes" })))
      .toEqual({ command: "retro-run ~/roms/x.nes", title: "x.nes" });
    expect(parseTerminalRequest(bytes({ version: 1, command: "fbdoom", title: "DOOM", display: "framebuffer" })))
      .toEqual({ command: "fbdoom", title: "DOOM", display: "framebuffer" });
  });

  it.each([
    ["not JSON", "retro-run x", /not UTF-8 JSON/],
    ["an array", [], /not a JSON object/],
    ["another version", { version: 2, command: "ls", title: "ls" }, /not version 1/],
    ["no command", { version: 1, title: "ls" }, /has no command/],
    ["an empty title", { version: 1, command: "ls", title: "" }, /has no title/],
    ["a newline in the command", { version: 1, command: "ls\nreboot", title: "ls" }, /command contains control characters/],
    ["an escape in the title", { version: 1, command: "ls", title: "\u001b[2J" }, /title contains control characters/],
    ["a long command", { version: 1, command: "x".repeat(2049), title: "x" }, /command is longer than 2048/],
    ["an unknown display", { version: 1, command: "ls", title: "ls", display: "kms" }, /unknown display "kms"/],
    ["an unknown field", { version: 1, command: "ls", title: "ls", user: "root" }, /unknown field "user"/],
  ])("refuses %s", (_what, value, message) => {
    expect(() => parseTerminalRequest(bytes(value))).toThrow(InvalidTerminalRequestError);
    expect(() => parseTerminalRequest(bytes(value))).toThrow(message);
  });

  it("shortens a long title, which is only a label", () => {
    const title = "Super Mario All-Stars + Super Mario World (USA) (Rev 1) [!] - a very long name.sfc";
    const parsed = parseTerminalRequest(bytes({ version: 1, command: "ls", title }));
    expect([...parsed.title]).toHaveLength(80);
    expect(parsed.title.endsWith("…")).toBe(true);
  });

  it("refuses a request over the size limit before parsing it", () => {
    expect(() => parseTerminalRequest(new Uint8Array(MAX_TERMINAL_REQUEST_BYTES + 1)))
      .toThrow(/larger than 4096 bytes/);
  });
});
