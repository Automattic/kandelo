/**
 * Message contract between the boot path and the image composer worker.
 *
 * Everything crossing this boundary is plain structured-cloneable data. That
 * is the point: the main thread must never hold the composition's
 * `SharedArrayBuffer`, only the serialized bytes that come back.
 */

import type { ComposeImageJob } from "./image-composer";
import type { KandeloDemoConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import type { ExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import type { BootInputManifest } from "../../../../../web-libs/kandelo-session/src/boot-inputs";

export interface MainToComposerMessage {
  job: ComposeImageJob;
}

export type ComposerToMainMessage =
  | { type: "tick"; message: string }
  | {
    type: "done";
    imageBytes: Uint8Array;
    terminalSession: ExperimentalTerminalSession;
    imageConfig: KandeloDemoConfig | null;
    bootInputManifest?: BootInputManifest;
  }
  | { type: "error"; message: string; stack?: string };
