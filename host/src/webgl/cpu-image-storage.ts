import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlBinding } from "./registry.js";
import { allocateGpuStorage, type GlGpuAllocation } from "./gpu-allocation.js";
import { readGbmFront } from "./gbm-front-copy.js";
import { applyNativeChanges, nativeInverse, retireNativeRetirement, NativeRetirementReceipt } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";

export type CpuImageLayout = {width: number; height: number; format: number; pitch: number; offset: number};
export const cpuImageKey = (v: CpuImageLayout) => `${v.width}:${v.height}:${v.format}:${v.pitch}:${v.offset}`;
type Mirror = {
  layout: CpuImageLayout;
  allocation: GlGpuAllocation;
  /** Independent bytes last accepted by both the native image and CPU store. */
  snapshot: Uint8Array<ArrayBuffer> | null;
  /** Accepted GL work must reach CPU storage before another CPU upload. */
  dirty: boolean;
  pending: Uint8Array<ArrayBuffer> | null;
};

/** CPU BOs keep their linear storage identity. Native images are coherent
 * mirrors, never GPU-tier BOs or public texture names. Submission boundaries
 * serialize CPU publication, native execution, and device writeback. */
export class CpuImageStorage {
  private reservedRetirements=new Set<number>();
  private mirrors = new Map<number, Map<WebGL2RenderingContext, Map<string, Mirror>>>();

  /** Snapshot actual mirror journals before any root is revoked. No storage
   * reference is added, so observation cannot prevent final deletion. */
  retirementCaptureCost(bo:number):number {
    let count=0;for(const views of this.mirrors.get(bo)?.values()??[])count+=views.size;return count;
  }
  captureRetirements(bo: number): NativeRetirementReceipt[] | null {
    const receipts: NativeRetirementReceipt[]=[];
    try {
      for(const views of this.mirrors.get(bo)?.values() ?? []) for(const mirror of views.values()) {
        const receipt=NativeRetirementReceipt.capture(mirror.allocation.retirement);
        if(!receipt) {for(const old of receipts)old.forget();return null;}
        receipts.push(receipt);
      }
      this.reservedRetirements.add(bo);return receipts;
    } catch {for(const old of receipts)old.forget();return null;}
  }

  forgetRetirement(bo:number):void {this.reservedRetirements.delete(bo);}
  acquire(b: GlBinding, bo: number, store: GbmBoRegistry, layout: CpuImageLayout): GlGpuAllocation | null {
    if(this.reservedRetirements.has(bo))return null;
    const gl = b.gl, bytes = store.pixelView(bo);
    const {width, height, format, pitch, offset} = layout;
    const span = offset + (height - 1) * pitch + width * 4;
    if (!gl || !bytes || ![width,height,format,pitch,offset,span].every(Number.isSafeInteger) ||
        width <= 0 || height <= 0 || offset < 0 || offset % 4 || pitch < width * 4 || pitch % 4 ||
        span > bytes.byteLength || ![0x34325241,0x34325258,0x34324241,0x34324258].includes(format)) return null;
    let contexts = this.mirrors.get(bo);
    if (!contexts) { contexts = new Map(); this.mirrors.set(bo, contexts); }
    let views = contexts.get(gl);
    if (!views) { views = new Map(); contexts.set(gl, views); }
    const key = cpuImageKey(layout), old = views.get(key);
    if (old) return old.allocation.retirement.pending ? null : old.allocation;
    let result: GlGpuAllocation | null = null;
    if (!allocateGpuStorage(gl, width, height, 0, allocation => {
      views!.set(key, {allocation, layout: {...layout}, snapshot: null, dirty: false, pending: null});
      result = allocation;
    })) {
      if (!views.size) contexts.delete(gl);
      if (!contexts.size) this.mirrors.delete(bo);
    }
    return result;
  }

  private *entries(gl?: WebGL2RenderingContext): Iterable<[number, Mirror]> {
    for (const [bo, contexts] of this.mirrors) for (const [context, views] of contexts)
      if (!gl || context === gl) for (const mirror of views.values()) yield [bo, mirror];
  }

