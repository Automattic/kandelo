import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";

export const SURFACE_CAPABILITIES_BYTES = 16;

/** Obtaining immutable limits must not publish a logical context or take
 * another thread's current binding. Native context creation remains lazy. */
export function surfaceCapabilityRenderer(b: GlBinding, canvas = b.canvas): WebGL2RenderingContext|null {
  if (b.gl) return b.gl;
  if (!canvas) return null;
  return canvas.getContext("webgl2",{
    antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true,
  }) as WebGL2RenderingContext|null;
}

/** Caller captures the outgoing muxer owner's native errors before entry.
 * Hardware limits are independent of context-local selectors and containers. */
export function querySurfaceCapabilities(gl: WebGL2RenderingContext|null, input: Uint8Array, output: Uint8Array): number {
  if (input.byteLength !== 0 || output.byteLength !== SURFACE_CAPABILITIES_BYTES) return -22;
  if (!gl || gl.isContextLost()) return -19;
  // EGL failures have their own reply/error channel. Internal limit-query
  // errors must not become GL flags on a subsequently created user context.
  const owner = {gl,errors:[] as number[]};
  let texture = 0, renderbuffer = 0;
  if (!checkedGlCall(owner, () => { texture = Number(gl.getParameter(0x0d33)); }) ||
      !checkedGlCall(owner, () => { renderbuffer = Number(gl.getParameter(0x84e8)); })) return -5;
  if (![texture,renderbuffer].every(value => Number.isInteger(value) && value > 0 && value <= 0x7fff_ffff)) return -5;
  const dimension = Math.min(texture,renderbuffer), pixels = Math.min(dimension*dimension,0x7fff_ffff);
  const view = new DataView(output.buffer,output.byteOffset,output.byteLength);
  view.setUint32(0,dimension,true); view.setUint32(4,dimension,true); view.setUint32(8,pixels,true);
  view.setUint32(12,0x47514c33,true);
  return SURFACE_CAPABILITIES_BYTES;
}
