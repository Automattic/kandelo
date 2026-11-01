/**
 * Multisampled EGL surfaces (EGL 1.5 section 3.4: SAMPLE_BUFFERS/SAMPLES).
 *
 * WebGL 2 has no multisampled default framebuffer the host can size per EGL
 * surface, and multisampled textures are not part of it. A multisampled
 * surface therefore renders into RGBA8 and DEPTH24_STENCIL8 renderbuffers
 * allocated with exactly the config's sample count; that framebuffer is the
 * guest's default framebuffer. The surface's ordinary single-sampled storage
 * (its present target or borrowed GBM/Wayland render back) holds the
 * resolved image. EGL 1.5 section 3.10.1.2 posts the resolved color buffer,
 * and GLES 2.0 section 4.3.1 reads resolved values from a multisampled
 * framebuffer, so every path that consumes the surface's pixels (swap, KMS
 * scanout, GBM/Wayland front copy, ReadPixels, CopyTex[Sub]Image2D) resolves
 * first with a same-rectangle BlitFramebuffer, which WebGL 2 requires for a
 * multisampled source. Single-sampled surfaces do none of this work.
 *
 * Only EGL_MULTISAMPLE_RESOLVE_DEFAULT is offered. WebGL 2 exposes no
 * per-sample access, so the box filter that EGL_MULTISAMPLE_RESOLVE_BOX
 * requires cannot be guaranteed; configs do not advertise its bit.
 */
import type { GlBinding } from "./registry.js";
import type { GlSurfaceResources } from "./surface-resources.js";
import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement,
  type NativeCall, type NativeRetirement } from "./native-recovery.js";
import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import { captureNativeGlErrors } from "./errors.js";
import { WPK_SURFACE_CONFIG_MAX_SAMPLES, WPK_SURFACE_CONFIG_RGBA8_D24S8, WPK_SURFACE_CONFIG_SAMPLES_SHIFT } from "./ops.js";

const READ = 0x8ca8, DRAW = 0x8ca9, RBO = 0x8d41;
const READ_BINDING = 0x8caa, DRAW_BINDING = 0x8ca6, RBO_BINDING = 0x8ca7;
const READ_BUFFER = 0x0c02, COLOR0 = 0x8ce0, SCISSOR = 0x0c11;
const RGBA8 = 0x8058, DEPTH24_STENCIL8 = 0x88f0, DEPTH_STENCIL_ATTACHMENT = 0x821a;
const SAMPLES = 0x80a9, MAX_SAMPLES = 0x8d57, RENDERBUFFER_SAMPLES = 0x8cab;

/** Multisampled default-framebuffer storage of one surface allocation. */
export type GlMultisampleTarget = {
  fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depthStencil: WebGLRenderbuffer;
  samples: number; w: number; h: number; retirement: NativeRetirement;
};

/** Sample count named by a creation config word, or null for a malformed
 * word. Zero is a single-sampled surface. Renderer support is checked when
 * storage is allocated. */
export function surfaceConfigSamples(configId: number): number | null {
  if (!Number.isInteger(configId) || configId < 0 || configId > 0xffff_ffff) return null;
  if ((configId & 0xff) !== WPK_SURFACE_CONFIG_RGBA8_D24S8) return null;
  const samples = configId >>> WPK_SURFACE_CONFIG_SAMPLES_SHIFT;
  return samples === 0 || (samples >= 2 && samples <= WPK_SURFACE_CONFIG_MAX_SAMPLES) ? samples : null;
}

function sampleCounts(value: unknown): number[] | null {
  if (!value || typeof value !== "object" || !("length" in value)) return null;
  const counts = Array.from(value as ArrayLike<unknown>, Number);
  return counts.every(count => Number.isInteger(count) && count >= 0 && count <= 0x7fff_ffff) ? counts : null;
}

/** Bit n set: this renderer allocates both surface renderbuffer formats with
 * exactly n samples. GLES 3.0 section 6.1.15 lists each format's supported
 * counts; a requested count in that list is allocated exactly. MAX_SAMPLES
 * bounds every list. Null reports a failed or malformed native query. */
export function surfaceSampleMask(owner: CheckedGlOwner): number | null {
  const gl = owner.gl;
  if (!gl) return null;
  let max: unknown, color: unknown, depth: unknown;
  if (!checkedGlCall(owner, () => {
    max = gl.getParameter(MAX_SAMPLES);
    color = gl.getInternalformatParameter(RBO, RGBA8, SAMPLES);
    depth = gl.getInternalformatParameter(RBO, DEPTH24_STENCIL8, SAMPLES);
  })) return null;
  const colorCounts = sampleCounts(color), depthCounts = sampleCounts(depth);
  if (!Number.isInteger(max) || (max as number) < 0 || !colorCounts || !depthCounts) return null;
  let mask = 0;
  for (const count of colorCounts)
    if (count >= 2 && count <= WPK_SURFACE_CONFIG_MAX_SAMPLES && count <= (max as number) && depthCounts.includes(count))
      mask |= 1 << count;
  return mask >>> 0;
}

