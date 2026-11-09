import { GlContextRegistry } from "../../../../host/src/webgl/registry";
import { bindGpuForeignTexture } from "../../../../host/src/webgl/foreign-texture";
import { textureNative } from "../../../../host/src/webgl/image-storage";
import { runGlQuery } from "../../../../host/src/webgl/query";
import { NativeGlFault, setNativeGlFaultReporter } from "../../../../host/src/webgl/native-recovery";
import * as O from "../../../../host/src/webgl/ops";

// Native shared-host source fixture. Guest marshalling and full compositor
// lifetime/conformance remain separate gates.
self.onmessage = ({data}) => {
  try {
    const gl = (data.canvas as OffscreenCanvas).getContext("webgl2",{antialias:false});
    if (!gl) throw new Error("WebGL2 required");
    const require = (test: unknown,label: string) => { if (!test) throw new Error(label); };
    const registry = new GlContextRegistry();
    for (const session of [11,12]) registry.bind({pid:7,sessionId:session,cmdbufAddr:0,cmdbufLen:0});
    const first = registry.get(7,11)!, peer = registry.get(7,12)!;
    first.gl = peer.gl = gl; first.contextId = 21; peer.contextId = 22;
    require(registry.shareObjects(7,12,11),"shared object group");
    require(registry.createGpuBo(41,gl,1,1) !== null,"canonical BO");
    const gpu = registry.gpuBo(41)!;
    gl.bindFramebuffer(gl.FRAMEBUFFER,gpu.fbo); gl.clearColor(0,1,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    const name = bindGpuForeignTexture(first,41,gpu), object = first.textures.get(name)!;
    require(name > 0 && object,"raw logical view");
    const native = textureNative(first,object), frames = [gl.createFramebuffer()!,gl.createFramebuffer()!];
    for (const [index,owner] of [first,peer].entries()) {
      owner.fbos.set(70+index,frames[index]); owner.shadow.fbo = owner.shadow.readFbo = frames[index];
      gl.bindFramebuffer(gl.FRAMEBUFFER,frames[index]);
      const reply = new Uint8Array(12);
      require(runGlQuery(owner,O.QOP_IMAGE_ATTACHMENT,new Uint8Array(new Uint32Array([1,gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,name,0]).buffer),reply) === 12 &&
        new Uint32Array(reply.buffer)[0] === 0,"shared native attachment");
      owner.shadow.textureUnits[index] = object; gl.activeTexture(gl.TEXTURE0+index); gl.bindTexture(gl.TEXTURE_2D,native);
    }
    const unrelated = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,unrelated);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,255,255]));
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,frames[0]); gl.bindFramebuffer(gl.READ_FRAMEBUFFER,frames[1]);
    require(gl.getError() === 0,"valid native setup");
    // Decision D-29: revocation detaches every view, and one detach is
    // rejected after it changed native state. Restoring the views is a
    // native inverse of host-owned state; a live renderer that refuses it
    // is a fatal host fault, reported before it is thrown, never a repair
    // retried before later GL work.
    const attachmentOf = (value: WebGLFramebuffer) => {
      frame(gl.DRAW_FRAMEBUFFER,value);
      return gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
    };
    const attach = gl.framebufferTexture2D.bind(gl), bind = gl.bindTexture.bind(gl), frame = gl.bindFramebuffer.bind(gl);
    const attachedBefore = attachmentOf(frames[0]); frame(gl.DRAW_FRAMEBUFFER,frames[0]);
    require(attachedBefore !== null && gl.getError() === 0,"shared attachment before revocation");
    let rejected = false;
    gl.framebufferTexture2D = (target,point,imageTarget,texture,level) => {
      const selected = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      if (data.fault === "attachment" && rejected && selected === frames[1] && texture === gpu.tex) {
        attach(0xdead,point,imageTarget,texture,level); return;
      }
      attach(target,point,imageTarget,texture,level);
      if (data.fault === "attachment" && !rejected && selected === frames[1] && !texture) {
        rejected = true; attach(0xdead,point,imageTarget,texture,level);
      }
    };
    gl.bindTexture = (target,value) => {
      const unit = gl.getParameter(gl.ACTIVE_TEXTURE);
      if (data.fault === "unit" && rejected && unit === gl.TEXTURE0 && value === native) { bind(0xdead,null); return; }
      bind(target,value);
      if (data.fault === "unit" && !rejected && unit === gl.TEXTURE1 && !value) { rejected = true; bind(0xdead,null); }
    };
    const reported: Error[] = [];
    setNativeGlFaultReporter(fault => { reported.push(fault); });
    let thrown: unknown;
    try { registry.dropForeignTexturesForBo(41); } catch (error) { thrown = error; }
    finally { setNativeGlFaultReporter(null); gl.framebufferTexture2D = attach; gl.bindTexture = bind; }
    require(rejected,"partial accepted detach then rejected inverse");
    // The fault leaves logical ownership uncommitted and the refused native
    // restoration undone; the independent restorations still ran. Nothing
    // after a fatal fault is retried or cleaned up: terminating the worker
    // releases the renderer.
    const ownership = first.textures.get(name) === object && peer.shadow.textureUnits[1] === object && gl.isTexture(gpu.tex);
    let dirty: boolean, otherRestored: boolean;
    if (data.fault === "attachment") {
      dirty = attachmentOf(frames[1]) === null; otherRestored = attachmentOf(frames[0]) === attachedBefore;
    } else {
      gl.activeTexture(gl.TEXTURE0); dirty = gl.getParameter(gl.TEXTURE_BINDING_2D) === null;
      gl.activeTexture(gl.TEXTURE1); otherRestored = gl.getParameter(gl.TEXTURE_BINDING_2D) === native;
    }
    postMessage({type:"foreign_retirement_result",fault:data.fault,
      thrown:thrown instanceof NativeGlFault ? thrown.name : String(thrown),
      message:thrown instanceof Error ? thrown.message : null,
      reported:reported.length === 1 && reported[0] === thrown,ownership,dirty,otherRestored});
  } catch (error) { postMessage({type:"foreign_retirement_failed",error:String(error)}); }
};
