import type { PersistentImageIntegrityPolicy, PersistentImageWriteResult } from "../../../../../images/vfs/lib/kandelo-image-fs";

export type ImageCodecProgress = { phase: "write" | "verify"; bytes: number; total: number };

export interface ImageCodecMemoryUsage {
  wasmPages: number;
  inputWindowPeak: number;
}

export type ImageCodecRequest =
  | { type: "stage"; file: FileSystemFileHandle; moduleBytes: Uint8Array; maximumLength: number; observeMemory?: boolean }
  | { type: "write"; file: FileSystemFileHandle; moduleBytes: Uint8Array; payloadLength: number; policy: PersistentImageIntegrityPolicy; observeMemory?: boolean }
  | { type: "inspect"; prefix: Uint8Array; moduleBytes: Uint8Array; physicalLength: number; identitySha256: string; policy: PersistentImageIntegrityPolicy; observeMemory?: boolean }
  | { type: "control"; operation: 19 | 20; input: Uint8Array; moduleBytes: Uint8Array; observeMemory?: boolean }
  | { type: "input"; bytes: Uint8Array | null }
  | { type: "progress-ack" }
  | { type: "cancel"; message: string };

export type ImageCodecResponse =
  | { type: "staged"; length: number; imageSha256: string; closed: true; memoryUsage?: ImageCodecMemoryUsage }
  | { type: "input-needed" }
  | ({ type: "progress" } & ImageCodecProgress)
  | { type: "done"; result: PersistentImageWriteResult; closed: true; memoryUsage?: ImageCodecMemoryUsage }
  | { type: "inspected"; payloadLength: number; physicalLength: number; closed: true; memoryUsage?: ImageCodecMemoryUsage }
  | { type: "controlled"; result: Uint8Array | number; closed: true; memoryUsage?: ImageCodecMemoryUsage }
  | { type: "error"; message: string; errno?: number; closed: boolean; memoryUsage?: ImageCodecMemoryUsage };