/** Allocate color and depth/stencil renderbuffers with exactly `samples`
 * samples. A renderer that allocates another count fails the allocation:
 * EGL_SAMPLES must describe the surface the guest renders into. Native
 * selectors are restored, or left as a pending repair, before return. */
export function allocateMultisampleTarget(owner: CheckedGlOwner, samples: number,
  w: number, h: number): GlMultisampleTarget | null {
  const gl = owner.gl;
  if (!gl || !Number.isInteger(samples) || samples < 2 || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0)
    return null;
  let prevRbo: WebGLRenderbuffer | null = null, prevDraw: WebGLFramebuffer | null = null;
  if (!checkedGlCall(owner, () => {
    prevRbo = gl.getParameter(RBO_BINDING);
    prevDraw = gl.getParameter(DRAW_BINDING);
  })) return null;
  const retirement = reserveNativeRetirement(owner,
    [["deleteFramebuffer", null], ["deleteRenderbuffer", null], ["deleteRenderbuffer", null]]);
  if (!retirement) return null;
  const target = { samples, w, h, retirement, fbo: null, color: null, depthStencil: null } as unknown as GlMultisampleTarget;
  const width = Math.max(1, w), height = Math.max(1, h);
  const storage = (renderbuffer: WebGLRenderbuffer, format: number): boolean => {
    let actual: unknown;
    return checkedGlCall(owner, () => gl.bindRenderbuffer(RBO, renderbuffer)) &&
      checkedGlCall(owner, () => gl.renderbufferStorageMultisample(RBO, samples, format, width, height)) &&
      checkedGlCall(owner, () => { actual = gl.getRenderbufferParameter(RBO, RENDERBUFFER_SAMPLES); }) &&
      actual === samples;
  };
  const restore = nativeInverse(owner, [["bindRenderbuffer", RBO, prevRbo]], [["bindFramebuffer", DRAW, prevDraw]]);
  let accepted = false;
  try {
    accepted = applyNativeChanges({ ...owner, shadow: {} }, [{ restore, apply: () => {
      if (!checkedGlCall(owner, () => { retirement.calls[1][1] = target.color = gl.createRenderbuffer()!; }) || !target.color) return false;
      if (!checkedGlCall(owner, () => { retirement.calls[2][1] = target.depthStencil = gl.createRenderbuffer()!; }) || !target.depthStencil) return false;
      if (!checkedGlCall(owner, () => { retirement.calls[0][1] = target.fbo = gl.createFramebuffer()!; }) || !target.fbo) return false;
      if (!storage(target.color, RGBA8) || !storage(target.depthStencil, DEPTH24_STENCIL8)) return false;
      if (!checkedGlCall(owner, () => gl.bindFramebuffer(DRAW, target.fbo)) ||
          !checkedGlCall(owner, () => gl.framebufferRenderbuffer(DRAW, COLOR0, RBO, target.color)) ||
          !checkedGlCall(owner, () => gl.framebufferRenderbuffer(DRAW, DEPTH_STENCIL_ATTACHMENT, RBO, target.depthStencil))) return false;
      let status = 0;
      return checkedGlCall(owner, () => { status = gl.checkFramebufferStatus(DRAW); }) && status === 0x8cd5;
    } }], { shared: true, finalizer: nativeInverse(owner, ...restore.groups) });
  } catch { accepted = false; }
  if (!accepted) { retireNativeRetirement(retirement); return null; }
  return target;
}

/** Resolve `source` into single-sampled `destination` over the whole
 * surface. Identical rectangles are required for a multisampled source. The
 * caller has already captured the selected owner's pending GL errors; this
 * private owner's failures are renderer faults, never guest GL errors. */
export function resolveMultisample(gl: WebGL2RenderingContext, source: WebGLFramebuffer,
  destination: WebGLFramebuffer, w: number, h: number): boolean {
  const owner = { gl, errors: [] as number[], shadow: {} };
  try {
    let oldRead: WebGLFramebuffer | null = null, oldDraw: WebGLFramebuffer | null = null, scissor = false;
    if (!checkedGlCall(owner, () => {
      oldRead = gl.getParameter(READ_BINDING);
      oldDraw = gl.getParameter(DRAW_BINDING);
      scissor = !!gl.getParameter(SCISSOR);
    })) return false;
    const readGroup: NativeCall[] = [["bindFramebuffer", READ, source]];
    const sourceReadRestore = nativeInverse(owner, readGroup);
    return applyNativeChanges(owner, [
      // BlitFramebuffer honors the scissor test; a guest scissor must not
      // clip the posted or read image.
      { apply: () => checkedGlCall(owner, () => gl.disable(SCISSOR)),
        restore: nativeInverse(owner, [[scissor ? "enable" : "disable", SCISSOR]]) },
      { apply: () => {
        if (!checkedGlCall(owner, () => gl.bindFramebuffer(READ, source))) return false;
        let mode: unknown;
        if (!checkedGlCall(owner, () => { mode = gl.getParameter(READ_BUFFER); }) || !Number.isInteger(mode)) return false;
        readGroup.push(["readBuffer", mode as number]);
        return true;
      }, restore: nativeInverse(owner, [["bindFramebuffer", READ, oldRead]]) },
      { apply: () => checkedGlCall(owner, () => gl.readBuffer(COLOR0)), restore: sourceReadRestore },
      { apply: () => checkedGlCall(owner, () => gl.bindFramebuffer(DRAW, destination)),
        restore: nativeInverse(owner, [["bindFramebuffer", DRAW, oldDraw]]) },
      { apply: () => checkedGlCall(owner, () => gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, 0x4000, 0x2600)),
        restore: nativeInverse(owner) },
    ], { shared: true, finalizer: nativeInverse(owner, readGroup,
      [["bindFramebuffer", READ, oldRead]], [["bindFramebuffer", DRAW, oldDraw]],
      [[scissor ? "enable" : "disable", SCISSOR]]) });
  } catch { return false; }
}

