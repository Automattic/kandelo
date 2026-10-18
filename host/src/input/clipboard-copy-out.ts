/**
 * Copy-out: put the guest desktop's selection on the host clipboard after a
 * copy gesture over the desktop (Cmd+C, Ctrl+Shift+C, Ctrl+Insert, …).
 *
 * WHY the write starts before the text exists: Safari and Firefox let a
 * page write the clipboard only inside the user's gesture, and the guest
 * reports its selection well after the keydown handler returns. A
 * `ClipboardItem` whose data is a promise is created synchronously in the
 * gesture and filled when the text arrives. Where `ClipboardItem` is
 * missing, the text is written with `writeText` once it arrives, which
 * Chromium allows for a focused page.
 *
 * If the guest copies nothing in time (the chord was Ctrl+C in a terminal,
 * say), the promise rejects and the host clipboard keeps what it had.
 */
import type { GuestClipboardResult } from "../clipboard.js";

/** The parts of the async Clipboard API this needs (injectable for tests). */
export interface HostClipboard {
  write?(items: ClipboardItem[]): Promise<void>;
  writeText(text: string): Promise<void>;
}

export class CopyOutFailure extends Error {
  constructor(readonly reason: string) {
    super(`copy-out ${reason}`);
  }
}

/**
 * Start a copy-out. Must be called synchronously from the keydown handler,
 * before the chord is delivered to the guest. Resolves with the text that
 * reached the host clipboard; rejects with a CopyOutFailure.
 */
export function startHostClipboardCopyOut(
  waitForGuestText: () => Promise<GuestClipboardResult>,
  clipboard: HostClipboard | undefined = globalThis.navigator?.clipboard,
  ClipboardItemCtor: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<string> {
  const text = waitForGuestText().then((result) => {
    if (!result.ok) throw new CopyOutFailure(result.reason);
    return result.text;
  });
  if (!clipboard) {
    return text.then(() => {
      throw new CopyOutFailure("unsupported");
    });
  }
  let written: Promise<void>;
  if (ClipboardItemCtor && clipboard.write) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    // The rejection is reported through `written`; keep it from also
    // surfacing as an unhandled rejection of this branch.
    blob.catch(() => {});
    written = clipboard.write([new ClipboardItemCtor({ "text/plain": blob })]);
  } else {
    written = text.then((t) => clipboard.writeText(t));
  }
  return written.then(
    () => text,
    async (error: unknown) => {
      // Prefer the guest-side reason (e.g. timeout) over the browser's
      // generic write failure it caused.
      const guest = await text.then(() => null, (e: unknown) => e);
      if (guest instanceof CopyOutFailure) throw guest;
      throw new CopyOutFailure(
        `host clipboard write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
}
