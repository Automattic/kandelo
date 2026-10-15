/**
 * Message contract between the boot path and the image composer worker.
 *
 * Everything crossing this boundary is plain structured-cloneable data. That
 * is the point: the main thread must never hold the composition's
 * `SharedArrayBuffer`, only the serialized bytes that come back.
 */

import type { ComposeImageJob, ComposeImageResult } from "./image-composer";

export type MainToComposerMessage =
  | { job: ComposeImageJob }
  | { type: "persistent-ack" | "persistent-ready" };

export type ComposerToMainMessage =
  | { type: "tick"; message: string }
  | { type: "persistent-start"; composition: Pick<ComposeImageResult, "imageConfig" | "profileId" | "terminalSession" | "requiredServices"> }
  | { type: "persistent-chunk"; bytes: Uint8Array }
  | { type: "persistent-end" }
  | ({ type: "done" } & ComposeImageResult)
  | { type: "error"; message: string; stack?: string };
