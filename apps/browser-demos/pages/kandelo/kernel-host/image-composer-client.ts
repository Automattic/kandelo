/**
 * Main-thread side of VFS image composition.
 *
 * Spawns a composer worker, forwards its progress, and always terminates it —
 * on success, on failure, and on supersession. Termination is not tidiness:
 * on WebKit it is the only way the staging `SharedArrayBuffer` is reclaimed
 * deterministically, so a composer that outlives its boot is the exact leak
 * this worker exists to prevent.
 */

import ComposerWorker from "./image-composer-worker.ts?worker";
import type { ComposeImageJob, ComposeImageResult } from "./image-composer";
import type {
  ComposerToMainMessage,
  MainToComposerMessage,
} from "./image-composer-protocol";

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
}

/**
 * Compose `job` in a disposable worker and return its serialized image.
 *
 * The returned bytes were transferred, not copied — this realm is only a
 * courier between the composer and the kernel worker.
 */
export function composeImageInWorker(
  job: ComposeImageJob,
  options: ComposeInWorkerOptions,
): Promise<ComposeImageResult> {
  const worker = new ComposerWorker();
  return new Promise<ComposeImageResult>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      // Terminate before resolving so the staging buffer is already released
      // when the caller starts allocating the machine's own address spaces.
      worker.terminate();
      run();
    };
    worker.onmessage = (event: MessageEvent<ComposerToMainMessage>) => {
      const data = event.data;
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
      finish(() =>
        resolve({
          imageBytes: data.imageBytes,
          terminalSession: data.terminalSession,
          imageConfig: data.imageConfig,
          bootInputManifest: data.bootInputManifest,
        })
      );
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
