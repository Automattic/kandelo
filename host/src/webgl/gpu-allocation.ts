import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement,
  type NativeRetirement } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";

export type GlGpuAllocation = {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  depthStencil: WebGLRenderbuffer;
  texId: number;
  w: number;
  h: number;
  retirement: NativeRetirement;
};

/** Reserve native ownership before creating any member. Publication follows
 * checked allocation and complete restoration of the selected peer's state.
 * Failed cleanup/inverses remain in the physical renderer's native journal. */
export function allocateGpuStorage(gl: WebGL2RenderingContext, w: number, h: number, texId: number,
  publish: (allocation: GlGpuAllocation) => void): boolean {
  const owner = {gl,errors:[] as number[]};
  let active = 0, texture: WebGLTexture | null = null, renderbuffer: WebGLRenderbuffer | null = null;
  let read: WebGLFramebuffer | null = null, draw: WebGLFramebuffer | null = null;
  if (!checkedGlCall(owner,()=>{
    active = gl.getParameter(0x84e0);
    texture = gl.getParameter(0x8069); renderbuffer = gl.getParameter(0x8ca7);
    read = gl.getParameter(0x8caa); draw = gl.getParameter(0x8ca6);
  }) || !Number.isInteger(active) || active < 0x84c0) return false;
  const retirement = reserveNativeRetirement(owner,[["deleteFramebuffer",null],["deleteRenderbuffer",null],["deleteTexture",null]],[],{ordered:true});
  if (!retirement) return false;
  let published = false;
  try {
    const allocation = {gl,w,h,texId,retirement,tex:null,fbo:null,depthStencil:null} as unknown as GlGpuAllocation;
    const restore = nativeInverse(owner,
      [["activeTexture",active],["bindTexture",0x0de1,texture]],
      [["bindRenderbuffer",0x8d41,renderbuffer]],
      [["bindFramebuffer",0x8ca9,draw]],[["bindFramebuffer",0x8ca8,read]]);
    if (!applyNativeChanges({...owner,shadow:{}},[{restore,apply:()=>{
      if (!checkedGlCall(owner,()=>{retirement.calls[2][1] = allocation.tex = gl.createTexture()!;}) || !allocation.tex) return false;
      if (!checkedGlCall(owner,()=>{retirement.calls[0][1] = allocation.fbo = gl.createFramebuffer()!;}) || !allocation.fbo) return false;
      if (!checkedGlCall(owner,()=>{retirement.calls[1][1] = allocation.depthStencil = gl.createRenderbuffer()!;}) || !allocation.depthStencil) return false;
      if (!checkedGlCall(owner,()=>gl.bindTexture(0x0de1,allocation.tex)) ||
          !checkedGlCall(owner,()=>gl.texImage2D(0x0de1,0,0x1908,w,h,0,0x1908,0x1401,null))) return false;
      for (const [pname,value] of [[0x2801,0x2601],[0x2800,0x2601],[0x2802,0x812f],[0x2803,0x812f]])
        if (!checkedGlCall(owner,()=>gl.texParameteri(0x0de1,pname,value))) return false;
      if (!checkedGlCall(owner,()=>gl.bindFramebuffer(0x8d40,allocation.fbo)) ||
          !checkedGlCall(owner,()=>gl.framebufferTexture2D(0x8d40,0x8ce0,0x0de1,allocation.tex,0)) ||
          !checkedGlCall(owner,()=>gl.bindRenderbuffer(0x8d41,allocation.depthStencil)) ||
          !checkedGlCall(owner,()=>gl.renderbufferStorage(0x8d41,0x88f0,w,h)) ||
          !checkedGlCall(owner,()=>gl.framebufferRenderbuffer(0x8d40,0x821a,0x8d41,allocation.depthStencil))) return false;
      let status = 0;
      return checkedGlCall(owner,()=>{status=gl.checkFramebufferStatus(0x8d40);}) && status === 0x8cd5;
    }}],{shared:true,finalizer:restore})) return false;
    publish(allocation); published = true;
    return true;
  } catch { return false; }
  finally { if (!published) retireNativeRetirement(retirement); }
}
