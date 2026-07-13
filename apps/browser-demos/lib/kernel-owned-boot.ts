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
import { MemoryFileSystem } from "@host/vfs/memory-fs";
// @ts-expect-error — vite ?url virtual module (resolved by the kernel-artifacts plugin)
import rootfsVfsUrl from "@rootfs-vfs?url";

const WEBKIT_RECLAIM_TIMEOUT_MS = 1_500;
const WEBKIT_RECLAIM_STEP_MS = 150;
const WEBKIT_RECLAIM_PRESSURE_BYTES = 32 * 1024 * 1024;

let pendingImageBufferReclaims = 0;
const imageBufferRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<void>(() => {
        pendingImageBufferReclaims = Math.max(0, pendingImageBufferReclaims - 1);
      })
    : null;

export function isWebKitLikeBrowser(): boolean {
  const ua = navigator.userAgent;
  return /AppleWebKit/i.test(ua)
    && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)/i.test(ua);
}

/**
 * Track a transient image-build buffer so {@link settleWebKitReclaim} can wait
 * for its reclamation instead of guessing with a fixed delay. The registry
 * holds `buf` weakly, so tracking it does not keep it alive.
 */
export function trackTransientImageBuffer(buf: ArrayBufferLike): void {
  if (!imageBufferRegistry) return;
  pendingImageBufferReclaims += 1;
  imageBufferRegistry.register(buf as object, undefined);
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
export async function finalizeKernelOwnedImage(buildFs: MemoryFileSystem): Promise<Uint8Array> {
  const bytes = await buildFs.saveImage();
  trackTransientImageBuffer(buildFs.sharedBuffer);
  return bytes;
}

/** Create a fresh, empty build-time MemoryFileSystem for assembling an image
 *  that the kernel worker will own. Scratch mounts (/tmp, /var, /home/user, …)
 *  are provided worker-side, so only the image's `/` content (e.g. /etc, /bin)
 *  needs to live here. */
export function createEmptyBuildFs(maxByteLength = 64 * 1024 * 1024): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const initial = Math.min(16 * 1024 * 1024, maxByteLength);
  const sab = new SharedArrayBufferCtor(initial, { maxByteLength });
  return MemoryFileSystem.create(sab, maxByteLength);
}

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

function copyMissingRootfsPath(
  source: MemoryFileSystem,
  target: MemoryFileSystem,
  path: string,
): void {
  const sourceStat = source.lstat(path);
  const sourceKind = sourceStat.mode & S_IFMT;
  let targetKind: number | null = null;
  try {
    targetKind = target.lstat(path).mode & S_IFMT;
  } catch {
    // Missing in the caller's image: copy it from the canonical rootfs.
  }

  // Existing caller-owned leaves always win. Existing directories merge with
  // canonical directories so a demo can override one file without losing the
  // rest of that subtree.
  if (targetKind !== null && (sourceKind !== S_IFDIR || targetKind !== S_IFDIR)) {
    return;
  }

  if (sourceKind === S_IFDIR) {
    if (targetKind === null) {
      target.mkdirWithOwner(
        path,
        sourceStat.mode & 0o7777,
        sourceStat.uid,
        sourceStat.gid,
      );
    }
    const dh = source.opendir(path);
    try {
      for (;;) {
        const entry = source.readdir(dh);
        if (entry === null) break;
        if (entry.name === "." || entry.name === "..") continue;
        copyMissingRootfsPath(
          source,
          target,
          path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
        );
      }
    } finally {
      source.closedir(dh);
    }
    return;
  }

  if (sourceKind === S_IFLNK) {
    target.symlinkWithOwner(
      source.readlink(path),
      path,
      sourceStat.uid,
      sourceStat.gid,
    );
    return;
  }

  if (sourceKind !== S_IFREG) {
    throw new Error(`Unsupported canonical /etc file type at ${path}`);
  }

  const bytes = new Uint8Array(sourceStat.size);
  const fd = source.open(path, 0, 0);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = source.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.length - offset,
      );
      if (count <= 0) {
        throw new Error(
          `Short read while copying canonical rootfs path ${path}: ` +
            `${offset}/${bytes.length} bytes`,
        );
      }
      offset += count;
    }
  } finally {
    source.close(fd);
  }
  target.createFileWithOwner(
    path,
    sourceStat.mode & 0o7777,
    sourceStat.uid,
    sourceStat.gid,
    bytes,
  );
}

/**
 * Recursively merge canonical `/etc` state into `target`, without overwriting
 * files or symlinks the caller already wrote. This replaces the legacy
 * worker-side `/etc` overlay that `kernel.init()` performed: demos that start
 * from a small custom image still inherit rootfs-owned account, resolver, TLS,
 * and other configuration through the normal VFS path.
 */
export function overlayEtcFromRootfs(target: MemoryFileSystem, rootfsImage: Uint8Array): void {
  const source = MemoryFileSystem.fromImage(rootfsImage);
  copyMissingRootfsPath(source, target, "/etc");
}

/**
 * Convenience: an empty build FS pre-seeded with `/etc` from the canonical
 * rootfs — the kernel-owned equivalent of the legacy empty-FS + init()-overlay
 * starting point.
 */
export async function createBuildFsWithEtc(maxByteLength = 64 * 1024 * 1024): Promise<MemoryFileSystem> {
  const buildFs = createEmptyBuildFs(maxByteLength);
  overlayEtcFromRootfs(buildFs, await fetchRootfsBytes());
  return buildFs;
}

let rootfsBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Fetch the canonical rootfs image bytes (cached). Demos that previously
 * started from an empty FS and relied on the legacy `kernel.init()` overlay of
 * `/etc/{passwd,group,hosts,services}` from rootfs.vfs should seed their
 * build-time FS from these bytes instead (`MemoryFileSystem.fromImage`).
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
