export interface CompletedPtyCommandV1 {
  exitCode: number;
  nextOffset: number;
  stdout: string;
}

/**
 * Find the shell-emitted status line for one protected PTY command. PTYs echo
 * input, so the literal `marker:%s` command text is deliberately insufficient.
 */
export function completedPtyCommand(
  output: string,
  offset: number,
  marker: string,
): CompletedPtyCommandV1 | undefined {
  if (
    !Number.isSafeInteger(offset) || offset < 0 || offset > output.length ||
    !/^__[A-Z0-9_]+__$/u.test(marker)
  ) {
    throw new Error("protected browser PTY marker state is invalid");
  }
  const available = output.slice(offset);
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}:(\\d+)\\r?\\n`, "u").exec(available);
  if (match === null) return undefined;
  const exitCode = Number(match[1]);
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("protected browser PTY status is malformed");
  }
  return {
    exitCode,
    nextOffset: offset + match.index + match[0].length,
    stdout: available.slice(0, match.index),
  };
}
