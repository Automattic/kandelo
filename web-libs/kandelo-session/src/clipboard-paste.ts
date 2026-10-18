/**
 * Paste gestures that did not reach the guest, for images that declare the
 * `clipboard` runtime feature. The host turns the browser's paste into an
 * offer on `/dev/kandelo/clipboard`; when that fails, the user's chord and
 * every key typed while it was pending are discarded (so "paste, Enter"
 * cannot run a half-typed command) and the UI says so.
 */

/** Mirrors the host's `ClipboardOfferFailure`. */
export type ClipboardPasteFailureReason =
  | "unsupported"
  | "no-agent"
  | "too-large"
  | "invalid-text"
  | "agent-error"
  | "superseded"
  | "timeout";

export interface ClipboardPasteFailure {
  reason: ClipboardPasteFailureReason;
  /** The guest agent's errno, for `agent-error`. */
  errno?: number;
  /** Keys typed while the paste was pending, excluding the paste chord. */
  discardedKeystrokes: number;
}

const CAUSES: Record<ClipboardPasteFailureReason, string> = {
  "unsupported": "this machine's kernel has no host clipboard device",
  "no-agent": "the clipboard agent is not running in this machine",
  "too-large": "the clipboard holds more than 1 MiB of text",
  "invalid-text": "the clipboard text is not valid UTF-8",
  "agent-error": "the clipboard agent could not set the selection",
  "superseded": "a newer paste replaced it",
  "timeout": "the clipboard agent did not answer",
};

/** One line for a toast: the cause, then what was thrown away. */
export function describeClipboardPasteFailure(failure: ClipboardPasteFailure): string {
  let cause = CAUSES[failure.reason];
  if (failure.reason === "agent-error" && failure.errno !== undefined) {
    cause += ` (errno ${failure.errno})`;
  }
  const n = failure.discardedKeystrokes;
  const discarded = n === 0
    ? ""
    : `; ${n} keystroke${n === 1 ? "" : "s"} discarded`;
  return `Paste failed: ${cause}${discarded}`;
}
