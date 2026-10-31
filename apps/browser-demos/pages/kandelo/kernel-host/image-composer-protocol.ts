/**
 * Message contract between the boot path and the image composer worker.
 *
 * Everything crossing this boundary is plain structured-cloneable data. That
 * is the point: the main thread must never hold the composition's
 * `SharedArrayBuffer`, only the serialized bytes that come back.
 */

import type { ComposeImageJob, ComposeImageResult } from "./image-composer";

export interface MainToComposerMessage {
  job: ComposeImageJob;
}

export type ComposerToMainMessage =
  // Posted once when the worker's module has loaded, before any job: proof
  // that the browser actually started the worker (see image-composer-client).
  | { type: "started" }
  | { type: "tick"; message: string }
  | ({ type: "done" } & ComposeImageResult)
  | { type: "error"; message: string; stack?: string };
