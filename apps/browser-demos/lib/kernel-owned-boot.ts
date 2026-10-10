// Shared helpers for booting BrowserKernel machines that OWN their VFS
// (kernelOwnedFs), so the main thread never holds a live VFS.
//
// Why this exists: on WebKit, a SharedArrayBuffer the persistent main thread
// holds is reclaimed only by a GC cycle that reserved WASM/SAB memory rarely
// triggers — so main-thread-owned VFS buffers accumulate across boots until
// Safari OOMs. In kernel-owned mode the worker owns the live VFS and
// Worker.terminate() frees it deterministically. The only main-thread memory
// left is the transient per-boot image writer (`KandeloImageFs`, a Wasm module
// whose memory grows with the staged tree); these helpers track it and nudge
// WebKit's collector to reclaim it between boots.
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import imageModuleUrl from "@kandelo-image-module32-wasm?url";
import { overlayEtcFromRootfs } from "../../../images/vfs/lib/rootfs-etc-overlay";
import { isWebKitLikeBrowser } from "./browser-engine";

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
 * register the writer's module memory for reclamation tracking. Let the caller drop
 * its `buildFs` reference right after; the kernel worker rebuilds and owns the
 * live VFS from these bytes.
 */
export async function finalizeKernelOwnedImage(buildFs: KandeloImageFs): Promise<Uint8Array> {
  const bytes = await buildFs.saveImage();
  trackTransientImageBuffer(buildFs.transientBuffer);
  return bytes;
}

/**
 * Fetch the image-writer module and install it, once per page.
 *
 * `KandeloImageFs.create()` is synchronous and a fetch is not, so the browser
 * cannot supply module bytes at the call the way Node can (Node reads
 * `local-binaries/kandelo_image_module32.wasm` off disk). It installs them
 * here first, and every later create is as synchronous as Node's.
 *
 * MUST be awaited before the first `KandeloImageFs.create()` on a page;
 * `createEmptyBuildFs` and `restoreVerifiedImageForBuild` await it
 * themselves. Forgetting it is loud: the bridge throws naming the missing
 * install rather than building with nothing.
 */
let moduleInstall: Promise<void> | null = null;
export function ensureImageWriterInstalled(): Promise<void> {
  // One promise per page, not one fetch per call: concurrent boots share it,
  // and a second demo switching images does not refetch a module that cannot
  // have changed.
  moduleInstall ??= (async () => {
    const response = await fetch(imageModuleUrl);
    if (!response.ok) {
      throw new Error(
        `failed to fetch the VFS image writer (${response.status} ${response.statusText}) `
          + `from ${imageModuleUrl}`,
      );
    }
    KandeloImageFs.installModuleBytes(new Uint8Array(await response.arrayBuffer()));
  })();
  return moduleInstall;
}

/**
 * Restore an image for BUILDING on: mutate the tree, then re-export it.
 *
 * The result is the Rust image writer, the same producer that built the
 * image, so the deferred entries (lazy files and lazy archives, the image's
 * SDEF section) survive the round trip unchanged.
 *
 * It lives in the app rather than in `host/src` because the host package may
 * not import from `images/` (its `rootDir` enforces that at build time); the
 * host runtime does not ship the image builder.
 *
 * Verification is not a separate step: `loadImage` verifies imported cohort
 * seals inside the load and unloads on failure, so an unverified loaded image
 * cannot be observed.
 */
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

/** Create a fresh, empty build-time image filesystem for assembling an image
 *  that the kernel worker will own. Scratch mounts (/tmp, /var, /home/maker,
 *  …) are served by the in-kernel tmpfs, so only the image's `/` content
 *  (e.g. /etc, /bin) needs to live here. */
export async function createEmptyBuildFs(
  maxByteLength = 64 * 1024 * 1024,
): Promise<KandeloImageFs> {
  await ensureImageWriterInstalled();
  // No `SharedArrayBuffer`. The bridge owns its own module memory and grows it
  // as the tree does, so `maxByteLength` is not an up-front reservation but
  // what the exported image DECLARES it may grow to.
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
 * `/etc/{passwd,group,hosts,services}` from rootfs.vfs.zst should seed their
 * build-time FS through `overlayEtcFromRootfs`, which authenticates imported
 * atomic seals before reading the source image.
 */
export function fetchRootfsBytes(): Promise<Uint8Array> {
  if (!rootfsBytesPromise) {
    // WHY resolved on demand: the canonical rootfs seeds `/etc` for demos that
    // start from an empty filesystem, which is a supporting need. Importing its
    // URL statically made it an eager dependency of every page that touches
    // this module, including ones that never seed anything.
    rootfsBytesPromise = import("@host/browser-kernel-default-artifacts")
      .then((m) => m.browserDefaultRootfsVfsUrl())
      .then((url) => fetch(url))
      .then((r) => {
        if (!r.ok) throw new Error(`rootfs.vfs.zst fetch failed: ${r.status}`);
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
