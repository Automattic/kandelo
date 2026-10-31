/**
 * The main thread's side of one composer worker: forward its progress, give
 * it a deadline to start, and always terminate it — on success, on failure,
 * and on supersession. Termination is not tidiness: on WebKit it is the only
 * way the staging `SharedArrayBuffer` is reclaimed deterministically, so a
 * composer that outlives its boot is the exact leak this worker exists to
 * prevent.
 */

import type { ComposeImageJob, ComposeImageResult } from "./image-composer";
import type {
  ComposerToMainMessage,
  MainToComposerMessage,
} from "./image-composer-protocol";

/**
 * How long the browser has to start the composer worker, from creation to
 * the worker's `started` message (posted when its module has loaded, before
 * any composition work). Starting a same-origin module worker takes
 * milliseconds; this is generous for a slow device, and it does not limit
 * the composition itself.
 *
 * WHY a deadline: Chromium was seen creating this worker during a service
 * worker takeover (the first reload after a deploy) and never running it —
 * no script evaluation, no error event — which left the boot at "Loading"
 * forever. That engine behaviour is suspected, not reduced to a standalone
 * reproduction. Whatever the cause, a worker that never starts must become a
 * visible boot error.
 */
export const COMPOSER_START_DEADLINE_MS = 30_000;

export interface ComposeInWorkerOptions {
  onTick: (message: string) => void;
  /**
   * Returns false once a newer boot owns the session. Checked when the worker
   * reports progress and again on completion; a superseded composition is
   * abandoned by terminating the worker.
   */
  isCurrent: () => boolean;
  /** Thrown when `isCurrent()` goes false, so callers keep their own type. */
  supersededError: () => Error;
  /** Overrides `COMPOSER_START_DEADLINE_MS` (tests). */
  startDeadlineMs?: number;
}

/** The part of a `Worker` the supervisor uses. */
export interface ComposerWorkerLike {
  onmessage: ((event: MessageEvent<ComposerToMainMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: MainToComposerMessage, transfer: Transferable[]): void;
  terminate(): void;
}

export function superviseComposerWorker(
  worker: ComposerWorkerLike,
  job: ComposeImageJob,
  options: ComposeInWorkerOptions,
): Promise<ComposeImageResult> {
  const startDeadlineMs = options.startDeadlineMs ?? COMPOSER_START_DEADLINE_MS;
  return new Promise<ComposeImageResult>((resolve, reject) => {
    let settled = false;
    let startDeadline: ReturnType<typeof setTimeout> | null = null;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      if (startDeadline !== null) clearTimeout(startDeadline);
      // Terminate before resolving so the staging buffer is already released
      // when the caller starts allocating the machine's own address spaces.
      worker.terminate();
      run();
    };
    startDeadline = setTimeout(() => {
      finish(() => reject(new Error(
        `The image composer worker did not start within ${startDeadlineMs / 1000} s: ` +
          "the browser created it but never ran its script. Reload the page.",
      )));
    }, startDeadlineMs);
    worker.onmessage = (event: MessageEvent<ComposerToMainMessage>) => {
      const data = event.data;
      if (startDeadline !== null) {
        clearTimeout(startDeadline);
        startDeadline = null;
      }
      if (data.type === "started") return;
      if (data.type === "tick") {
        if (!options.isCurrent()) {
          finish(() => reject(options.supersededError()));
          return;
        }
        options.onTick(data.message);
        return;
      }
      if (data.type === "error") {
        const err = new Error(data.message);
        if (data.stack) err.stack = data.stack;
        finish(() => reject(err));
        return;
      }
      if (!options.isCurrent()) {
        finish(() => reject(options.supersededError()));
        return;
      }
      const { type: _type, ...result } = data;
      finish(() => resolve(result));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish(() =>
        reject(new Error(`image composer worker error: ${event.message}`))
      );
    };
    worker.onmessageerror = () => {
      finish(() =>
        reject(new Error("image composer worker sent an uncloneable message"))
      );
    };
    const message: MainToComposerMessage = { job };
    // Transfer the fetched image rather than copying it. The caller has
    // already read everything it needs from these bytes.
    worker.postMessage(message, [job.imageBytes.buffer as ArrayBuffer]);
  });
}
