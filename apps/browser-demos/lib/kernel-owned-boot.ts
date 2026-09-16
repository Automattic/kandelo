// Shared helpers for booting BrowserKernel machines that OWN their VFS
// (kernelOwnedFs), so the main thread never holds a live VFS SharedArrayBuffer.
//
// Why this exists: on WebKit, a SharedArrayBuffer the persistent main thread
// holds is reclaimed only by a GC cycle that reserved WASM/SAB memory rarely
// triggers — so main-thread-owned VFS buffers accumulate across boots until
// Safari OOMs. In kernel-owned mode the worker owns the live VFS and
// Worker.terminate() frees it deterministically. The only main-thread buffer
// left is the small, transient per-boot image-build FS; these helpers track it
// and nudge WebKit's collector to reclaim it between boots.
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import sffsModuleUrl from "@kandelo-image-module32-wasm?url";
import { overlayEtcFromRootfs } from "@host/vfs/rootfs-overlay";
import { isWebKitLikeBrowser } from "./browser-engine";
import rootfsVfsUrl from "@rootfs-vfs?url";

export { overlayEtcFromRootfs };
export { isWebKitLikeBrowser, isWebKitLikeUserAgent } from "./browser-engine";

const WEBKIT_RECLAIM_TIMEOUT_MS = 1_500;
const WEBKIT_RECLAIM_STEP_MS = 150;
const WEBKIT_RECLAIM_PRESSURE_BYTES = 32 * 1024 * 1024;

let pendingImageBufferReclaims = 0;
const trackedImageBuffers = new WeakSet<object>();
const imageBufferRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<void>(() => {
        pendingImageBufferReclaims = Math.max(0, pendingImageBufferReclaims - 1);
      })
    : null;

/**
 * Track a transient image-build buffer so {@link settleWebKitReclaim} can wait
 * for its reclamation instead of guessing with a fixed delay. The registry
 * holds `buf` weakly, so tracking it does not keep it alive. Registration is
 * idempotent because callers may track at allocation and again at finalization.
 */
export function trackTransientImageBuffer(buf: ArrayBufferLike): void {
  if (!imageBufferRegistry) return;
  const identity = buf as object;
  if (trackedImageBuffers.has(identity)) return;
  trackedImageBuffers.add(identity);
  pendingImageBufferReclaims += 1;
  imageBufferRegistry.register(identity, undefined);
}

/**
 * On WebKit, nudge the garbage collector until the transient image-build
 * buffers are reclaimed (or a short deadline elapses). Reserved/dropped
 * SharedArrayBuffers create little JS-heap pressure, so a bare timer does not
 * trigger collection — allocate+drop a pressure block and yield across frames.
 * No-op on engines that reclaim dropped buffers on their own (Chrome/Firefox).
 * Call after `kernel.destroy()` in per-boot loops and image switches.
 */
export async function settleWebKitReclaim(): Promise<void> {
  if (!isWebKitLikeBrowser()) return;
  const deadline = performance.now() + WEBKIT_RECLAIM_TIMEOUT_MS;
  do {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let pressure: ArrayBuffer | null = new ArrayBuffer(WEBKIT_RECLAIM_PRESSURE_BYTES);
    pressure = null;
    void pressure;
    await new Promise<void>((resolve) => window.setTimeout(resolve, WEBKIT_RECLAIM_STEP_MS));
  } while (
    imageBufferRegistry !== null &&
    pendingImageBufferReclaims > 0 &&
    performance.now() < deadline
  );
}

/**
 * Serialize an assembled build-time filesystem to transferable image bytes and
 * register its SharedArrayBuffer for reclamation tracking. Let the caller drop
 * its `buildFs` reference right after; the kernel worker rebuilds and owns the
 * live VFS from these bytes.
 */
export async function finalizeKernelOwnedImage(buildFs: KandeloImageFs): Promise<Uint8Array> {
  const bytes = await buildFs.saveImage();
  trackTransientImageBuffer(buildFs.transientBuffer);
  return bytes;
}

/** Create a fresh, empty build-time MemoryFileSystem for assembling an image
 *  that the kernel worker will own. Scratch mounts (/tmp, /var, /home/user, …)
 *  are provided worker-side, so only the image's `/` content (e.g. /etc, /bin)
 *  needs to live here. */
