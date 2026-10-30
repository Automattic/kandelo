import type { Page } from "@playwright/test";

const PUNCTUATION = [
  ["`", "~", "Backquote"], ["-", "_", "Minus"], ["=", "+", "Equal"],
  ["[", "{", "BracketLeft"], ["]", "}", "BracketRight"], ["\\", "|", "Backslash"],
  [";", ":", "Semicolon"], ["'", '"', "Quote"], [",", "<", "Comma"],
  [".", ">", "Period"], ["/", "?", "Slash"],
] as const;

function strokeFor(char: string): string {
  if (char === "\n") return "Enter";
  if (char === "\t") return "Tab";
  if (char === " ") return "Space";
  if (/^[a-z]$/i.test(char)) {
    return `${char === char.toUpperCase() ? "Shift+" : ""}Key${char.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  const digit = ")!@#$%^&*(".indexOf(char);
  if (digit >= 0) return `Shift+Digit${digit}`;
  for (const [plain, shifted, code] of PUNCTUATION) {
    if (char === plain) return code;
    if (char === shifted) return `Shift+${code}`;
  }
  throw new Error(`physical typing supports printable US ASCII, LF and Tab; unsupported U+${char.codePointAt(0)!.toString(16).toUpperCase()}`);
}

/** Type through physical US key presses, including actual Shift transitions.
 * Guest evdev consumers reconstruct text from keys/modifiers; logical text
 * insertion alone does not supply uppercase or shifted punctuation chords.
 * Call with no modifiers held. This helper never changes focus or pastes.
 * Validate the entire input before emitting any key, so unsupported text
 * cannot leave a partially typed shell command. Each press releases its keys.
 */
export async function typePhysicalText(
  page: Page,
  text: string,
  options: { delay?: number } = {},
): Promise<void> {
  const delay = options.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) throw new Error("physical typing delay must be finite and nonnegative");
  const strokes = Array.from(text, strokeFor);
  for (const stroke of strokes) await page.keyboard.press(stroke, { delay });
}
