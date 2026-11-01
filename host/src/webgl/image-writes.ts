/**
 * Write counts of native image storage.
 *
 * An EGLImage sibling that samples shared storage keeps a private native copy
 * (image-storage.ts: WebGL 2 cannot give two texture objects one storage
 * with independent sampling parameters), and that copy must show every write
 * to the canonical storage before it is sampled. Rather than re-copying the
 * whole image before every draw, each write to native image storage
 * advances that storage's count, and a sibling copies only when the count
 * differs from the one it last copied at.
 *
 * Every path that writes image storage advances the count of what it
 * wrote: draws and clears (the draw framebuffer's color storage, derived per
 * framebuffer in opaque-alpha.ts), GLES texture and renderbuffer image
 * commands, CPU-tier mirror uploads, foreign-texture uploads and GBM front
 * copies. A missed write would show stale pixels, so a site that cannot
 * name its storage precisely must advance every candidate.
 *
 * Counts are keyed by the native WebGL object and shared by every context:
 * BO storage is written by one process's context and sampled by another's.
 */
export type StorageWrites = { count: number };
const records = new WeakMap<object, StorageWrites>();

export function storageWrites(native: object): StorageWrites {
  let record = records.get(native);
  if (!record) records.set(native, record = { count: 0 });
  return record;
}

/** Storage nobody has read a count for needs none: a sibling reads the
 * count when it copies, so earlier writes are already in its copy. */
export function noteStorageWrite(native: object | null | undefined): void {
  const record = native ? records.get(native) : undefined;
  if (record) record.count++;
}

/** Audit of the write-count contract (debug and tests). Counting lets a
 * CPU-tier mirror skip reading back pixels nothing wrote
 * (cpu-image-storage.ts); a write path that forgot to count would leave its
 * pixels unpublished without any sign. With the audit on, the mirror reads
 * back anyway and a change behind an unchanged count is a fatal fault. Off,
 * it costs one boolean test. On for the graphics test gate
 * (test/support/image-write-audit.ts); a debug host sets
 * globalThis.KANDELO_IMAGE_WRITE_AUDIT = true before loading the host. */
let audit = (globalThis as { KANDELO_IMAGE_WRITE_AUDIT?: unknown }).KANDELO_IMAGE_WRITE_AUDIT === true;

export function setImageWriteAudit(enabled: boolean): void {
  audit = enabled;
}

export function imageWriteAudit(): boolean {
  return audit;
}

/** Host-owned framebuffers (GBM buffers, CPU-tier mirrors, EGL surface
 * targets) are default framebuffers to the guest, so they have no guest
 * attachment record; their color storage is registered at allocation. */
const hostColorStorage = new WeakMap<WebGLFramebuffer, object>();

export function registerFramebufferColorStorage(framebuffer: WebGLFramebuffer, storage: object): void {
  hostColorStorage.set(framebuffer, storage);
}

export function hostFramebufferColorStorage(framebuffer: WebGLFramebuffer): object | undefined {
  return hostColorStorage.get(framebuffer);
}
