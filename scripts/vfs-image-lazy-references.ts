/**
 * List the lazy files and lazy archives a built VFS image references.
 *
 * Every builder under `images/` writes with `KandeloImageFs`, whose images
 * describe their deferred bodies in the in-body `SDEF` section and carry no
 * host-side JSON trailer, so the image module is asked for the entries.
 * Without the `moduleLazyEntries` argument the reader sees only a trailer and
 * would answer "no deferred bodies" for an image full of them.
 *
 * Shared by the asset-group builder (which stages exactly these bodies for a
 * production deployment) and the supply check (which requires them in the
 * published projection after setup).
 */
import { createBaseImageFromContainer } from "../images/vfs/lib/module-base-image.ts";
import { KandeloImageFs } from "../images/vfs/lib/kandelo-image-fs.ts";
import { imageReadFromContainer } from "../host/src/vfs/rootfs-lazy-archives.ts";

export interface ImageLazyReference {
  kind: "file" | "archive";
  /** The address the image records, e.g. `kandelo-lazy:programs/tmux.wasm`. */
  address: string;
  /** Declared byte length, when the image records one. */
  bytes?: number;
  /** Declared SHA-256, when the image records one. */
  sha256?: string;
}

export function imageLazyReferences(image: Uint8Array): ImageLazyReference[] {
  const reader = KandeloImageFs.create();
  reader.loadImage(image);
  const { baseImage } = createBaseImageFromContainer(
    image,
    imageReadFromContainer(image),
    undefined,
    () => reader.lazyEntries(),
  );
  const references: ImageLazyReference[] = [];
  for (const body of baseImage.deferredFiles()) {
    references.push({ kind: "file", address: body.address, bytes: body.bytes });
  }
  for (const body of baseImage.deferredArchives()) {
    references.push({
      kind: "archive",
      address: body.address,
      bytes: body.bytes,
      sha256: body.sha256,
    });
  }
  return references;
}
