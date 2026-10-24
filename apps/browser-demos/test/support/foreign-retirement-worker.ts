import { GlContextRegistry } from "../../../../host/src/webgl/registry";
import { bindGpuForeignTexture } from "../../../../host/src/webgl/foreign-texture";
import { textureNative } from "../../../../host/src/webgl/image-storage";
import { runGlQuery } from "../../../../host/src/webgl/query";
import * as O from "../../../../host/src/webgl/ops";

// Native shared-host source fixture. Guest marshalling and full compositor
// lifetime/conformance remain separate gates.
self.onmessage = ({data}) => {
  try {
    const gl = (data.canvas as OffscreenCanvas).getContext("webgl2",{antialias:false});
    if (!gl) throw new Error("WebGL2 required");
    const require = (test: unknown,label: string) => { if (!test) throw new Error(label); };
    const made: object[] = [], deleted: object[] = [], live: (() => boolean)[] = [];
    for (const kind of ["Texture","Framebuffer","Renderbuffer"]) {
      const api = gl as any, create = api[`create${kind}`].bind(gl), destroy = api[`delete${kind}`].bind(gl), is = api[`is${kind}`].bind(gl);
      api[`create${kind}`] = () => { const object = create(); if (object) { made.push(object); live.push(() => is(object)); } return object; };
      api[`delete${kind}`] = (object: object|null) => { if (object) deleted.push(object); destroy(object); };
    }
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
    const attach = gl.framebufferTexture2D.bind(gl), bind = gl.bindTexture.bind(gl), frame = gl.bindFramebuffer.bind(gl);
    let rejected = false, block = true, originRetired = false, deadBinds = 0;
    gl.bindFramebuffer = (target,value) => { if (originRetired && value === frames[0]) deadBinds++; frame(target,value); };
    gl.framebufferTexture2D = (target,point,imageTarget,texture,level) => {
      const selected = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      if (data.fault === "attachment" && rejected && block && selected === frames[1] && texture === gpu.tex) {
        attach(0xdead,point,imageTarget,texture,level); return;
      }
      attach(target,point,imageTarget,texture,level);
      if (data.fault === "attachment" && !rejected && selected === frames[1] && !texture) {
        rejected = true; attach(0xdead,point,imageTarget,texture,level);
      }
    };
    gl.bindTexture = (target,value) => {
      const unit = gl.getParameter(gl.ACTIVE_TEXTURE);
      if (data.fault === "unit" && rejected && block && unit === gl.TEXTURE0 && value === native) { bind(0xdead,null); return; }
      bind(target,value);
      if (data.fault === "unit" && !rejected && unit === gl.TEXTURE1 && !value) { rejected = true; bind(0xdead,null); }
    };
    require(!registry.dropForeignTexturesForBo(41) && rejected,"partial accepted detach then rejected inverse");
    const output = new Uint8Array(4).fill(0xa5);
    for (const owner of [first,peer]) require(runGlQuery(owner,O.QOP_GET_ERROR,new Uint8Array(),output) === -5 && output.every(x => x === 165),"repair query fence");
    require(first.textures.get(name) === object && peer.shadow.textureUnits[1] === object && gl.isTexture(gpu.tex),"authoritative ownership unchanged");
    if (data.fault === "attachment") {
      registry.destroyContext(7,11); originRetired = true;
      require(!gl.isFramebuffer(frames[0]) && gl.isFramebuffer(frames[1]),"only submitting container retired");
      require(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),output) === -5 && output.every(x => x === 165),"shared inverse survives origin");
    }
    block = false;
    require(runGlQuery(peer,O.QOP_GET_ERROR,new Uint8Array(),output) === 4,"native recovery completion");
    require(gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE2 && gl.getParameter(gl.TEXTURE_BINDING_2D) === unrelated,"unrelated active unit preserved");
    require(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === (originRetired ? null : frames[0]) &&
      gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === frames[1],"separate native framebuffer restoration");
    for (const unit of [0,1]) { gl.activeTexture(gl.TEXTURE0+unit); require(gl.getParameter(gl.TEXTURE_BINDING_2D) === native,"exact old sampling view"); }
    gl.activeTexture(gl.TEXTURE2);
    const colors: number[][] = [];
    for (const value of originRetired ? [frames[1]] : frames) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,value);
      require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,"restored shared image complete");
      const rgba = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba); colors.push([...rgba]);
    }
    registry.retryForeignRetirements();
    require(!registry.hasForeignRetirements() && !gl.isTexture(gpu.tex) && !gl.isTexture(native),"canonical retirement follows repaired views");
    require(!peer.textures.has(name) && peer.shadow.textureUnits[1] === null && peer.framebufferAttachments.size === 0,"logical retirement committed");
    require(deadBinds === 0,"retired container never rebound");
    gl.framebufferTexture2D = attach; gl.bindTexture = bind; gl.bindFramebuffer = frame;
    if (!originRetired) registry.destroyContext(7,11);
    registry.destroyContext(7,12); gl.deleteTexture(unrelated);
    const clean = made.length === deleted.length && new Set(deleted).size === deleted.length && live.every(check => !check());
    require(clean,"all native owners deleted once");
    postMessage({type:"foreign_retirement_result",fault:data.fault,colors,deadBinds,clean,error:gl.getError()});
  } catch (error) { postMessage({type:"foreign_retirement_failed",error:String(error)}); }
};
