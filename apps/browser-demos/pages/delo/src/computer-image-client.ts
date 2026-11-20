// Page side of writing a delo computer's disk: resolve the configuration's
// binaries and source URLs, write in a disposable worker onto the computer's
// current disk or an empty one, and terminate the worker on success and on
// failure. The page receives only the transferred image bytes and the
// record of what the build wrote.

import type { ComputerDisk } from "./computer-image";
import type { DeloComputerConfig } from "./computer-record";
import { deloInstalled } from "./packages";
import { deloImageSource, type DeloRegistry } from "./registry";
import { deloSourceUrl } from "./binaries";
import { deloLazyAddress } from "./lazy-address";
import { deloLazyDirectory } from "./lazy-directory";
import { resolveImageOwnedLazyAsset } from "../../../../../host/src/vfs/vfs-asset-group-reference";
import ComputerImageWorker from "./computer-image-worker.ts?worker";
import type { ComputerImageMessage, ComputerImageRequest } from "./computer-image-protocol";

type DeloDisk = ComputerDisk<Uint8Array<ArrayBuffer>>;

export async function buildDeloImage(registry: DeloRegistry, name: string, config: DeloComputerConfig, base: DeloDisk | null = null): Promise<DeloDisk> {
  const binaries = deloInstalled(registry, config);
  const sources: Record<string, string> = {};
  for (const file of [...binaries, config.pipeline].flatMap((entry) => entry.files)) {
    if (!("from" in file) || ("type" in file && file.type === "symlink")) continue;
    const image = deloImageSource(file.from);
    if (image !== null) sources[image.image] = storeUrl(image.image);
    else sources[file.from] = file.lazy ? storeUrl(file.from) : await deloSourceUrl(file.from);
  }
  const request: ComputerImageRequest = { plan: { name, binaries, ...config }, sources, base };
  const worker = new ComputerImageWorker();
  try {
    return await new Promise<DeloDisk>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ComputerImageMessage>) =>
        event.data.type === "done" ? resolve(event.data.disk) : reject(new Error(event.data.message));
      worker.onerror = (event) => reject(new Error(event.message || "the image builder worker failed"));
      worker.postMessage(request, base === null ? [] : [base.image.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/** The URL the deployment serves a store file at: the kernel downloads a lazy
 *  archive from it, and the builder reads an archive's member list or a
 *  Kandelo image from it. */
function storeUrl(from: string): string {
  const address = deloLazyAddress(from);
  const directory = deloLazyDirectory();
  return (directory === undefined ? null : resolveImageOwnedLazyAsset(directory, address)) ?? address;
}
