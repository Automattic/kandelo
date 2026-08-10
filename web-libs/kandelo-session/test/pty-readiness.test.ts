import { describe, expect, it } from "vitest";
import {
  OSC_133_COMMAND_START,
  ptyBufferEndsWithPrompt,
} from "../src/pty-readiness";

const OSC_133_PROMPT_START = "\x1b]133;A\x07";

describe("PTY prompt readiness", () => {
  it("requires the OSC 133 command-start boundary for a dynamic Bash prompt", () => {
    const visiblePrompt =
      `${OSC_133_PROMPT_START}\x1b[36muser@kandelo ` +
      "\x1b[34m/tmp \x1b[32m❯\x1b[0m ";

    expect(ptyBufferEndsWithPrompt(visiblePrompt)).toBe(false);
    expect(
      ptyBufferEndsWithPrompt(visiblePrompt + OSC_133_COMMAND_START),
    ).toBe(true);
  });

  it("does not treat prompt-looking output as marker readiness", () => {
    expect(ptyBufferEndsWithPrompt("command output ending in ❯ ")).toBe(false);
    expect(
      ptyBufferEndsWithPrompt(`${OSC_133_PROMPT_START}user@kandelo ~ ❯ `),
    ).toBe(false);
  });

  it("retains exact and conservative custom-shell readiness", () => {
    expect(ptyBufferEndsWithPrompt("output\ncustom> ", "custom> ")).toBe(true);
    expect(ptyBufferEndsWithPrompt("output\nuser@host /tmp $ ")).toBe(true);
    expect(ptyBufferEndsWithPrompt("output\n> ")).toBe(false);
  });
});
