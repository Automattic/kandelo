// Worker entry for the files pane of `delo config`: it holds the open disk in the image
// writer's Wasm memory, which lives and dies in this realm. The page terminates
// the worker when the settings close, the only way WebKit reclaims that memory
// deterministically (see pages/kandelo/kernel-host/image-composer.ts).

import { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { ensureImageWriterInstalled } from "../../../lib/kernel-owned-boot";
import { listFolder, readRegularFile, upload, uploadConflicts, zipFolder } from "./files";
import type { DeloFilesAnswer, DeloFilesRequest, DeloFilesValues } from "./files-protocol";

let disk: KandeloImageFs | null = null;

const opened = () => {
  if (disk === null) throw new Error("the open disk is not open");
  return disk;
};

// The image writer's reads, zipSync and exportImage each return a copy that
// owns its ArrayBuffer, so the answer can transfer it.
const owned = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

async function answer(request: DeloFilesRequest): Promise<DeloFilesValues[DeloFilesRequest["type"]]> {
  switch (request.type) {
    case "open":
      await ensureImageWriterInstalled();
      disk = KandeloImageFs.create();
      disk.loadImage(request.image);
      return null;
    case "list": return listFolder(opened(), request.folder);
    case "read": return owned(readRegularFile(opened(), request.path));
    case "zip": return owned(zipFolder(opened(), request.folder));
    case "conflicts": return uploadConflicts(opened(), request.folder, request.paths);
    case "upload":
      upload(opened(), request.folder, request.uploads);
      return null;
    case "export": return owned(opened().exportImage());
  }
}

const post = (message: DeloFilesAnswer, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<DeloFilesRequest>) => {
  const { id } = event.data;
  answer(event.data).then(
    (value) => {
      post({ id, ok: true, value }, value instanceof Uint8Array ? [value.buffer] : []);
    },
    (err: unknown) => post({ id, ok: false, message: err instanceof Error ? err.message : String(err) }),
  );
};
