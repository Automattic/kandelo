import { setOpaqueAlphaStorage } from "./opaque-alpha.js";
import type { GbmBoRegistry } from "../dri/registry.js";
import type { GlBinding } from "./registry.js";
import { allocateGpuStorage, type GlGpuAllocation } from "./gpu-allocation.js";
import { readGbmFront } from "./gbm-front-copy.js";
import { applyNativeChanges, nativeGlFault, nativeInverse, retireNativeRetirement, rethrowNativeGlFault } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { cpuImageCodec, type CpuImageReadback } from "./cpu-image-codec.js";
import { imageWriteAudit, noteStorageWrite, storageWrites } from "./image-writes.js";
import { drmFormatInfo, planeHeight, planeWidth, rowBytes } from "./drm-format-info.js";
import { convertYuv, yuvOutputBits, type YuvColorSpace } from "./yuv-convert.js";
import { gpuStorageFormat, type GpuStorageFormat } from "./gpu-storage-format.js";
import { YuvGpuConverter, yuvGpuFormat } from "./yuv-gpu-convert.js";

export type CpuImageLayout = {width: number; height: number; format: number; pitch: number; offset: number};
export const cpuImageKey = (v: CpuImageLayout) => `${v.width}:${v.height}:${v.format}:${v.pitch}:${v.offset}`;

/** A YUV dma-buf image (DRM_IOCTL_WPK_IMPORT_PLANAR_IMAGE): one plane per
 * plane of the format, each in CPU-tier bytes or GPU-tier storage of its
 * plane format, and its conversion. `siting` holds the
 * WPK_CHROMA_SITING_* bits (1: horizontal 0.5, 2: vertical 0.5). */
export type PlanarImageLayout = {width: number; height: number; format: number;
  planes: readonly {bo: number; pitch: number; offset: number}[];
  colorSpace: YuvColorSpace; fullRange: boolean; siting: number};
export const planarImageKey = (v: PlanarImageLayout) =>
  `yuv:${v.width}:${v.height}:${v.format}:${v.planes.map(p => `${p.bo}+${p.offset}/${p.pitch}`).join(",")}` +
  `:${v.colorSpace}:${v.fullRange ? 1 : 0}:${v.siting}`;
/** Size of shared::dri::WpkDrmImportPlanarImage, the planar import record. */
export const PLANAR_IMAGE_RECORD_BYTES = 72;
/** The layout of a kernel planar import record (handles replaced by bo ids):
 * ctx_id, width, height, format, bo_handles[3], pitches[3], offsets[3],
 * color_space, full_range, chroma_siting, source, reserved. Null when the
 * record does not describe a YUV image. */
export function planarImageRecord(record: DataView): PlanarImageLayout | null {
  const word = (index: number) => record.getUint32(index * 4, true);
  const format = word(3), info = drmFormatInfo(format), colorSpace = word(13);
  if (record.byteLength !== PLANAR_IMAGE_RECORD_BYTES || !info?.isYuv || colorSpace > 2 || word(14) > 1 || word(15) > 3)
    return null;
  return {width: word(1), height: word(2), format, colorSpace: colorSpace as YuvColorSpace,
    fullRange: word(14) === 1, siting: word(15),
    planes: Array.from({length: info.numPlanes}, (_, plane) =>
      ({bo: word(4 + plane), pitch: word(7 + plane), offset: word(10 + plane)}))};
}
/** The converted image's storage: 8 bits per channel for 8-bit YUV, 10
 * for P010, so no sample loses precision to the image. */
const RGBA8_IMAGE: GpuStorageFormat = {internalFormat: 0x8058, format: 0x1908, type: 0x1401, opaque: true};
const RGB10_A2_IMAGE: GpuStorageFormat = {internalFormat: 0x8059, format: 0x1908, type: 0x8368, opaque: true};
/** GPU-tier storage of a YUV plane's object (a GBM GPU buffer or an
 * exported GLES image): its native texture or renderbuffer, whose write
 * count (image-writes.ts) tells when it changed, and a framebuffer reading
 * it. */
export type PlanarPlaneStorage = {
  gl: WebGL2RenderingContext;
  native: object;
  read: WebGLFramebuffer;
  w: number;
  h: number;
  internalFormat: number;
};
/** What a GPU-tier plane needs from the kernel host. */
export type PlanarGpuHost = {
  /** The GPU-tier storage of `bo`; undefined for a CPU-tier object. */
  plane(bo: number): PlanarPlaneStorage | undefined;
  /** Run `work` in a private native pass on `b.gl` and select `b` again
   *  after it. False when the renderer was lost; a native error in the
   *  pass is a fatal host fault. */
  pass(b: GlBinding, work: () => void): boolean;
};
/** One plane of a GPU-converted YUV image: the private texture the shader
 * reads (yuv-gpu-convert.ts), and where its contents come from. */
