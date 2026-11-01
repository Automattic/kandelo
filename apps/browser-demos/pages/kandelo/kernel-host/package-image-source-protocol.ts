import type { OpfsFileReference } from "../../../../../host/src/vfs/opfs-file-reference";

export type PackageImageSourceRequest =
  | { type: "open"; id: number; moduleBytes: Uint8Array; file: OpfsFileReference; length: number; sha256: string; directory: string }
  | { type: "read"; id: number; path: string | null; offset: number; length: number }
  | { type: "close"; id: number };

export type PackageImageSourceResponse =
  | { type: "ready"; id: number; inventoryBytes: number }
  | { type: "bytes"; id: number; bytes: Uint8Array }
  | { type: "closed"; id: number }
  | { type: "error"; id: number; message: string; closed: boolean };
