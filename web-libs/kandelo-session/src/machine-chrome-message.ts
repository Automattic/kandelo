import type { WebPreviewState } from "./kernel-host";

// SW->viewer chrome pushes (Task 3 of multi-instance service-worker routing).
// The service worker posts one of these to viewer clients when a machine's
// bridge goes away: "machine-offline" when the owning tab closed (terminal),
// "machine-reconnecting" during a transient service-worker restart.
export type MachineChromeMessageType =
  | "machine-offline"
  | "machine-reconnecting";

const OFFLINE_MESSAGE =
  "This computer is no longer running — its browser tab was closed, so " +
  "the live web preview is unavailable.";
const RECONNECTING_MESSAGE =
  "Reconnecting to this computer after a service worker restart…";

const STATUS_FOR_TYPE: Record<
  MachineChromeMessageType,
  "offline" | "reconnecting"
> = {
  "machine-offline": "offline",
  "machine-reconnecting": "reconnecting",
};

const MESSAGE_FOR_TYPE: Record<MachineChromeMessageType, string> = {
  "machine-offline": OFFLINE_MESSAGE,
  "machine-reconnecting": RECONNECTING_MESSAGE,
};

/**
 * Map a service-worker chrome push to the web-preview state the demo chrome
 * should display, or null when the push must be ignored.
 *
 * A non-null result is the exact `WebPreviewState` to hand to
 * `host.setWebPreview(...)`. Null means "leave the pane untouched" for every
 * case that must not mutate it:
 *
 *  - the message is not one of the chrome pushes (or is malformed),
 *  - the push names a different machine than this page's SW-minted `name`
 *    (strict match — one scope can host several machines),
 *  - this boot has been superseded (`isCurrent()` is false), so a newer boot
 *    already owns the pane, or
 *  - this machine never exposed a web preview, so there is nothing to take
 *    offline.
 *
 * The offline/reconnecting states annotate the *existing* preview: the label
 * and URL are preserved so the same pane keeps its identity and only its status
 * and message change. Kept pure so the message->preview mapping is testable
 * without a service worker; live-setup.ts wires the
 * `navigator.serviceWorker` "message" event to it.
 */
export function webPreviewForMachineChromeMessage(params: {
  data: unknown;
  mintedName: string;
  current: WebPreviewState | null;
  isCurrent: () => boolean;
}): WebPreviewState | null {
  const { data, mintedName, current, isCurrent } = params;
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; name?: unknown };
  if (
    message.type !== "machine-offline" &&
    message.type !== "machine-reconnecting"
  ) {
    return null;
  }
  // Strict: only react to this page's own machine. A scope can host several.
  if (message.name !== mintedName) return null;
  // A superseded boot must not mutate the pane a newer boot now owns.
  if (!isCurrent()) return null;
  // Nothing to annotate if this machine never had a web preview.
  if (current === null) return null;

  const type = message.type as MachineChromeMessageType;
  return {
    ...current,
    status: STATUS_FOR_TYPE[type],
    message: MESSAGE_FOR_TYPE[type],
  };
}