/** The single-sampled storage that holds a multisampled surface's resolved
 * image: its own present target or its borrowed GBM/Wayland render back. */
export function multisampleResolveStorage(surface: GlSurfaceResources): { fbo: WebGLFramebuffer; w: number; h: number } | null {
  const ms = surface.multisample, storage = surface.presentTarget ?? surface.borrowedTarget;
  if (!ms || !storage || surface.renderTargetFbo !== ms.fbo || storage.w !== ms.w || storage.h !== ms.h) return null;
  return storage;
}

/** Resolve a multisampled surface into its storage before the storage is
 * posted or copied. Single-sampled surfaces have nothing to do. The caller
 * captures the selected owner's GL errors first. */
export function resolveSurfaceMultisample(surface: GlSurfaceResources): boolean {
  const ms = surface.multisample;
  if (!ms) return true;
  const storage = multisampleResolveStorage(surface);
  return !!storage && !!surface.gl && resolveMultisample(surface.gl, ms.fbo, storage.fbo, ms.w, ms.h);
}

type MultisampleRead = { source: WebGLFramebuffer; destination: WebGLFramebuffer; w: number; h: number };
/** The multisampled default framebuffer currently selected for reading, with
 * its resolve storage. Executing work uses its captured allocation; other
 * work uses the selected surface's live allocation. */
function multisampleRead(b: GlBinding): MultisampleRead | null {
  const framebuffer = b.shadow.readFbo;
  if (!framebuffer) return null;
  const execution = b.executionDrawable;
  if (execution && framebuffer === execution.readFramebuffer) {
    return execution.readResolve ? { source: framebuffer, destination: execution.readResolve,
      w: execution.readWidth, h: execution.readHeight } : null;
  }
  for (const surface of [b.readSurface, b.drawSurface, b.surface]) {
    if (surface?.multisample?.fbo !== framebuffer) continue;
    const storage = multisampleResolveStorage(surface);
    if (!storage) throw new Error("Multisampled surface has no resolve storage");
    return { source: framebuffer, destination: storage.fbo, w: storage.w, h: storage.h };
  }
  return null;
}

/** Run a guest read (ReadPixels, CopyTex[Sub]Image2D) against resolved
 * pixels when the read framebuffer is a multisampled default framebuffer.
 * The guest's own GL errors stay the guest's; a failed resolve or selector
 * restoration is a renderer fault and throws, leaving any unrestored
 * selector as a pending native repair that fences the context. */
export function withMultisampleRead<T>(b: GlBinding, work: () => T): T {
  const read = multisampleRead(b);
  if (!read) return work();
  const gl = b.gl!;
  captureNativeGlErrors(gl, b);
  const owner = { gl, errors: [] as number[], shadow: {} };
  let mode: unknown;
  if (!checkedGlCall(owner, () => { mode = gl.getParameter(READ_BUFFER); }) || !Number.isInteger(mode))
    throw new Error("Multisampled read buffer query failed");
  // READ_BUFFER NONE selects no color image: nothing to resolve, and the
  // guest's read reports its own error against the selected framebuffer.
  if (mode === 0) return work();
  if (!resolveMultisample(gl, read.source, read.destination, read.w, read.h))
    throw new Error("Multisample resolve failed");
  let result!: T;
  const accepted = applyNativeChanges(owner, [
    { apply: () => checkedGlCall(owner, () => gl.bindFramebuffer(READ, read.destination)),
      restore: nativeInverse(owner, [["bindFramebuffer", READ, read.source]]) },
    { apply: () => { result = work(); captureNativeGlErrors(gl, b); return true; }, restore: nativeInverse(owner) },
  ], { shared: true, finalizer: nativeInverse(owner, [["bindFramebuffer", READ, read.source]]) });
  if (!accepted) throw new Error("Multisampled read restoration failed");
  return result;
}