  private upload(b: GlBinding, mirror: Mirror, bytes: Uint8Array): boolean {
    const gl = b.gl!, {w, h, tex} = mirror.allocation;
    let snapshot: Uint8Array<ArrayBuffer>, pixels: Uint8Array<ArrayBuffer>;
    try {
      snapshot = new Uint8Array(bytes);
      pixels = new Uint8Array(w * h * 4);
      const {offset, pitch, format} = mirror.layout;
      const bgra = format === 0x34325241 || format === 0x34325258;
      const opaque = format === 0x34325258 || format === 0x34324258;
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const src = offset + row * pitch + col * 4, dst = (row * w + col) * 4;
        pixels[dst] = snapshot[src + (bgra ? 2 : 0)]; pixels[dst + 1] = snapshot[src + 1];
        pixels[dst + 2] = snapshot[src + (bgra ? 0 : 2)]; pixels[dst + 3] = opaque ? 255 : snapshot[src + 3];
      }
    } catch { return false; }
    // Typed-array uploads must not inherit a public unpack buffer, skips,
    // orientation, premultiplication, or browser color-space conversion.
    const owner = {gl, errors: [] as number[], shadow: {}};
    const fields = [0x0cf5, 0x0cf2, 0x0cf3, 0x0cf4, 0x9240, 0x9241, 0x9243];
    const next = [1, 0, 0, 0, 0, 0, 0];
    let texture: WebGLTexture | null = null, unpack: WebGLBuffer | null = null;
    let values: number[] = [];
    if (!checkedGlCall(owner, () => {
      texture = gl.getParameter(0x8069); unpack = gl.getParameter(0x88ef);
      values = fields.map(field => Number(gl.getParameter(field)));
    }) || !values.every(Number.isInteger)) return false;
    const accepted = applyNativeChanges(owner, [
      {apply: () => checkedGlCall(owner, () => gl.bindTexture(0x0de1, tex)),
        restore: nativeInverse(owner, [["bindTexture", 0x0de1, texture]])},
      {apply: () => checkedGlCall(owner, () => gl.bindBuffer(0x88ec, null)),
        restore: nativeInverse(owner, [["bindBuffer", 0x88ec, unpack]])},
      ...fields.map((field, index) => ({
        apply: () => checkedGlCall(owner, () => gl.pixelStorei(field, next[index])),
        restore: nativeInverse(owner, [["pixelStorei", field, values[index]]])
      })),
      {apply: () => checkedGlCall(owner, () => gl.texSubImage2D(0x0de1, 0, 0, 0, w, h,
        0x1908, 0x1401, pixels)), restore: nativeInverse(owner)},
    ], {shared: true, finalizer: nativeInverse(owner,
      [["bindTexture", 0x0de1, texture]], [["bindBuffer", 0x88ec, unpack]],
      fields.map((field, index) => ["pixelStorei", field, values[index]]))});
    if (accepted) mirror.snapshot = snapshot;
    return accepted;
  }

  /** Complete pending native writes before examining incoming CPU changes.
   * Failure keeps native authority; a later upload cannot erase that work. */
  prepare(b: GlBinding, store: GbmBoRegistry, captureErrors: (gl: WebGL2RenderingContext) => void): boolean {
    if (!b.gl || !this.mirrors.size) return true;
    // A different native renderer cannot consume stale CPU storage while an
    // earlier renderer still owns an unpublished accepted write.
    for (const [, mirror] of this.entries()) if (mirror.dirty)
      if (!this.publish({gl: mirror.allocation.gl} as GlBinding, store, captureErrors)) return false;
    captureErrors(b.gl);
    for (const [bo, mirror] of this.entries(b.gl)) {
      if (mirror.allocation.retirement.pending) continue;
      store.syncToSab(bo);
      const bytes = store.pixelView(bo);
      if (!bytes) return false;
      const previous = mirror.snapshot;
      if (!previous || previous.length !== bytes.length || bytes.some((value, index) => value !== previous[index]))
        if (!this.upload(b, mirror, bytes)) return false;
    }
    return true;
  }

  begin(b: GlBinding): void {
    if (!b.gl) return;
    for (const [, mirror] of this.entries(b.gl))
      if (!mirror.allocation.retirement.pending) mirror.dirty = true;
  }

  publish(b: GlBinding, store: GbmBoRegistry, captureErrors: (gl: WebGL2RenderingContext) => void): boolean {
    if (!b.gl) return true;
    for (const [bo, mirror] of this.entries(b.gl)) {
      if (!mirror.dirty || mirror.allocation.retirement.pending) continue;
      const bytes = store.pixelView(bo);
      if (!bytes || !mirror.snapshot) return false;
      if (!mirror.pending) {
        const {allocation} = mirror;
        const result = readGbmFront({gl: b.gl, renderTargetFbo: allocation.fbo,
          surfaceSize: {width: allocation.w, height: allocation.h}} as Parameters<typeof readGbmFront>[0],
          () => captureErrors(b.gl!));
        if (result.rc || !result.pixels) return false;
        mirror.pending = result.pixels;
      }
      try {
        // Merge changes relative to this view's last upload. Unchanged or
        // disjoint siblings must not overwrite a newer writer. Preserve bytes
        // outside the image, row padding, and X bits without guest views.
        store.syncToSab(bo);
        const next = new Uint8Array(bytes), {width, height, format, pitch, offset} = mirror.layout;
        const bgra = format === 0x34325241 || format === 0x34325258;
        const opaque = format === 0x34325258 || format === 0x34324258;
        let changed = false;
        for (let row = 0; row < height; row++) for (let col = 0; col < width; col++)
          for (let channel = 0; channel < (opaque ? 3 : 4); channel++) {
            const dst = offset + row * pitch + col * 4 + (bgra && channel !== 1 && channel !== 3 ? 2 - channel : channel);
            const value = mirror.pending[(row * width + col) * 4 + channel];
            if (value !== mirror.snapshot[dst]) { next[dst] = value; changed = true; }
          }
        if (changed && !store.publishDevicePixels(bo, next)) return false;
        // Preserve the bytes represented by this native view. Other sibling
        // changes trigger another upload at the next command boundary.
        const represented = new Uint8Array(mirror.snapshot);
        for (let row = 0; row < height; row++) for (let col = 0; col < width; col++)
          for (let channel = 0; channel < (opaque ? 3 : 4); channel++) {
            const dst = offset + row * pitch + col * 4 + (bgra && channel !== 1 && channel !== 3 ? 2 - channel : channel);
            represented[dst] = mirror.pending[(row * width + col) * 4 + channel];
          }
        // XRGB has no writable alpha channel. Re-upload before the next
        // command if native rendering wrote one, so reads/sampling see one.
        mirror.snapshot = opaque && mirror.pending.some((value,index) => index % 4 === 3 && value !== 255)
          ? null : represented;
        mirror.pending = null;
        mirror.dirty = false;
      } catch { return false; }
    }
    return true;
  }

  retire(bo: number): boolean {
    const contexts = this.mirrors.get(bo);
    if (!contexts) return true;
    let complete = true;
    for (const [gl, views] of contexts) {
      for (const [key, mirror] of views) {
        if (retireNativeRetirement(mirror.allocation.retirement)) views.delete(key);
        else complete = false;
      }
      if (!views.size) contexts.delete(gl);
    }
    if (complete) this.mirrors.delete(bo);
    return complete;
  }
}