type PlanarStage = {
  allocation: GlGpuAllocation;
  /** GPU-tier storage; null for a CPU-tier plane, uploaded from bytes. */
  source: PlanarPlaneStorage | null;
  /** The source's write count (storage or bo) when last staged. */
  staged: number | null;
};
/** A YUV image converted to RGBA. It is never rendered to (external
 * textures and YUV images are never render targets), so it is never read
 * back; it is converted again only when a plane was written: a CPU-tier
 * plane's canonical bytes (GbmBoRegistry.writeCount) or a GPU-tier plane's
 * storage (image-writes.ts). */
type PlanarMirror = {
  layout: PlanarImageLayout;
  allocation: GlGpuAllocation;
  /** Each distinct plane bo and its write count at the last conversion. */
  converted: Map<number, number> | null;
  /** With the write-count audit on: the plane bos' bytes converted. */
  audited: Map<number, Uint8Array<ArrayBuffer>> | null;
  /** With any GPU-tier plane: every plane staged for the GPU converter. */
  stages: PlanarStage[] | null;
};
type Mirror = {
  layout: CpuImageLayout;
  allocation: GlGpuAllocation;
  /** Independent bytes last accepted by both the native image and CPU store. */
  snapshot: Uint8Array<ArrayBuffer> | null;
  /** Accepted GL work must reach CPU storage before another CPU upload. */
  dirty: boolean;
  /** The native image's write count (image-writes.ts) when it last became
   * dirty: publication reads it back only if a write happened since. */
  begun?: number;
  pending: CpuImageReadback | null;
};
/** CPU BOs keep their linear storage identity. Native images are coherent
 * mirrors, never GPU-tier BOs or public texture names. Submission boundaries
 * serialize CPU publication, native execution, and device writeback. */
export class CpuImageStorage {
  private mirrors = new Map<number, Map<WebGL2RenderingContext, Map<string, Mirror>>>();
  private planar = new Map<WebGL2RenderingContext, Map<string, PlanarMirror>>();
  private planarByBo = new Map<number, Set<PlanarMirror>>();
  private planarGpu: PlanarGpuHost | null = null;

  /** The kernel host gives GPU-tier YUV planes their storage and passes. */
  attachPlanarGpu(host: PlanarGpuHost): void { this.planarGpu = host; }