/**
 * Restore an image for BUILDING on: mutate the tree, then re-export it.
 *
 * The app-side peer of `host/src/vfs/load-image.ts`, and the split is a
 * layering fact rather than a preference. That module returns a live mount
 * BACKEND and must stay `MemoryFileSystem`, which owes `append`, `seek`,
 * `fpathconf` and the rest of the runtime surface. This returns an image
 * BUILDER, which must be `KandeloImageFs`: the legacy writer cannot express the
 * `SDEF` section, so restoring and re-saving through it empties an image's
 * deferred half (defect B45 — 65 lazy binaries became zero-byte files marked
 * complete).
 *
 * It lives here because `host/src` may not import from `images/`, which the
 * host package's own `rootDir` enforces at build time — a rule worth obeying
 * rather than working around, since the host runtime shipping the image
 * BUILDER is the coupling this lane exists to remove.
 *
 * Verification is not a step: `loadImage` runs `seal::verify_cohorts` inside
 * the load and unloads on failure, so an unverified loaded image is
 * unrepresentable rather than merely discouraged.
 */
/**
 * Fetch the image-writer module and install it, once per page.
 *
 * `KandeloImageFs.create()` is synchronous and a fetch is not, so the browser
 * cannot supply module bytes at the call the way Node can (Node reads
 * `local-binaries/kandelo_image_module32.wasm` off disk). It installs them here first,
 * and every later create is as synchronous as Node's.
 *
 * MUST be awaited before the first `createEmptyBuildFs` or
 * `restoreVerifiedImageForBuild` on a page. Forgetting it is loud: the bridge
 * throws naming this function, rather than falling back to a reader that
 * cannot see an `SDEF` section, which is what B45 was.
 */
let moduleInstall: Promise<void> | null = null;
export function ensureImageWriterInstalled(): Promise<void> {
  // One promise per page, not one fetch per call: concurrent boots share it,
  // and a second demo switching images does not refetch a module that cannot
  // have changed.
  moduleInstall ??= (async () => {
    const response = await fetch(sffsModuleUrl);
    if (!response.ok) {
      throw new Error(
        `failed to fetch the VFS image writer (${response.status} ${response.statusText}) `
          + `from ${sffsModuleUrl}`,
      );
    }
    KandeloImageFs.installModuleBytes(new Uint8Array(await response.arrayBuffer()));
  })();
  return moduleInstall;
}

export async function restoreVerifiedImageForBuild(
  image: Uint8Array,
  options?: { maxByteLength?: number },
): Promise<KandeloImageFs> {
  await ensureImageWriterInstalled();
  const fs = KandeloImageFs.create();
  fs.loadImage(image);
  // A declared ceiling, not a reservation: the bridge grows its own memory
  // with the tree, so this is what the exported image DECLARES it may grow to.
  if (options?.maxByteLength !== undefined) {
    fs.setImageCapacity(options.maxByteLength);
  }
  return fs;
}

export async function createEmptyBuildFs(
  maxByteLength = 64 * 1024 * 1024,
): Promise<KandeloImageFs> {
  await ensureImageWriterInstalled();
  // No `SharedArrayBuffer`. The bridge owns its own module memory and grows it
  // as the tree does, so `maxByteLength` stops being an up-front reservation
  // and becomes what the exported image DECLARES — the same change
  // `tools/mkrootfs` made when it moved to this writer.
  const fs = KandeloImageFs.create();
  fs.setImageCapacity(maxByteLength);
  return fs;
}

/**
 * Convenience: an empty build FS pre-seeded with `/etc` from the canonical
 * rootfs — the kernel-owned equivalent of the legacy empty-FS + init()-overlay
 * starting point.
 */
export async function createBuildFsWithEtc(maxByteLength = 64 * 1024 * 1024): Promise<KandeloImageFs> {
  const buildFs = await createEmptyBuildFs(maxByteLength);
  await overlayEtcFromRootfs(buildFs, await fetchRootfsBytes());
  return buildFs;
}

let rootfsBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Fetch the canonical rootfs image bytes (cached). Demos that previously
 * started from an empty FS and relied on the legacy `kernel.init()` overlay of
 * `/etc/{passwd,group,hosts,services}` from rootfs.vfs should seed their
 * build-time FS through `overlayEtcFromRootfs`, which authenticates imported
 * atomic seals before reading the source image.
 */
export function fetchRootfsBytes(): Promise<Uint8Array> {
  if (!rootfsBytesPromise) {
    rootfsBytesPromise = fetch(rootfsVfsUrl as string)
      .then((r) => {
        if (!r.ok) throw new Error(`rootfs.vfs fetch failed: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((err) => {
        rootfsBytesPromise = null;
        throw err;
      });
  }
  return rootfsBytesPromise;
}
