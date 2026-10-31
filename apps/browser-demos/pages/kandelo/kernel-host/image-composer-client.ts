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
import {
  superviseComposerWorker,
  type ComposeInWorkerOptions,
} from "./image-composer-supervisor";

export type { ComposeInWorkerOptions } from "./image-composer-supervisor";

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
  return superviseComposerWorker(new ComposerWorker(), job, options);
}
