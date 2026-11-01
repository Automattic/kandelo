import { setOpaqueAlphaStorage } from "./opaque-alpha.js";
import type { GbmBoRegistry, GbmAllocationRetirement } from "../dri/registry.js";
import type { GlOperationPrefix } from "./operation-stream.js";
import type { GlBinding } from "./registry.js";
import { allocateGpuStorage, type GlGpuAllocation } from "./gpu-allocation.js";
import { readGbmFront } from "./gbm-front-copy.js";
import { applyNativeChanges, nativeInverse, retireNativeRetirement, NativeRetirementReceipt } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { cpuImageCodec, type CpuImageReadback } from "./cpu-image-codec.js";

export type CpuImageLayout = {width: number; height: number; format: number; pitch: number; offset: number};
export const cpuImageKey = (v: CpuImageLayout) => `${v.width}:${v.height}:${v.format}:${v.pitch}:${v.offset}`;
type Mirror = {
  layout: CpuImageLayout;
  allocation: GlGpuAllocation;
  /** Independent bytes last accepted by both the native image and CPU store. */
  snapshot: Uint8Array<ArrayBuffer> | null;
  /** Accepted GL work must reach CPU storage before another CPU upload. */
  dirty: boolean;
  pending: CpuImageReadback | null;
};
type MirrorContexts=Map<WebGL2RenderingContext,Map<string,Mirror>>;
type Closing={bo:number;store:WeakRef<GbmBoRegistry>;allocation:GbmAllocationRetirement;contexts:MirrorContexts;
  prefixes:readonly GlOperationPrefix[];receipts:NativeRetirementReceipt[]|null};
const closingRecords=new WeakMap<CpuImageRetirement,Closing>();
/** Issued by the mirror allocator before close, containing no process view. */
export class CpuImageRetirement {constructor(){Object.freeze(this);}}

/** CPU BOs keep their linear storage identity. Native images are coherent
 * mirrors, never GPU-tier BOs or public texture names. Submission boundaries
 * serialize CPU publication, native execution, and device writeback. */
export class CpuImageStorage {
  private reservedRetirements=new Set<number>();
  private closing=new Map<number,CpuImageRetirement>();
  private mirrors = new Map<number, Map<WebGL2RenderingContext, Map<string, Mirror>>>();

