/**
 * Host clipboard text → the guest's clipboard agent, through
 * `/dev/kandelo/clipboard` (crates/runtime-core/src/clipboard.rs).
 *
 * Both hosts expose `offerClipboardText(text)`. It resolves once the agent
 * has installed the text as the desktop's selection, or with the reason it
 * could not. Text is never truncated: over the cap is a failure, not a
 * shorter paste.
 */
import {
  KANDELO_CLIPBOARD_ACK_NO_AGENT,
  KANDELO_CLIPBOARD_ACK_SUPERSEDED,
  KANDELO_CLIPBOARD_MAX_TEXT_BYTES,
} from "./generated/abi.js";

/** Why an offer did not become the guest's clipboard. */
export type ClipboardOfferFailure =
  /** The kernel predates `/dev/kandelo/clipboard`. */
  | "unsupported"
  /** No clipboard agent holds the device (or it closed it before answering). */
  | "no-agent"
  /** Over `KANDELO_CLIPBOARD_MAX_TEXT_BYTES` of UTF-8. */
  | "too-large"
  /** Not valid UTF-8 (the kernel's check). */
  | "invalid-text"
  /** The agent answered with an error; `errno` carries it. */
  | "agent-error"
  /** A newer offer replaced this one before the agent answered. */
  | "superseded"
  /** The agent did not answer within the timeout. */
  | "timeout";

export type ClipboardOfferResult =
  | { ok: true; seq: number }
  | { ok: false; reason: ClipboardOfferFailure; errno?: number };

/** How long an offer waits for the agent's answer. */
export const CLIPBOARD_ACK_TIMEOUT_MS = 2_000;
/**
 * How often the host checks for the answer while an offer is pending.
 * WHY a timer: checking after every kernel entry would put a branch on the
 * syscall completion path, which the performance contract treats as hot;
 * a ~16 ms delay is imperceptible next to the key press that caused it.
 */
export const CLIPBOARD_ACK_POLL_MS = 16;

const EINVAL = 22;
const EMSGSIZE = 90;
const ENXIO = 6;

/** Classify a negative errno from `kernel_clipboard_stage`/`_offer`. */
export function clipboardOfferFailure(negErrno: number): ClipboardOfferResult {
  const errno = -negErrno;
  if (errno === ENXIO) return { ok: false, reason: "no-agent" };
  if (errno === EMSGSIZE) return { ok: false, reason: "too-large" };
  if (errno === EINVAL) return { ok: false, reason: "invalid-text" };
  return { ok: false, reason: "agent-error", errno };
}

/** Classify a settled, non-zero `kernel_clipboard_ack` result. */
export function clipboardAckFailure(status: number): ClipboardOfferResult {
  if (status === KANDELO_CLIPBOARD_ACK_SUPERSEDED) {
    return { ok: false, reason: "superseded" };
  }
  if (status === KANDELO_CLIPBOARD_ACK_NO_AGENT) {
    return { ok: false, reason: "no-agent" };
  }
  return { ok: false, reason: "agent-error", errno: -status };
}

/**
 * The bytes a host offers for clipboard `text`: CRLF pairs become LF (a
 * Windows clipboard gives CRLF, and a terminal turns each pasted LF into a
 * CR, so CRLF would arrive as two Enters per line; a lone CR is left
 * alone), then UTF-8. Returns null when the result is over the cap.
 */
export function encodeClipboardText(text: string): Uint8Array | null {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
  return bytes.byteLength > KANDELO_CLIPBOARD_MAX_TEXT_BYTES ? null : bytes;
}

/**
 * Copy-out: the desktop's selection after a copy gesture. `timeout` means
 * the guest reported no new selection in time (the chord copied nothing,
 * e.g. Ctrl+C in a terminal with no selection), which leaves the host
 * clipboard alone.
 */
/**
 * `no-agent`: the agent reported a selection but released the device (it
 * exited) before the host read it, and release drops the text. That is a
 * failed copy, never an empty one.
 */
export type GuestClipboardResult =
  | { ok: true; text: string }
  | { ok: false; reason: "timeout" | "unsupported" | "invalid-text" | "no-agent" };

/** How long a copy gesture waits for the guest to report its selection. */
export const GUEST_CLIPBOARD_TIMEOUT_MS = 2_000;