  acquire(b: GlBinding, bo: number, store: GbmBoRegistry, layout: CpuImageLayout): GlGpuAllocation | null {
    const gl = b.gl, bytes = store.readPixelView(bo);
    const {width, height, format, pitch, offset} = layout;
    // The mirror's texture holds the plane's own format (cpu-image-codec.ts).
    const codec = cpuImageCodec(format);
    if (!codec) return null;
    const span = offset + (height - 1) * pitch + width * codec.cpp, align = Math.min(codec.cpp, 4);
    if (!gl || !bytes || ![width,height,format,pitch,offset,span].every(Number.isSafeInteger) ||
        width <= 0 || height <= 0 || offset < 0 || offset % align || pitch < width * codec.cpp || pitch % align ||
        span > bytes.byteLength) return null;
    let contexts = this.mirrors.get(bo);
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

  /** The converted image of a YUV dma-buf, made on first import of this
   * layout in this renderer. Null when a plane's object cannot hold the
   * plane's rows or its GPU storage lives in another renderer. */
  acquirePlanar(b: GlBinding, store: GbmBoRegistry, layout: PlanarImageLayout): GlGpuAllocation | null {
    const gl = b.gl, info = drmFormatInfo(layout.format), {width, height, planes} = layout;
    if (!gl || !info?.isYuv || planes.length !== info.numPlanes || !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    const sources: (PlanarPlaneStorage | null)[] = [];
    for (const [index, plane] of planes.entries()) {
      const source = this.planarGpu?.plane(plane.bo) ?? null;
      sources.push(source);
      if (source) {
        // The kernel admitted this plane only as GPU storage of the
        // plane's own format at its origin; anything else here means the
        // kernel and host disagree about the object.
        const expected = gpuStorageFormat(info.planeFormats[index])?.internalFormat;
        if (!yuvGpuFormat(layout.format) || plane.offset !== 0 || source.internalFormat !== expected ||
            source.w < planeWidth(info, width, index) || source.h < planeHeight(info, height, index))
          nativeGlFault(`YUV plane ${index} (bo ${plane.bo}) is not GPU storage the kernel admitted`);
        // A WebGL texture belongs to one context.
        if (source.gl !== gl) return null;
        continue;
      }
      const bytes = store.readPixelView(plane.bo), row = rowBytes(info, width, index);
      const span = plane.offset + (planeHeight(info, height, index) - 1) * plane.pitch + row;
      if (!bytes ||
          ![plane.offset, plane.pitch, span].every(Number.isSafeInteger) || plane.offset < 0 ||
          plane.pitch < row || span > bytes.byteLength) return null;
    }
    const key = planarImageKey(layout);
    let views = this.planar.get(gl);
    const old = views?.get(key);
    if (old) return old.allocation.retirement.pending ? null : old.allocation;
    // A GPU-tier plane makes the whole image a GPU conversion: every plane
    // is staged in a texture of its plane format.
    let stages: PlanarStage[] | null = null;
    if (sources.some(source => source)) {
      stages = [];
      for (const [index, source] of sources.entries()) {
        const storage = gpuStorageFormat(info.planeFormats[index])!;
        let stage: PlanarStage | null = null;
        allocateGpuStorage(gl, planeWidth(info, width, index), planeHeight(info, height, index), 0,
          allocation => { stage = {allocation, source, staged: null}; }, storage);
        if (!stage) {
          for (const made of stages) retireNativeRetirement(made.allocation.retirement);
          return null;
        }
        stages.push(stage);
      }
    }
    const storage = yuvOutputBits(layout.format) === 10 ? RGB10_A2_IMAGE : RGBA8_IMAGE;
    let result: GlGpuAllocation | null = null;
    allocateGpuStorage(gl, width, height, 0, allocation => {
      const mirror: PlanarMirror = {layout: {...layout, planes: planes.map(plane => ({...plane}))},
        allocation, converted: null, audited: null, stages};
      if (!views) { views = new Map(); this.planar.set(gl, views); }
      views.set(key, mirror);
      for (const plane of planes) {
        let owners = this.planarByBo.get(plane.bo);
        if (!owners) { owners = new Set(); this.planarByBo.set(plane.bo, owners); }
        owners.add(mirror);
      }
      result = allocation;
    }, storage);
    if (!result && stages) for (const made of stages) retireNativeRetirement(made.allocation.retirement);
    return result;
  }

  /** Convert a YUV image whose planes were written since its last
   * conversion. The canonical bytes' write counts decide: a CPU writer's
   * mapping is merged (syncToSab) before its count is read. */
  private preparePlanar(b: GlBinding, store: GbmBoRegistry, mirror: PlanarMirror): boolean {
    if (mirror.stages) return this.preparePlanarGpu(b, store, mirror, mirror.stages);
    const bos = [...new Set(mirror.layout.planes.map(plane => plane.bo))];
    const counts = new Map<number, number>();
    for (const bo of bos) {
      store.syncToSab(bo);
      const count = store.writeCount(bo);
      if (count === undefined) return false;
      counts.set(bo, count);
    }
    const current = mirror.converted && bos.every(bo => mirror.converted!.get(bo) === counts.get(bo));
    if (current && !imageWriteAudit()) return true;
    if (current) {
      // Audit (debug and tests): unchanged counts must mean unchanged bytes.
      for (const bo of bos) {
        const bytes = store.readPixelView(bo)!, before = mirror.audited?.get(bo);
        if (before && (before.length !== bytes.length || bytes.some((value, i) => value !== before[i])))
          nativeGlFault(`YUV image plane bo ${bo} changed without a counted write`);
      }
      return true;
    }
    const {width, height, format} = mirror.layout;
    let pixels: ArrayBufferView;
    try {
      pixels = convertYuv(format, width, height, mirror.layout.planes.map(plane =>
        ({bytes: store.readPixelView(plane.bo)!, offset: plane.offset, pitch: plane.pitch})),
        {colorSpace: mirror.layout.colorSpace, fullRange: mirror.layout.fullRange,
          sitingH: mirror.layout.siting & 1 ? 0.5 : 0, sitingV: mirror.layout.siting & 2 ? 0.5 : 0});
    } catch (caught) { rethrowNativeGlFault(caught); return false; }
    const storage = mirror.allocation.storage;
    if (!this.uploadPixels(b, mirror.allocation, pixels, storage.format, storage.type)) return false;
    mirror.converted = counts;
    mirror.audited = imageWriteAudit() ? new Map(bos.map(bo => [bo, new Uint8Array(store.readPixelView(bo)!)])) : null;
    return true;
  }

  /** Convert a YUV image with GPU-tier planes on the GPU, only when a
   * plane was written since it was last staged: a GPU-tier plane's storage
   * write count, a CPU-tier plane's canonical bytes' write count. Only the
   * planes written are staged again. */
  private preparePlanarGpu(b: GlBinding, store: GbmBoRegistry, mirror: PlanarMirror,
      stages: readonly PlanarStage[]): boolean {
    const counts: number[] = [];
    for (const [index, stage] of stages.entries()) {
      if (stage.source) { counts.push(storageWrites(stage.source.native).count); continue; }
      const bo = mirror.layout.planes[index].bo;
      store.syncToSab(bo);
      const count = store.writeCount(bo);
      if (count === undefined) return false;
      counts.push(count);
    }
    const written = stages.flatMap((stage, index) => stage.staged === counts[index] ? [] : [index]);
    if (!written.length) return true;
    const {layout, allocation} = mirror, info = drmFormatInfo(layout.format)!;
    // CPU-tier rows are packed before the pass, so a malformed plane fails
    // before any native work.
    const rows = new Map<number, Uint8Array>();
    for (const index of written) {
      if (stages[index].source) continue;
      const {bo, offset, pitch} = layout.planes[index], bytes = store.readPixelView(bo);
      if (!bytes) return false;
      const row = rowBytes(info, layout.width, index), count = planeHeight(info, layout.height, index);
      const packed = new Uint8Array(row * count);
      for (let y = 0; y < count; y++) packed.set(bytes.subarray(offset + y * pitch, offset + y * pitch + row), y * row);
      rows.set(index, packed);
    }
    const planesOf = stages.map(stage => stage.allocation.tex);
    const conversion = {colorSpace: layout.colorSpace, fullRange: layout.fullRange,
      sitingH: layout.siting & 1 ? 0.5 as const : 0 as const, sitingV: layout.siting & 2 ? 0.5 as const : 0 as const};
    if (!this.planarGpu?.pass(b, () => {
      const converter = YuvGpuConverter.for(allocation.gl);
      for (const index of written) {
        const stage = stages[index], {w, h} = stage.allocation;
        if (stage.source) converter.copy(stage.source.read, stage.allocation.fbo, w, h);
        else converter.upload(stage.allocation.tex, w, h, stage.allocation.storage.format, rows.get(index)!);
      }
      converter.convert(allocation.fbo, planesOf, layout.format, layout.width, layout.height, conversion);
    })) return false;
    for (const index of written) stages[index].staged = counts[index];
    // Siblings sampling the image copy it again (image-writes.ts).
    noteStorageWrite(allocation.tex);
    return true;
  }

  private *entries(gl?: WebGL2RenderingContext): Iterable<[number, Mirror]> {
    for (const [bo, contexts] of this.mirrors) for (const [context, views] of contexts)
      if (!gl || context === gl) for (const mirror of views.values()) yield [bo, mirror];
  }

  private upload(b: GlBinding, mirror: Mirror, bytes: Uint8Array): boolean {
    const {w, h} = mirror.allocation;
    const codec = cpuImageCodec(mirror.layout.format);
    if (!codec) return false;
    let snapshot: Uint8Array<ArrayBuffer>, pixels: ArrayBufferView;
    try {
      snapshot = new Uint8Array(bytes);
      pixels = codec.pack(snapshot, mirror.layout.offset, mirror.layout.pitch, w, h);
    } catch (caught) { rethrowNativeGlFault(caught); return false; }
    const accepted = this.uploadPixels(b, mirror.allocation, pixels, codec.storage.format, codec.storage.type);
    if (accepted) mirror.snapshot = snapshot;
    return accepted;
  }

  /** Replace a mirror's whole image with `pixels`. */
  private uploadPixels(b: GlBinding, allocation: GlGpuAllocation, pixels: ArrayBufferView,
      format: number, type: number): boolean {
    const gl = b.gl!, {w, h, tex} = allocation;
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
        format, type, pixels)), restore: nativeInverse(owner)},
    ], {shared: true, finalizer: nativeInverse(owner,
      [["bindTexture", 0x0de1, texture]], [["bindBuffer", 0x88ec, unpack]],
      fields.map((field, index) => ["pixelStorei", field, values[index]]))});
    // Siblings sampling the mirror copy it again (image-writes.ts).
    noteStorageWrite(tex);
    return accepted;
  }

  /** Complete pending native writes before examining incoming CPU changes.
   * Failure keeps native authority; a later upload cannot erase that work. */
  prepare(b: GlBinding, store: GbmBoRegistry, captureErrors: (gl: WebGL2RenderingContext) => void): boolean {
    if (!b.gl || (!this.mirrors.size && !this.planar.size)) return true;
    // A different native renderer cannot consume stale CPU storage while an
    // earlier renderer still owns an unpublished accepted write.
    for (const [, mirror] of this.entries()) if (mirror.dirty)
      if (!this.publish({gl: mirror.allocation.gl} as GlBinding, store, captureErrors)) return false;
    captureErrors(b.gl);
    for (const [bo, mirror] of this.entries(b.gl)) {
      if (mirror.allocation.retirement.pending) continue;
      store.syncToSab(bo);
      const bytes = store.readPixelView(bo);
      if (!bytes) return false;
      const previous = mirror.snapshot;
      if (!previous || previous.length !== bytes.length || bytes.some((value, index) => value !== previous[index]))
        if (!this.upload(b, mirror, bytes)) return false;
    }
    for (const mirror of this.planar.get(b.gl)?.values() ?? [])
      if (!mirror.allocation.retirement.pending && !this.preparePlanar(b, store, mirror)) return false;
    return true;
  }

  begin(b: GlBinding): void {
    if (!b.gl) return;
    for (const [, mirror] of this.entries(b.gl)) {
      if (mirror.allocation.retirement.pending) continue;
      // A mirror still dirty from an unpublished submission keeps that
      // earlier baseline, so its writes are not forgotten.
      if (!mirror.dirty) mirror.begun = storageWrites(mirror.allocation.tex).count;
      mirror.dirty = true;
    }
  }

  publish(b: GlBinding, store: GbmBoRegistry, captureErrors: (gl: WebGL2RenderingContext) => void): boolean {
    if (!b.gl) return true;
    let audited: number | null = null;
    for (const [bo, mirror] of this.entries(b.gl)) {
      if (!mirror.dirty || mirror.allocation.retirement.pending) continue;
      // Nothing wrote the native image since it became dirty: its pixels
      // are the ones last represented, so there is nothing to read back
      // (unless the write-count audit verifies exactly that).
      const uncounted = !!mirror.snapshot && mirror.begun === storageWrites(mirror.allocation.tex).count;
      if (uncounted && !imageWriteAudit()) { mirror.dirty = false; continue; }
      const bytes = store.readPixelView(bo);
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
        if (uncounted && (changed || alphaWritten)) audited = bo;
        else if (changed && !store.publishDevicePixels(bo, next)) return false;
        // A format without alpha has no writable alpha channel. Re-upload
        // before the next command if native rendering wrote one, so reads
        // and sampling see one.
        mirror.snapshot = alphaWritten ? null : represented;
        mirror.pending = null;
        mirror.dirty = false;
      } catch (caught) { rethrowNativeGlFault(caught); return false; }
      if (audited !== null)
        throw new Error(`CPU image mirror of BO ${audited} changed without a counted write: an image write path ` +
          "does not advance its storage's write count (image-writes.ts)");
    }
    return true;
  }

  retire(bo: number): boolean {
    // A YUV image needs every plane: any plane's object retiring retires it.
    let complete = true;
    for (const mirror of [...this.planarByBo.get(bo) ?? []]) {
      let retired = true;
      for (const stage of mirror.stages ?? []) retired = retireNativeRetirement(stage.allocation.retirement) && retired;
      if (!retireNativeRetirement(mirror.allocation.retirement) || !retired) { complete = false; continue; }
      const gl = mirror.allocation.gl, views = this.planar.get(gl);
      views?.delete(planarImageKey(mirror.layout));
      if (views && !views.size) this.planar.delete(gl);
      for (const plane of mirror.layout.planes) {
        const owners = this.planarByBo.get(plane.bo);
        owners?.delete(mirror);
        if (owners && !owners.size) this.planarByBo.delete(plane.bo);
      }
    }
    const contexts = this.mirrors.get(bo);
    if (!contexts) return complete;
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