  /** Snapshot actual mirror journals before any root is revoked. No storage
   * reference is added, so observation cannot prevent final deletion. */
  retirementCaptureCost(bo:number):number {
    let count=0;for(const views of this.mirrors.get(bo)?.values()??[])count+=views.size;return count;
  }
  captureRetirements(bo: number): NativeRetirementReceipt[] | null {
    if(this.closing.has(bo))return null;
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

  reserveRetirement(bo:number,store:GbmBoRegistry,prefixes:readonly GlOperationPrefix[]):CpuImageRetirement|null {
    if(this.closing.has(bo)||this.reservedRetirements.has(bo))return null;
    const allocation=store.captureAllocationRetirement(bo);if(!allocation)return null;
    try {
      const capability=new CpuImageRetirement(),contexts=this.mirrors.get(bo)??new Map();
      const record:Closing={bo,store:new WeakRef(store),allocation,contexts,prefixes:[...prefixes],receipts:null};
      closingRecords.set(capability,record);this.mirrors.set(bo,contexts);this.closing.set(bo,capability);return capability;
    }catch{store.abandonAllocationRetirement(allocation);return null;}
  }
  reservationReady(capability:CpuImageRetirement):boolean {
    const record=closingRecords.get(capability);
    return !!record && this.closing.get(record.bo)===capability && record.prefixes.every(prefix=>prefix.complete);
  }
  captureReservedRetirements(capability:CpuImageRetirement):NativeRetirementReceipt[]|null {
    const record=closingRecords.get(capability),store=record?.store.deref();
    if(!record||!store||!this.reservationReady(capability)||!store.matchesAllocationRetirement(record.allocation))return null;
    if(record.receipts)return record.receipts;
    const receipts:NativeRetirementReceipt[]=[];
    try {
      for(const views of record.contexts.values())for(const mirror of views.values()) {
        const receipt=NativeRetirementReceipt.capture(mirror.allocation.retirement);
        if(!receipt){for(const old of receipts)old.forget();return null;}receipts.push(receipt);
      }
      this.reservedRetirements.add(record.bo);record.receipts=receipts;return receipts;
    }catch{for(const old of receipts)old.forget();return null;}
  }
  retireCanonical(capability:CpuImageRetirement,pid:number):{complete:boolean;notificationFault:boolean} {
    const record=closingRecords.get(capability),store=record?.store.deref();
    if(!record||!store||!record.receipts||!record.receipts.every(receipt=>receipt.complete))return {complete:false,notificationFault:false};
    return {complete:store.retireCapturedAllocation(record.allocation,pid),notificationFault:record.allocation.notificationFault};
  }
  forgetReservedRetirement(capability:CpuImageRetirement,abandon=false):boolean {
    const record=closingRecords.get(capability),store=record?.store.deref();
    if(!record||this.closing.get(record.bo)!==capability||!store)return false;
    if(!abandon&&!record.allocation.complete)return false;
    if(abandon&&!store.abandonAllocationRetirement(record.allocation))return false;
    this.closing.delete(record.bo);this.reservedRetirements.delete(record.bo);closingRecords.delete(capability);return true;
  }

  forgetRetirement(bo:number):void {this.reservedRetirements.delete(bo);}
  acquire(b: GlBinding, bo: number, store: GbmBoRegistry, layout: CpuImageLayout): GlGpuAllocation | null {
    if(this.reservedRetirements.has(bo))return null;
    const closing=this.closing.get(bo),record=closing&&closingRecords.get(closing);
    if(record && (record.store.deref()!==store||!store.matchesAllocationRetirement(record.allocation)
      ||!record.prefixes.some(prefix=>prefix.permits(b.operations))))return null;
    const gl = b.gl, bytes = store.pixelView(bo);
    const {width, height, format, pitch, offset} = layout;
    // The mirror's texture holds the plane's own format (cpu-image-codec.ts).
    const codec = cpuImageCodec(format);
    if (!codec) return null;
    const span = offset + (height - 1) * pitch + width * codec.cpp, align = Math.min(codec.cpp, 4);
    if (!gl || !bytes || ![width,height,format,pitch,offset,span].every(Number.isSafeInteger) ||
        width <= 0 || height <= 0 || offset < 0 || offset % align || pitch < width * codec.cpp || pitch % align ||
        span > bytes.byteLength) return null;
    let contexts = record?.contexts ?? this.mirrors.get(bo);
    if (!contexts) { contexts = new Map(); this.mirrors.set(bo, contexts); }
    let views = contexts.get(gl);
    if (!views) { views = new Map(); contexts.set(gl, views); }
    const key = cpuImageKey(layout), old = views.get(key);
    if (old) return old.allocation.retirement.pending ? null : old.allocation;
    let result: GlGpuAllocation | null = null;
    if (!allocateGpuStorage(gl, width, height, 0, allocation => {
      views!.set(key, {allocation, layout: {...layout}, snapshot: null, dirty: false, pending: null});
      // A padding channel uploads as alpha 1.0; rendering never writes it
      // (opaque-alpha.ts), so every reader keeps seeing 1.0.
      setOpaqueAlphaStorage(allocation.tex, codec.storage.opaque);
      result = allocation;
    }, codec.storage)) {
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
    const codec = cpuImageCodec(mirror.layout.format);
    if (!codec) return false;
    let snapshot: Uint8Array<ArrayBuffer>, pixels: ArrayBufferView;
    try {
      snapshot = new Uint8Array(bytes);
      pixels = codec.pack(snapshot, mirror.layout.offset, mirror.layout.pitch, w, h);
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
        codec.storage.format, codec.storage.type, pixels)), restore: nativeInverse(owner)},
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
      const codec = cpuImageCodec(mirror.layout.format);
      if (!codec) return false;
      if (!mirror.pending) {
        const {allocation} = mirror;
        const result = readGbmFront({gl: b.gl, renderTargetFbo: allocation.fbo,
          surfaceSize: {width: allocation.w, height: allocation.h}} as Parameters<typeof readGbmFront>[0],
          () => captureErrors(b.gl!),
          {format: codec.readFormat, type: codec.readType, buffer: codec.readback});
        if (result.rc || !result.pixels) return false;
        mirror.pending = result.pixels;
      }
      try {
        // Merge changes relative to this view's last upload. Unchanged or
        // disjoint siblings must not overwrite a newer writer. Preserve bytes
        // outside the image, row padding, and X bits without guest views.
        store.syncToSab(bo);
        const next = new Uint8Array(bytes), {width, height, pitch, offset} = mirror.layout;
        // Preserve the bytes represented by this native view. Other sibling
        // changes trigger another upload at the next command boundary.
        const represented = new Uint8Array(mirror.snapshot);
        const cpp = codec.cpp;
        let changed = false, alphaWritten = false;
        for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
          const at = offset + row * pitch + col * cpp, index = row * width + col;
          codec.encode(mirror.pending, index, mirror.snapshot, represented, at);
          alphaWritten ||= codec.alphaWritten(mirror.pending, index);
          for (let k = at; k < at + cpp; k++)
            if (represented[k] !== mirror.snapshot[k]) { next[k] = represented[k]; changed = true; }
        }
        if (changed && !store.publishDevicePixels(bo, next)) return false;
        // A format without alpha has no writable alpha channel. Re-upload
        // before the next command if native rendering wrote one, so reads
        // and sampling see one.
        mirror.snapshot = alphaWritten ? null : represented;
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
