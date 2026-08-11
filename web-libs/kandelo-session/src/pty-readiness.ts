export const OSC_133_COMMAND_START = "\x1b]133;B\x07";

export function ptyBufferEndsWithPrompt(
  buffer: string,
  prompt: string | null = null,
): boolean {
  if (buffer.endsWith(OSC_133_COMMAND_START)) return true;

  const plain = buffer
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
  if (prompt) return plain.endsWith(prompt);

  // Do not treat the shell continuation prompt (`> `) as ready. The demo
  // guide sends heredocs through this path, and PS2 appears before the command
  // has finished.
  return /(?:^|\n)[^\n]*[$#] $/.test(plain);
}
