import {createWasmPosixKernelTestHarness} from "../../../../host/src/kernel";
import {createKernelScratchTestInstance} from "../../../../host/test/support/kernel-scratch-instance";
import * as O from "../../../../host/src/webgl/ops";

// A surfaceless current context on the kernel worker's own WebGL 2 renderer,
// driven through the actual host_gl_* imports. Framebuffer zero has no
// storage (FRAMEBUFFER_UNDEFINED), so rendering and reading it fail with
// INVALID_FRAMEBUFFER_OPERATION, while user framebuffers stay usable and the
// visible canvas is never touched.
self.onmessage = ({data}) => {
  try {
    const pid = 81, session = 101, context = 201;
    const canvas = data.canvas as OffscreenCanvas;
    const gl = canvas.getContext("webgl2",{preserveDrawingBuffer:true});
    if (!gl) throw new Error("WebGL2 is required");
    gl.clearColor(0,0,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
    const memory = new WebAssembly.Memory({initial:2,maximum:2});
    const native = createWasmPosixKernelTestHarness({io:{} as any,
      callbacks:{getProcessMemory:() => memory},memory,pointerWidth:4,
      instance:createKernelScratchTestInstance(4,memory,() => ({}),() => 4096)});
    const imports = (native.testAuthority.buildImportObject(memory) as {env:Record<string,(...args:any[]) => any>}).env;
    native.gl.attachCanvas(pid,canvas);
    const commands = 8192, input = 64, output = 1024;
    imports.host_gl_bind(pid,commands,4096,session,1n);
    if (imports.host_gl_create_context(pid,context,0,0,session) !== 0
        || imports.host_gl_make_current(pid,context,0,0,session) !== 0)
      throw new Error("surfaceless bind failed");
    const send = (op:number, words:number[], tail = new Uint8Array(), float = false) => {
      const bytes = new Uint8Array(4+words.length*4+tail.length), v = new DataView(bytes.buffer);
      v.setUint16(0,op,true); v.setUint16(2,bytes.length-4,true);
      words.forEach((word,i) => float ? v.setFloat32(4+i*4,word,true) : v.setUint32(4+i*4,word,true));
      bytes.set(tail,4+words.length*4);
      new Uint8Array(memory.buffer,commands,bytes.length).set(bytes);
      const rc = imports.host_gl_submit(pid,0,bytes.length,session);
      if (rc !== 0) throw new Error(`submit ${op.toString(16)}: ${rc}`);
    };
    const query = (op:number, words:number[] = [], size = 4) => {
      const bytes = new Uint8Array(words.length*4), v = new DataView(bytes.buffer);
      words.forEach((word,i) => v.setUint32(i*4,word,true));
      new Uint8Array(memory.buffer,input,bytes.length).set(bytes);
      new Uint8Array(memory.buffer,output,size).fill(0);
      const rc = imports.host_gl_query(pid,op,input,bytes.length,output,size,session) as number;
      return {rc, bytes: rc > 0 ? new Uint8Array(memory.buffer,output,rc).slice() : new Uint8Array()};
    };
    const number = (op:number, words:number[] = []) => {
      const reply = query(op,words); if (reply.rc !== 4) throw new Error("query failed: "+reply.rc);
      return new DataView(reply.bytes.buffer).getUint32(0,true);
    };
    const error = () => number(O.QOP_GET_ERROR);
    const status = () => number(O.QOP_CHECK_FB_STATUS,[0x8d40]);
    const initialStatus = status();
    const viewportReply = query(O.QOP_GET_INTEGERV,[0x0ba2],16);
    const viewport = [...new Int32Array(viewportReply.bytes.buffer)];
    for (const [name,type,text] of [
      [11,0x8b31,"void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
      [12,0x8b30,"precision mediump float;void main(){gl_FragColor=vec4(0.,1.,0.,1.);}"]] as const) {
      send(O.OP_CREATE_SHADER,[type,name]);
      const bytes = new TextEncoder().encode(text); send(O.OP_SHADER_SOURCE,[name,bytes.length],bytes);
      send(O.OP_COMPILE_SHADER,[name]);
      if (number(O.QOP_GET_SHADERIV,[name,0x8b81]) !== 1) throw new Error("shader failed");
    }
    send(O.OP_CREATE_PROGRAM,[13]); send(O.OP_ATTACH_SHADER,[13,11]); send(O.OP_ATTACH_SHADER,[13,12]);
    send(O.OP_LINK_PROGRAM,[13]); if (number(O.QOP_GET_PROGRAMIV,[13,0x8b82]) !== 1) throw new Error("link failed");
    send(O.OP_USE_PROGRAM,[13]); send(O.OP_VIEWPORT,[0,0,1,1]);
    send(O.OP_GEN_TEXTURES,[2,7,8]); send(O.OP_BIND_TEXTURE,[0x0de1,7]);
    send(O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,4],new Uint8Array([255,0,0,255]));
    send(O.OP_GEN_BUFFERS,[1,5]); send(O.OP_BIND_BUFFER,[0x8893,5]);
    send(O.OP_BUFFER_DATA,[0x8893,2,0x88e4]);
    const setupError = error(), errors: number[] = [];
    for (const [op,words] of [
      [O.OP_CLEAR,[0x4000]], [O.OP_DRAW_ARRAYS,[0,0,1]], [O.OP_DRAW_ELEMENTS,[0,1,0x1403,0]],
      [O.OP_COPY_TEX_IMAGE_2D,[0x0de1,0,0x1908,0,0,1,1,0]],
      [O.OP_COPY_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,0,0,1,1]]] as const) {
      send(op,[...words]); errors.push(error());
    }
    const read = query(O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401]);
    errors.push(error());
    send(O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,7,0]);
    const attachmentError = error(), statusAfterAttachment = status();
    send(O.OP_GEN_FRAMEBUFFERS,[1,4]); send(O.OP_BIND_FRAMEBUFFER,[0x8d40,4]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,7,0]);
    const copiedTexture = query(O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401]);
    send(O.OP_BIND_TEXTURE,[0x0de1,8]); send(O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,0]);
    send(O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,8,0]);
    const userStatus = status();
    send(O.OP_CLEAR_COLOR,[0,1,0,1],new Uint8Array(),true); send(O.OP_CLEAR,[0x4000]);
    send(O.OP_DRAW_ARRAYS,[0,0,1]); send(O.OP_DRAW_ELEMENTS,[0,1,0x1403,0]);
    const userPixels = query(O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401]), userError = error();
    // GLES 2 has one framebuffer target: WebGL 2's split selectors are
    // INVALID_ENUM and leave the bound user framebuffer in place.
    send(O.OP_BIND_FRAMEBUFFER,[0x8ca9,0]);
    const split: Record<string, number> = {bindError:error(),draw:status(),read:number(O.QOP_CHECK_FB_STATUS,[0x8ca8]),
      readError:error(),drawName:number(O.QOP_GET_INTEGERV,[0x8ca6]),
      readNameRc:query(O.QOP_GET_INTEGERV,[0x8caa]).rc,readNameError:error()};
    send(O.OP_CLEAR,[0x4000]); split.clearError = error();
    send(O.OP_BIND_FRAMEBUFFER,[0x8d40,4]);
    send(O.OP_DELETE_FRAMEBUFFERS,[1,4]); const deletedStatus = status();
    send(O.OP_CLEAR,[0x4000]); const deletedError = error();
    imports.host_gl_destroy_context(pid,context);
    imports.host_gl_unbind(pid,session);
    // The visible canvas keeps the blue it had before the surfaceless session.
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const canvasPixels = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,canvasPixels);
    postMessage({type:"surface_done",results:{initialStatus,viewport,setupError,errors,
      readRc:read.rc,readBytes:[...read.bytes],attachmentError,statusAfterAttachment,
      copiedTextureRc:copiedTexture.rc,copiedTexture:[...copiedTexture.bytes],
      userStatus,userPixels:[...userPixels.bytes],userError,split,deletedStatus,deletedError,
      canvasPixels:[...canvasPixels]}});
  } catch (error) { postMessage({type:"surface_failed",error:String(error)}); }
};
