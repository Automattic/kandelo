// Messages between the files pane of `delo config` and the worker that holds the open disk.
// Everything is plain structured-cloneable data; each request carries an id its
// answer repeats.

import type { DeloFilesEntry, DeloUpload } from "./files";

export type DeloFilesOperation =
  | { type: "open"; image: Uint8Array<ArrayBuffer> }
  | { type: "list"; folder: string }
  | { type: "read"; path: string }
  | { type: "zip"; folder: string }
  | { type: "conflicts"; folder: string; paths: string[] }
  | { type: "upload"; folder: string; uploads: DeloUpload[] }
  | { type: "export" };

export interface DeloFilesValues {
  open: null;
  list: DeloFilesEntry[];
  read: Uint8Array<ArrayBuffer>;
  zip: Uint8Array<ArrayBuffer>;
  conflicts: string[];
  upload: null;
  export: Uint8Array<ArrayBuffer>;
}

export type DeloFilesRequest = DeloFilesOperation & { id: number };

export type DeloFilesAnswer =
  | { id: number; ok: true; value: DeloFilesValues[DeloFilesOperation["type"]] }
  | { id: number; ok: false; message: string };
