import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

// Actual WebGL rendering through the shared decoder and muxer. This checks
// host execution pixels; guest ABI/compositor integration has separate tests.
for (const kind of ["client", "fixed", "max-byte", "max-short", "bound-byte", "bound-short"] as const) {
  test(`actual C encoder renders ${kind.startsWith("bound-") ? `bound ${kind.slice(6)} indices with client attributes` : kind.startsWith("max-") ? `maximum ${kind.slice(4)} indices` : `a large ${kind === "fixed" ? "fixed-point" : "float"} client array`} through WebGL`, async ({ page }) => {
    const root = fileURLToPath(new URL("../../../",import.meta.url));
    mkdirSync(join(root,".context"),{recursive:true});
    const temporary = mkdtempSync(join(root,".context/graphics-client-trace-"));
    let trace: number[];
    try {
      const path = join(temporary,"commands.bin");
      execFileSync("bash",[join(root,"tests/graphics/run-libc-unit.sh")],{
        cwd:root, env:{...process.env,KANDELO_GRAPHICS_LIBC_CASES:kind.includes("-") ? `encoder-${kind}` : `encoder-large-${kind}`,KANDELO_GRAPHICS_PROTOCOL_TRACE:path},
        timeout:60000,stdio:"pipe",
      });
      trace = [...readFileSync(path)];
    } finally { rmSync(temporary,{recursive:true,force:true}); }
    await page.goto("/trap-signal-test.html");
    const result = await page.evaluate(async ({sourceRoot,trace}) => {
      const base = `/@fs/${sourceRoot}host/src/webgl/`;
      const { GlContextRegistry } = await import(base+"registry.ts");
      const { GlMuxer } = await import(base+"muxer.ts");
      const { decodeAndDispatch } = await import(base+"bridge.ts");
      const { runGlQuery } = await import(base+"query.ts");
      const O = await import(base+"ops.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      document.body.replaceChildren(canvas);
      const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
      if (!gl) throw new Error("WebGL2 required");
      const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
      reg.bind({pid:95,sessionId:101,cmdbufAddr:0,cmdbufLen:1<<20});
      const b = reg.get(95,101)!; b.gl = gl; b.contextId = 101; b.cmdbufView = new Uint8Array(1<<20);
      const send = (op: number, words: number[], tail = new Uint8Array()) => {
        mux.switchTo(b); const view = new DataView(b.cmdbufView!.buffer);
        view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
        words.forEach((word,i) => view.setUint32(4+i*4,word,true)); b.cmdbufView!.set(tail,4+words.length*4);
        if (decodeAndDispatch(b,0,4+words.length*4+tail.length)) throw new Error("setup command failed");
      };
      for (const [name,type,text] of [
        [11,gl.VERTEX_SHADER,"attribute vec4 color; varying vec4 c; void main(){c=color;gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
        [12,gl.FRAGMENT_SHADER,"precision mediump float; varying vec4 c; void main(){gl_FragColor=vec4(c.r+.5,c.g-.5,1.,c.a);}"]
      ] as [number,number,string][]) {
        send(O.OP_CREATE_SHADER,[type,name]); const textBytes = new TextEncoder().encode(text);
        send(O.OP_SHADER_SOURCE,[name,textBytes.length],textBytes); send(O.OP_COMPILE_SHADER,[name]);
      }
      send(O.OP_CREATE_PROGRAM,[13]); send(O.OP_ATTACH_SHADER,[13,11]); send(O.OP_ATTACH_SHADER,[13,12]);
      send(O.OP_BIND_ATTRIB_LOCATION,[13,0,5],new TextEncoder().encode("color")); send(O.OP_LINK_PROGRAM,[13]);
      send(O.OP_USE_PROGRAM,[13]); send(O.OP_VIEWPORT,[0,0,1,1]);
      const records = new Uint8Array(trace), recordsView = new DataView(records.buffer);
      for (let offset = 0; offset < records.length;) {
        const kind = recordsView.getUint32(offset, true), op = recordsView.getUint32(offset + 4, true);
        const length = recordsView.getUint32(offset + 8, true), outputLength = recordsView.getUint32(offset + 12, true);
        const input = records.slice(offset + 16, offset + 16 + length);
        if (kind === 1) {
          b.cmdbufView!.set(input);
          if (decodeAndDispatch(b, 0, length)) throw new Error("C trace command failed");
        } else if (kind === 2) {
          const output = new Uint8Array(outputLength);
          if (runGlQuery(b, op, input, output) !== outputLength) throw new Error("C trace query failed");
          if (op === O.QOP_BIND_BUFFER || op === O.QOP_DELETE_BUFFER) {
            const ack = new DataView(output.buffer);
            if (ack.getUint32(0, true) !== 0 || ack.getUint32(4, true) !== 1 || ack.getUint32(8, true) !== 0x47514c33)
              throw new Error("C trace buffer mutation rejected");
          }
        } else throw new Error("Unknown C protocol record");
        offset += 16 + length;
      }
      const input = new Uint8Array(24), pixels = new Uint8Array(4);
      [0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE].forEach((n,i) => new DataView(input.buffer).setUint32(i*4,n,true));
      if (runGlQuery(b,O.QOP_READ_PIXELS,input,pixels) !== 4) throw new Error("pixel query failed");
      const error = new Uint8Array(4); runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),error);
      const buffersRetired = b.bufferStores.size === 0 && b.bufferViewOwners.size === 0 && b.retiredBuffers.size === 0;
      mux.invalidateCurrent(); reg.destroyContext(95,101);
      return {pixels:[...pixels],error:new DataView(error.buffer).getUint32(0,true),buffersRetired};
    },{sourceRoot:process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? root,trace});
    expect(result).toEqual({pixels:[0,255,255,255],error:0,buffersRetired:true});
  });
}

test("actual C display generations keep their command streams and rendered targets independent", async ({ page }) => {
  const root = fileURLToPath(new URL("../../../",import.meta.url));
  const temporary = mkdtempSync(join(root,".context/graphics-generation-trace-"));
  let trace: number[];
  try {
    const path = join(temporary,"sessions.bin");
    execFileSync("bash",[join(root,"tests/graphics/run-libc-unit.sh")],{
      cwd:root,env:{...process.env,KANDELO_GRAPHICS_LIBC_CASES:"display-generation-render",KANDELO_GRAPHICS_SESSION_TRACE:path},
      timeout:60000,stdio:"pipe",
    });
    trace = [...readFileSync(path)];
  } finally { rmSync(temporary,{recursive:true,force:true}); }
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async ({sourceRoot,trace}) => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts");
    const { ensurePresentTarget } = await import(base+"present-target.ts");
    const { applyCurrentDrawable } = await import(base+"current.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2"); if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const bindings = [10,11].map(sessionId => {
      reg.bind({pid:98,sessionId,cmdbufAddr:0,cmdbufLen:1<<20});
      const b = reg.get(98,sessionId)!;
      b.gl = gl; b.canvas = canvas; b.contextId = sessionId; b.cmdbufView = new Uint8Array(1<<20);
      if (!ensurePresentTarget(b) || !applyCurrentDrawable(b,{drawSurfaceId:1,readSurfaceId:1,width:1,height:1})) throw new Error("target allocation failed");
      return b;
    });
    const targets = bindings.map(b => b.presentTarget!);
    const frames = new Uint8Array(trace), view = new DataView(frames.buffer), pixels: number[][] = [], retired: number[] = [];
    for (let offset=0; offset<frames.length;) {
      const session = view.getUint32(offset,true), size = view.getUint32(offset+4,true); offset += 8;
      const b = bindings[session-10]; if (!b || offset+size>frames.length) throw new Error("invalid session trace");
      if (!size) {
        mux.invalidateCurrent(); reg.destroyContext(98,session); retired.push(session);
        if (gl.isFramebuffer(targets[session-10].fbo)) throw new Error("generation target retained");
        if (session === 10 && !gl.isFramebuffer(targets[1].fbo)) throw new Error("old retirement destroyed new target");
        continue;
      }
      mux.switchTo(b); b.cmdbufView!.set(frames.subarray(offset,offset+size)); offset += size;
      if (decodeAndDispatch(b,0,size)) throw new Error("C generation command failed");
      const input = new Uint8Array(24), output = new Uint8Array(4);
      [0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE].forEach((n,i) => new DataView(input.buffer).setUint32(i*4,n,true));
      if (runGlQuery(b,O.QOP_READ_PIXELS,input,output) !== 4) throw new Error("pixel query failed");
      pixels.push([...output]);
      const error = new Uint8Array(4); runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),error);
      if (new DataView(error.buffer).getUint32(0,true)) throw new Error("native GL error");
    }
    for (const b of bindings) reg.unbind(98,b.sessionId);
    return {pixels,retired,remaining:reg.list().length};
  },{sourceRoot:process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? root,trace});
  expect(result).toEqual({pixels:[[255,0,0,255],[0,0,255,255]],retired:[10,11],remaining:0});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("op-table v3 queries preserve logical state, sparse indices and single GL errors", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const [a,b] = [101,102].map(sessionId => {
      reg.bind({pid:97,sessionId,cmdbufAddr:0,cmdbufLen:1024}); const owner = reg.get(97,sessionId)!;
      owner.gl = gl; owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(1024); return owner;
    });
    if (!reg.shareObjects(97,102,101)) throw new Error("group construction failed");
    const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
      mux.switchTo(owner); const view = new DataView(owner.cmdbufView!.buffer);
      view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
      words.forEach((word,i) => view.setUint32(4+i*4,word,true)); owner.cmdbufView!.set(tail,4+words.length*4);
      if (decodeAndDispatch(owner,0,4+words.length*4+tail.length)) throw new Error("command failed");
    };
    const query = (owner: typeof a, op: number, words: number[], size = 4, allowError = false) => {
      mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(size+8);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
      if (runGlQuery(owner,op,input,out) !== size+8) throw new Error("v3 query transport failed");
      const view = new DataView(out.buffer);
      if (view.getUint32(size+4,true) !== 0x47514c33 || (!allowError && view.getUint32(0,true))) throw new Error("bad v3 reply");
      return {status:view.getUint32(0,true),bytes:out.slice(4,size+4)};
    };
    const scalar = (owner: typeof a, op: number, words: number[]) => new DataView(query(owner,op,words).bytes.buffer).getUint32(0,true);
    const error = (owner: typeof a) => {
      mux.switchTo(owner); const out = new Uint8Array(4);
      if (runGlQuery(owner,O.QOP_GET_ERROR,new Uint8Array(),out) !== 4) throw new Error("error query failed");
      return new DataView(out.buffer).getUint32(0,true);
    };
    send(a,O.OP_GEN_BUFFERS,[1,71]); const reserved = scalar(a,O.QOP_IS_OBJECT,[0,71]);
    send(a,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(a,O.OP_BUFFER_DATA,[gl.ARRAY_BUFFER,32,gl.STATIC_DRAW]);
    send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,71]); send(a,O.OP_BUFFER_DATA,[gl.ARRAY_BUFFER,64,gl.DYNAMIC_DRAW]);
    const size = scalar(a,O.QOP_GET_BUFFER_PARAMETER,[gl.ELEMENT_ARRAY_BUFFER,gl.BUFFER_SIZE]);
    const usage = scalar(a,O.QOP_GET_BUFFER_PARAMETER,[gl.ELEMENT_ARRAY_BUFFER,gl.BUFFER_USAGE]);
    const data = new Uint8Array(new Uint16Array([65535,1,65535]).buffer);
    send(a,O.OP_BUFFER_SUB_DATA,[gl.ARRAY_BUFFER,4,data.length],data);
    const index = query(a,O.QOP_GET_INDEX_USAGE,[gl.UNSIGNED_SHORT,4,3],8196).bytes;
    const sparse = {maximum:new DataView(index.buffer).getUint32(0,true),low:index[4],high:index[8195]};
    send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,3,0x140c,1,1024,16]);
    const format = [gl.VERTEX_ATTRIB_ARRAY_SIZE,gl.VERTEX_ATTRIB_ARRAY_STRIDE,gl.VERTEX_ATTRIB_ARRAY_TYPE,gl.VERTEX_ATTRIB_ARRAY_NORMALIZED,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING]
      .map(pname => scalar(a,O.QOP_GET_VERTEX_ATTRIBIV,[0,pname]));
    send(a,O.OP_VERTEX_ATTRIB_4FV,[0,...new Uint32Array(new Float32Array([-1.75,.25,2.5,1]).buffer)]);
    const integers = [...new Int32Array(query(a,O.QOP_GET_VERTEX_ATTRIBIV,[0,gl.CURRENT_VERTEX_ATTRIB],16).bytes.buffer)];
    const floats = [...new Float32Array(query(a,O.QOP_GET_VERTEX_ATTRIBFV,[0,gl.CURRENT_VERTEX_ATTRIB],16).bytes.buffer)];
    const peerCurrent = [...new Float32Array(query(b,O.QOP_GET_VERTEX_ATTRIBFV,[0,gl.CURRENT_VERTEX_ATTRIB],16).bytes.buffer)];
    send(b,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(b,O.OP_VERTEX_ATTRIB_POINTER,[0,3,0x140c,1,1024,16]);
    send(a,O.OP_DELETE_BUFFERS,[1,71]); const deleted = scalar(b,O.QOP_IS_OBJECT,[0,71]);
    const oldBinding = scalar(b,O.QOP_GET_VERTEX_ATTRIBIV,[0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING]);
    send(a,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(a,O.OP_BUFFER_DATA,[gl.ARRAY_BUFFER,8,gl.STREAM_DRAW]);
    const oldSize = scalar(b,O.QOP_GET_BUFFER_PARAMETER,[gl.ARRAY_BUFFER,gl.BUFFER_SIZE]);
    send(a,O.OP_ENABLE,[gl.BLEND]); const enabled = scalar(a,O.QOP_IS_ENABLED,[gl.BLEND]);
    send(a,O.OP_ENABLE,[0x8c89]); const foreignCap = [error(a),error(a),gl.isEnabled(0x8c89)];
    const failed = query(a,O.QOP_GET_BUFFER_PARAMETER,[gl.ELEMENT_ARRAY_BUFFER,gl.BUFFER_SIZE],4,true);
    const failedQuery = [failed.status,error(a),error(a)];
    const kinds: number[] = [];
    send(a,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,5]); kinds.push(scalar(a,O.QOP_IS_OBJECT,[1,5]));
    send(a,O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,6]); kinds.push(scalar(a,O.QOP_IS_OBJECT,[2,6]));
    send(a,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,7]); kinds.push(scalar(a,O.QOP_IS_OBJECT,[3,7]));
    send(a,O.OP_CREATE_SHADER,[gl.VERTEX_SHADER,8]); kinds.push(scalar(a,O.QOP_IS_OBJECT,[4,8]));
    send(a,O.OP_CREATE_PROGRAM,[9]); kinds.push(scalar(a,O.QOP_IS_OBJECT,[5,9]));
    const errors = [error(a),error(b)]; mux.invalidateCurrent(); reg.destroyContext(97,101); reg.destroyContext(97,102);
    return {reserved,size,usage,sparse,format,integers,floats,peerCurrent,deleted,oldBinding,oldSize,enabled,foreignCap,failedQuery,kinds,errors};
  },root);
  expect(result).toEqual({reserved:0,size:64,usage:0x88e8,sparse:{maximum:65535,low:2,high:128},format:[3,1024,0x140c,1,71],
    integers:[-2,0,3,1],floats:[-1.75,.25,2.5,1],peerCurrent:[0,0,0,1],deleted:0,oldBinding:71,oldSize:64,
    enabled:1,foreignCap:[0x500,0,false],failedQuery:[1,0x502,0],kinds:[1,1,1,1,1],errors:[0,0]});
});

test("remaining GLES2 core object queries retain source and attachment identities", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts"), { decodeAndDispatch } = await import(base+"bridge.ts");
    const { runGlQuery } = await import(base+"query.ts"), O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(); reg.bind({pid:96,sessionId:1,cmdbufAddr:0,cmdbufLen:4096});
    const b = reg.get(96,1)!; b.gl = gl; b.contextId = 1; b.cmdbufView = new Uint8Array(4096);
    const send = (op: number, words: number[], tail = new Uint8Array()) => {
      const v = new DataView(b.cmdbufView!.buffer); v.setUint16(0,op,true); v.setUint16(2,words.length*4+tail.length,true);
      words.forEach((word,i) => v.setUint32(4+4*i,word,true)); b.cmdbufView!.set(tail,4+4*words.length);
      if (decodeAndDispatch(b,0,4+4*words.length+tail.length)) throw new Error("core command failed");
    };
    const query = (op: number, words: number[], size: number, allowError = false) => {
      const input = new Uint8Array(words.length*4), out = new Uint8Array(size+8);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(4*i,word,true));
      if (runGlQuery(b,op,input,out) !== size+8) throw new Error("core query failed");
      const v = new DataView(out.buffer);
      if (v.getUint32(size+4,true) !== 0x47514c33 || (!allowError && v.getUint32(0,true))) throw new Error("bad core reply");
      return {status:v.getUint32(0,true),bytes:out.slice(4,size+4)};
    };
    const scalar = (op: number, words: number[]) => new DataView(query(op,words,4).bytes.buffer).getInt32(0,true);
    const error = () => { const out = new Uint8Array(4); if (runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),out) !== 4) throw new Error("error failed"); return new DataView(out.buffer).getUint32(0,true); };
    const source = "attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}";
    for (const [name,type,text] of [[11,gl.VERTEX_SHADER,source],[12,gl.FRAGMENT_SHADER,"precision mediump float; void main(){gl_FragColor=vec4(1.);}"]] as const) {
      send(O.OP_CREATE_SHADER,[type,name]); const bytes = new TextEncoder().encode(text); send(O.OP_SHADER_SOURCE,[name,bytes.length],bytes); send(O.OP_COMPILE_SHADER,[name]);
    }
    send(O.OP_CREATE_PROGRAM,[13]); send(O.OP_ATTACH_SHADER,[13,11]); send(O.OP_ATTACH_SHADER,[13,12]); send(O.OP_LINK_PROGRAM,[13]);
    send(O.OP_VALIDATE_PROGRAM,[13]); const validated = gl.getProgramParameter(b.programs.get(13)!,gl.VALIDATE_STATUS);
    const attribute = query(O.QOP_GET_ACTIVE_ATTRIB,[13,0,0,8],20).bytes;
    const attributeMeta = [...new Uint32Array(attribute.slice(0,12).buffer)], attributeName = new TextDecoder().decode(attribute.subarray(12));
    const activeLength = new Uint8Array(4); runGlQuery(b,O.QOP_GET_PROGRAMIV,new Uint8Array(new Uint32Array([13,0x8b8a]).buffer),activeLength);
    const maxName = new DataView(activeLength.buffer).getUint32(0,true);
    send(O.OP_DELETE_SHADER,[11]);
    const attached = [...new Uint32Array(query(O.QOP_GET_ATTACHED_SHADERS,[13,0,2],12).bytes.buffer)];
    const original = new TextDecoder().decode(query(O.QOP_GET_SHADER_SOURCE,[11,0,source.length],4+source.length).bytes.subarray(4));
    send(O.OP_CREATE_SHADER,[gl.VERTEX_SHADER,14]); const raw = new Uint8Array([97,0,98,255]); send(O.OP_SHADER_SOURCE,[14,4],raw);
    const rawSource = [...query(O.QOP_GET_SHADER_SOURCE,[14,0,4],8).bytes.subarray(4)];
    const lengthReply = new Uint8Array(4); runGlQuery(b,O.QOP_GET_SHADERIV,new Uint8Array(new Uint32Array([14,0x8b88]).buffer),lengthReply);
    const sourceLength = new DataView(lengthReply.buffer).getUint32(0,true);
    send(O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,7]); send(O.OP_RENDERBUFFER_STORAGE,[gl.RENDERBUFFER,gl.RGBA4,4,5]);
    const renderbuffer = [gl.RENDERBUFFER_WIDTH,gl.RENDERBUFFER_HEIGHT,gl.RENDERBUFFER_INTERNAL_FORMAT,gl.RENDERBUFFER_RED_SIZE]
      .map(pname => [scalar(O.QOP_GET_RENDERBUFFER_PARAMETER,[gl.RENDERBUFFER,pname]),gl.getRenderbufferParameter(gl.RENDERBUFFER,pname)]);
    send(O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,8]); send(O.OP_TEX_PARAMETERI,[gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST]);
    const texture = scalar(O.QOP_GET_TEX_PARAMETER,[gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER]);
    send(O.OP_BIND_TEXTURE,[gl.TEXTURE_CUBE_MAP,10]);
    send(O.OP_TEX_IMAGE_2D,[gl.TEXTURE_CUBE_MAP_NEGATIVE_X,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,0]);
    send(O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,9]); send(O.OP_FRAMEBUFFER_TEXTURE_2D,[gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_CUBE_MAP_NEGATIVE_X,10,0]);
    const before = [...new Uint32Array(query(O.QOP_GET_FB_ATTACHMENT,[gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0],16).bytes.buffer)];
    send(O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,15]); send(O.OP_DELETE_TEXTURES,[1,10]); send(O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,10]); send(O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,9]);
    const after = [...new Uint32Array(query(O.QOP_GET_FB_ATTACHMENT,[gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0],16).bytes.buffer)];
    const pending = error(); const wrongKind = query(O.QOP_GET_ACTIVE_ATTRIB,[12,0,0,0],12,true);
    const errors = [pending,wrongKind.status,error(),error()];
    reg.destroyContext(96,1); return {validated,attributeMeta,attributeName,maxName,attached,original,source,rawSource,sourceLength,renderbuffer,texture,before,after,errors};
  },root);
  expect(result.validated).toBe(true); expect(result.attributeMeta).toEqual([8,1,0x8b50]); expect(result.attributeName).toBe("position"); expect(result.maxName).toBe(9);
  expect(result.attached).toEqual([2,11,12]); expect(result.original).toBe(result.source); expect(result.rawSource).toEqual([97,0,98,255]); expect(result.sourceLength).toBe(5);
  for (const [logical,native] of result.renderbuffer) expect(logical).toBe(native);
  expect(result.renderbuffer[0][0]).toBe(4); expect(result.renderbuffer[1][0]).toBe(5); expect(result.texture).toBe(0x2600);
  expect(result.before).toEqual([0x1702,10,0,0x8516]); expect(result.after).toEqual(result.before); expect(result.errors).toEqual([0,1,0x502,0]);
});

for (const cube of [false,true]) {
  test(`texture zero retains ${cube ? "cube" : "2D"} storage across units, deletion and context retirement`, async ({ page }) => {
    await page.goto("/trap-signal-test.html");
    const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
    const result = await page.evaluate(async ({sourceRoot,cube}) => {
      const base = `/@fs/${sourceRoot}host/src/webgl/`;
      const { GlContextRegistry } = await import(base+"registry.ts"), { GlMuxer } = await import(base+"muxer.ts");
      const { decodeAndDispatch } = await import(base+"bridge.ts"), { runGlQuery } = await import(base+"query.ts"), O = await import(base+"ops.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const gl = canvas.getContext("webgl2"); if (!gl) throw new Error("WebGL2 required");
      const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
      const [a,b] = [1,2].map(sessionId => {
        reg.bind({pid:93,sessionId,cmdbufAddr:0,cmdbufLen:4096}); const owner = reg.get(93,sessionId)!;
        owner.gl = gl; owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(4096); return owner;
      });
      if (!reg.shareObjects(93,2,1)) throw new Error("share group failed");
      const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
      const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
        mux.switchTo(owner); const v = new DataView(owner.cmdbufView!.buffer);
        v.setUint16(0,op,true); v.setUint16(2,words.length*4+tail.length,true);
        words.forEach((word,i) => v.setUint32(4+4*i,word,true)); owner.cmdbufView!.set(tail,4+4*words.length);
        if (decodeAndDispatch(owner,0,4+4*words.length+tail.length)) throw new Error("texture command failed");
      };
      const query = (owner: typeof a, op: number, words: number[], size: number) => {
        mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(size);
        words.forEach((word,i) => new DataView(input.buffer).setUint32(4*i,word,true));
        if (runGlQuery(owner,op,input,out) !== size) throw new Error("texture query failed"); return out;
      };
      const parameter = (owner: typeof a, pname: number) => {
        const out = query(owner,O.QOP_GET_TEX_PARAMETER,[target,pname],12), v = new DataView(out.buffer);
        if (v.getUint32(0,true) || v.getUint32(8,true) !== 0x47514c33) throw new Error("default texture unavailable"); return v.getUint32(4,true);
      };
      const defaults = [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER,gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T].map(pname => parameter(a,pname));
      const zeroA = a.shadow.defaultTextures.get(target)!;
      const upload = (owner: typeof a, rgba: number[]) => {
        for (const image of cube ? [0,1,2,3,4,5].map(i => gl.TEXTURE_CUBE_MAP_POSITIVE_X+i) : [gl.TEXTURE_2D])
          send(owner,O.OP_TEX_IMAGE_2D,[image,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,4],new Uint8Array(rgba));
        send(owner,O.OP_TEX_PARAMETERI,[target,gl.TEXTURE_MIN_FILTER,gl.NEAREST]);
        send(owner,O.OP_TEX_PARAMETERI,[target,gl.TEXTURE_MAG_FILTER,gl.NEAREST]); send(owner,O.OP_GENERATE_MIPMAP,[target]);
      };
      for (const [name,type,text] of [[11,gl.VERTEX_SHADER,"void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
        [12,gl.FRAGMENT_SHADER,`precision mediump float; uniform ${cube ? "samplerCube" : "sampler2D"} tex; void main(){gl_FragColor=${cube ? "textureCube(tex,vec3(1.,0.,0.))" : "texture2D(tex,vec2(.5))"};}`]] as const) {
        send(a,O.OP_CREATE_SHADER,[type,name]); const bytes = new TextEncoder().encode(text); send(a,O.OP_SHADER_SOURCE,[name,bytes.length],bytes); send(a,O.OP_COMPILE_SHADER,[name]);
      }
      send(a,O.OP_CREATE_PROGRAM,[13]); send(a,O.OP_ATTACH_SHADER,[13,11]); send(a,O.OP_ATTACH_SHADER,[13,12]); send(a,O.OP_LINK_PROGRAM,[13]);
      const locIn = new Uint8Array(11); new DataView(locIn.buffer).setUint32(0,13,true); new DataView(locIn.buffer).setUint32(4,3,true); locIn.set(new TextEncoder().encode("tex"),8);
      const locOut = new Uint8Array(4); if (runGlQuery(a,O.QOP_GET_UNIFORM_LOC,locIn,locOut) !== 4) throw new Error("sampler query failed");
      const location = new DataView(locOut.buffer).getInt32(0,true);
      for (const [owner,name,color] of [[a,21,[255,0,0,255]],[b,22,[0,255,0,255]]] as const) {
        send(owner,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,name]); send(owner,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,name]);
        send(owner,O.OP_TEX_IMAGE_2D,[gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,0]);
        send(owner,O.OP_FRAMEBUFFER_TEXTURE_2D,[gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,name,0]); send(owner,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,0]);
        upload(owner,[...color]); send(owner,O.OP_USE_PROGRAM,[13]); send(owner,O.OP_UNIFORM1I,[location,1]); send(owner,O.OP_VIEWPORT,[0,0,1,1]);
      }
      const render = (owner: typeof a) => { send(owner,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]); return [...query(owner,O.QOP_READ_PIXELS,[0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE],4)]; };
      const pixels = [render(a),render(b)]; mux.invalidateCurrent(); pixels.push(render(a));
      send(a,O.OP_DELETE_TEXTURES,[1,0]); pixels.push(render(a));
      const face = cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X : gl.TEXTURE_2D;
      send(a,O.OP_TEX_SUB_IMAGE_2D,[face,0,0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,4],new Uint8Array([255,255,0,255])); pixels.push(render(a));
      send(a,O.OP_CLEAR_COLOR,[...new Uint32Array(new Float32Array([0,0,1,1]).buffer)]); send(a,O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
      send(a,O.OP_COPY_TEX_SUB_IMAGE_2D,[face,0,0,0,0,0,1,1]); pixels.push(render(a));
      send(a,O.OP_CLEAR_COLOR,[...new Uint32Array(new Float32Array([1,0,0,1]).buffer)]); send(a,O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
      send(a,O.OP_COPY_TEX_IMAGE_2D,[face,0,gl.RGBA,0,0,1,1,0]); pixels.push(render(a));
      send(a,O.OP_BIND_TEXTURE,[target,30]); upload(a,[0,0,255,255]); send(a,O.OP_BIND_TEXTURE,[target,0]);
      pixels.push(render(a)); send(a,O.OP_ACTIVE_TEXTURE,[gl.TEXTURE0+1]); send(a,O.OP_BIND_TEXTURE,[target,30]); pixels.push(render(a));
      send(a,O.OP_DELETE_TEXTURES,[1,30]); pixels.push(render(a));
      const bindingName = new DataView(query(a,O.QOP_GET_INTEGERV,[cube ? gl.TEXTURE_BINDING_CUBE_MAP : gl.TEXTURE_BINDING_2D],4).buffer).getUint32(0,true);
      const predicate = query(a,O.QOP_IS_OBJECT,[1,0],12), isZero = new DataView(predicate.buffer).getUint32(4,true);
      send(a,O.OP_TEX_PARAMETERI,[target,0x813c,1]);
      const foreignParameter = [new DataView(query(a,O.QOP_GET_ERROR,[],4).buffer).getUint32(0,true),gl.getTexParameter(target,0x813c)];
      const afterParameter = parameter(a,gl.TEXTURE_MIN_FILTER), errors = [new DataView(query(a,O.QOP_GET_ERROR,[],4).buffer).getUint32(0,true),new DataView(query(b,O.QOP_GET_ERROR,[],4).buffer).getUint32(0,true)];
      const zeroB = b.shadow.defaultTextures.get(target)!; mux.invalidateCurrent(); reg.destroyContext(93,1);
      const retirement = [gl.isTexture(zeroA),gl.isTexture(zeroB)]; pixels.push(render(b));
      mux.invalidateCurrent(); reg.destroyContext(93,2); retirement.push(gl.isTexture(zeroB));
      return {defaults,pixels,bindingName,isZero,afterParameter,foreignParameter,errors,retirement};
    },{sourceRoot:root,cube});
    expect(result).toEqual({defaults:[0x2702,0x2601,0x2901,0x2901],pixels:[[255,0,0,255],[0,255,0,255],[255,0,0,255],[255,0,0,255],[255,255,0,255],[0,0,255,255],[255,0,0,255],[255,0,0,255],[0,0,255,255],[255,0,0,255],[0,255,0,255]],
      bindingName:0,isZero:0,afterParameter:0x2600,foreignParameter:[0x500,0],errors:[0,0],retirement:[false,true,false]});
  });
}

for (const forwarded of [false,true]) {
test(`actual C shader source upload crosses query chunks and renders after commit${forwarded ? " through main forwarding" : ""}`, async ({ page }) => {
  const root = fileURLToPath(new URL("../../../",import.meta.url)), temporary = mkdtempSync(join(root,".context/graphics-shader-trace-"));
  let frames: number[];
  try {
    const path = join(temporary,"protocol.bin");
    execFileSync("bash",[join(root,"tests/graphics/run-libc-unit.sh")],{
      cwd:root,env:{...process.env,KANDELO_GRAPHICS_LIBC_CASES:"encoder-shader-upload",KANDELO_GRAPHICS_PROTOCOL_TRACE:path},timeout:60000,stdio:"pipe",
    });
    frames = [...readFileSync(path)];
  } finally { rmSync(temporary,{recursive:true,force:true}); }
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async ({sourceRoot,frames,forwarded}) => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`,location.href).href;
    if (forwarded) {
      const { setupMainForward } = await import(base+"main-forward.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const expected = "precision mediump float; /*"+"X".repeat(140000)+"*/ void main(){gl_FragColor=vec4(0.,1.,1.,1.);}";
      const source = `
        import { createMainForwardChannel } from ${JSON.stringify(base+"main-forward.ts")};
        import * as O from ${JSON.stringify(base+"ops.ts")};
        let channel;
        onmessage = event => {
          try {
            if (event.data.retire) { channel.onDestroyContext(); channel.onUnbind(1); postMessage({type:"upload_retired"}); return; }
            channel = createMainForwardChannel({postMessage: message => postMessage(message)},94,1);
            if (channel.onCreateContext() || channel.onCreateSurface({surfaceId:1,kind:1,width:1,height:1,configId:1,targetBoId:0}).rc
                || channel.onMakeCurrent({drawSurfaceId:1,readSurfaceId:1,width:1,height:1})) throw new Error("forwarded creation failed");
            const memory = new WebAssembly.Memory({initial:2,maximum:2,shared:true}), scratch = new Uint8Array(memory.buffer);
            const data = new Uint8Array(event.data.frames), view = new DataView(data.buffer);
            let queries = 0, maximum = 0;
            for (let offset=0; offset<data.length;) {
              const kind = view.getUint32(offset,true), op = view.getUint32(offset+4,true), size = view.getUint32(offset+8,true), cap = view.getUint32(offset+12,true);
              offset += 16; scratch.set(data.subarray(offset,offset+size)); offset += size;
              if (kind === 1) channel.onSubmit(scratch.subarray(0,size));
              else {
                maximum = Math.max(maximum,size); queries++;
                const answer = channel.onQuery(op,scratch.subarray(0,size),cap), reply = new DataView(answer.bytes.buffer);
                if (answer.rc !== 12 || reply.getUint32(0,true) || reply.getUint32(4,true) !== new DataView(memory.buffer).getUint32(8,true) || reply.getUint32(8,true) !== 0x47514c33) throw new Error("forwarded upload failed");
              }
              scratch.fill(0);
            }
            const expected = ${JSON.stringify(expected)}, bytes = new Uint8Array(expected.length);
            for (let offset=0; offset<bytes.length; offset+=64000) {
              const count = Math.min(64000,bytes.length-offset); new Uint32Array(memory.buffer,0,3).set([2,offset,count]);
              const answer = channel.onQuery(O.QOP_GET_SHADER_SOURCE,scratch.subarray(0,12),count+12);
              if (answer.rc !== count+12 || new DataView(answer.bytes.buffer).getUint32(0,true)) throw new Error("forwarded source read failed");
              bytes.set(answer.bytes.subarray(8,8+count),offset);
            }
            new Uint32Array(memory.buffer,0,2).set([2,0x8b81]);
            const compiled = channel.onQuery(O.QOP_GET_SHADERIV,scratch.subarray(0,8),4);
            new Uint32Array(memory.buffer,0,6).set([0,0,1,1,0x1908,0x1401]);
            const pixels = channel.onQuery(O.QOP_READ_PIXELS,scratch.subarray(0,24),4), error = channel.onQuery(O.QOP_GET_ERROR,scratch.subarray(0,0),4);
            if (compiled.rc !== 4 || pixels.rc !== 4 || error.rc !== 4) throw new Error("forwarded final query failed");
            postMessage({type:"upload_done",result:{queries,maximum,sourceMatches:new TextDecoder().decode(bytes)===expected,compiled:!!new DataView(compiled.bytes.buffer).getUint32(0,true),pending:null,pixels:[...pixels.bytes],error:new DataView(error.bytes.buffer).getUint32(0,true)}});
          } catch (error) { postMessage({type:"upload_failed",error:String(error)}); }
        };
      `;
      const url = URL.createObjectURL(new Blob([source],{type:"text/javascript"})), worker = new Worker(url,{type:"module"});
      let mailboxes = 0, independent = true;
      worker.addEventListener("message",event => {
        const message = event.data;
        if (message?.mailbox) {
          const bytes = new Uint8Array(message.mailbox); if (bytes[bytes.length-1] !== 123) { mailboxes++; bytes[bytes.length-1] = 123; }
          independent &&= bytes.length === 65556;
        }
        if (message?.input) independent &&= !(message.input.buffer instanceof SharedArrayBuffer);
        if (message?.bytes) independent &&= !(message.bytes.buffer instanceof SharedArrayBuffer);
      });
      const dispose = setupMainForward(worker,canvas,94);
      const wait = (type: string) => new Promise<any>((resolve,reject) => {
        const cleanup = () => { clearTimeout(timeout); worker.removeEventListener("message",listener); worker.removeEventListener("error",failed); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error("forwarded upload timeout; mailboxes="+mailboxes)); },45000);
        const failed = (event: ErrorEvent) => { cleanup(); reject(new Error(event.message)); };
        const listener = (event: MessageEvent) => {
          if (event.data?.type === type || event.data?.type === "upload_failed") {
            cleanup();
            if (event.data.type === "upload_failed") reject(new Error(event.data.error)); else resolve(event.data.result);
          }
        }; worker.addEventListener("message",listener); worker.addEventListener("error",failed);
      });
      try {
        const done = wait("upload_done"); worker.postMessage({frames}); const result = await done;
        const gl = canvas.getContext("webgl2")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
        const fragment = gl.getAttachedShaders(program)!.find(shader => gl.getShaderParameter(shader,gl.SHADER_TYPE) === gl.FRAGMENT_SHADER)!;
        result.nativeMatches = gl.getShaderSource(fragment) === expected;
        const retired = wait("upload_retired"); worker.postMessage({retire:true}); await retired;
        result.retired = !gl.isShader(fragment); result.mailboxes = mailboxes; result.independent = independent; return result;
      } finally { dispose(); worker.terminate(); URL.revokeObjectURL(url); }
    }
    const { GlContextRegistry } = await import(base+"registry.ts"), { GlMuxer } = await import(base+"muxer.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts"), { runGlQuery } = await import(base+"query.ts"), O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2"); if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl); reg.bind({pid:94,sessionId:1,cmdbufAddr:0,cmdbufLen:1<<20});
    const b = reg.get(94,1)!; b.gl = gl; b.contextId = 1; b.cmdbufView = new Uint8Array(1<<20); mux.switchTo(b);
    const data = new Uint8Array(frames), view = new DataView(data.buffer);
    let queries = 0, maximum = 0;
    for (let offset=0; offset<data.length;) {
      const kind = view.getUint32(offset,true), op = view.getUint32(offset+4,true), length = view.getUint32(offset+8,true), cap = view.getUint32(offset+12,true);
      offset += 16; const input = data.slice(offset,offset+length); offset += length;
      if (kind === 1) { b.cmdbufView!.set(input); if (decodeAndDispatch(b,0,input.length)) throw new Error("C command failed"); }
      else if (kind === 2) {
        const out = new Uint8Array(cap); maximum = Math.max(maximum,length); queries++;
        if (runGlQuery(b,op,input,out) !== 12) throw new Error("C upload query transport failed");
        const reply = new DataView(out.buffer);
        if (reply.getUint32(0,true) || reply.getUint32(4,true) !== new DataView(input.buffer).getUint32(8,true) || reply.getUint32(8,true) !== 0x47514c33) throw new Error("C upload rejected");
      } else throw new Error("unknown C protocol trace frame");
    }
    const expected = "precision mediump float; /*"+"X".repeat(140000)+"*/ void main(){gl_FragColor=vec4(0.,1.,1.,1.);}";
    const bytes = new Uint8Array(expected.length);
    for (let offset=0; offset<bytes.length; offset+=65524) {
      const count = Math.min(65524,bytes.length-offset), input = new Uint8Array(new Uint32Array([2,offset,count]).buffer), out = new Uint8Array(count+12);
      if (runGlQuery(b,O.QOP_GET_SHADER_SOURCE,input,out) !== out.length || new DataView(out.buffer).getUint32(0,true)) throw new Error("source query failed");
      bytes.set(out.subarray(8,8+count),offset);
    }
    const pixels = new Uint8Array(4), read = new Uint8Array(new Uint32Array([0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE]).buffer);
    if (runGlQuery(b,O.QOP_READ_PIXELS,read,pixels) !== 4) throw new Error("readback failed");
    const error = new Uint8Array(4); runGlQuery(b,O.QOP_GET_ERROR,new Uint8Array(),error);
    const fragment = b.shaders.get(2)!;
    const result = {queries,maximum,sourceMatches:new TextDecoder().decode(bytes) === expected,nativeMatches:gl.getShaderSource(fragment) === expected,
      retired:false,mailboxes:0,independent:true,compiled:gl.getShaderParameter(fragment,gl.COMPILE_STATUS),pending:b.shaderUpload !== null,pixels:[...pixels],error:new DataView(error.buffer).getUint32(0,true)};
    mux.invalidateCurrent(); reg.destroyContext(94,1); result.retired = !gl.isShader(fragment); return result;
  },{sourceRoot:process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? root,frames,forwarded});
  expect(result).toEqual({queries:5,maximum:65536,sourceMatches:true,nativeMatches:true,retired:true,mailboxes:forwarded ? 1 : 0,independent:true,compiled:true,pending:forwarded ? null : false,pixels:[0,255,255,255],error:0});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
}

for (const width of [1,2]) {
  test(`maximum ${width*8}-bit VBO indices preserve strip topology and shared storage`, async ({ page }) => {
    await page.goto("/trap-signal-test.html");
    const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
    const result = await page.evaluate(async ({sourceRoot,width}) => {
      const base = `/@fs/${sourceRoot}host/src/webgl/`;
      const { GlContextRegistry } = await import(base+"registry.ts");
      const { GlMuxer } = await import(base+"muxer.ts");
      const { decodeAndDispatch } = await import(base+"bridge.ts");
      const { runGlQuery } = await import(base+"query.ts");
      const O = await import(base+"ops.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      document.body.replaceChildren(canvas);
      const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
      if (!gl) throw new Error("WebGL2 required");
      const buffers: WebGLBuffer[] = [], create = gl.createBuffer.bind(gl);
      gl.createBuffer = () => { const buffer = create(); if (buffer) buffers.push(buffer); return buffer; };
      const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
      const [a,b] = [101,102].map(sessionId => {
        reg.bind({pid:96,sessionId,cmdbufAddr:0,cmdbufLen:1024});
        const owner = reg.get(96,sessionId)!; owner.gl = gl; owner.contextId = sessionId;
        owner.cmdbufView = new Uint8Array(1024); return owner;
      });
      if (!reg.shareObjects(96,102,101)) throw new Error("group construction failed");
      const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
        mux.switchTo(owner); const view = new DataView(owner.cmdbufView!.buffer);
        view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
        words.forEach((word,i) => view.setUint32(4+i*4,word,true)); owner.cmdbufView!.set(tail,4+words.length*4);
        if (decodeAndDispatch(owner,0,4+words.length*4+tail.length)) throw new Error("command failed");
      };
      const query = (owner: typeof a, op: number, words: number[] = []) => {
        mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(4);
        words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
        if (runGlQuery(owner,op,input,out) !== 4) throw new Error("query failed"); return out;
      };
      const number = (owner: typeof a, op: number, words: number[] = []) => new DataView(query(owner,op,words).buffer).getUint32(0,true);
      for (const [name,type,text] of [
        [11,gl.VERTEX_SHADER,"attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}"],
        [12,gl.FRAGMENT_SHADER,"precision mediump float; void main(){gl_FragColor=vec4(0.,1.,1.,1.);}"]
      ] as [number,number,string][]) {
        send(a,O.OP_CREATE_SHADER,[type,name]); const textBytes = new TextEncoder().encode(text);
        send(a,O.OP_SHADER_SOURCE,[name,textBytes.length],textBytes); send(a,O.OP_COMPILE_SHADER,[name]);
      }
      send(a,O.OP_CREATE_PROGRAM,[13]); send(a,O.OP_ATTACH_SHADER,[13,11]); send(a,O.OP_ATTACH_SHADER,[13,12]);
      send(a,O.OP_BIND_ATTRIB_LOCATION,[13,0,8],new TextEncoder().encode("position")); send(a,O.OP_LINK_PROGRAM,[13]);
      const maximum = width === 1 ? 255 : 65535, type = width === 1 ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
      send(a,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(a,O.OP_BUFFER_DATA,[gl.ARRAY_BUFFER,(maximum+1)*8,gl.STATIC_DRAW]);
      for (const [index,x,y] of [[0,-1,-1],[maximum,3,-1],[1,-1,3]]) {
        const data = new Uint8Array(new Float32Array([x,y]).buffer);
        send(a,O.OP_BUFFER_SUB_DATA,[gl.ARRAY_BUFFER,index*8,data.length],data);
      }
      const indices = (maximumIndex: boolean) => {
        const bytes = new Uint8Array(width*4), view = new DataView(bytes.buffer);
        [123,0,maximumIndex ? maximum : 1,1].forEach((n,i) => width === 1 ? view.setUint8(i,n) : view.setUint16(i*2,n,true)); return bytes;
      };
      const allocate = (data: Uint8Array) => {
        send(a,O.OP_BUFFER_DATA,[gl.ELEMENT_ARRAY_BUFFER,data.length,gl.DYNAMIC_DRAW]);
        send(a,O.OP_BUFFER_SUB_DATA,[gl.ELEMENT_ARRAY_BUFFER,0,data.length],data);
      };
      send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,72]); allocate(indices(true));
      send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,0]);
      for (const owner of [a,b]) {
        send(owner,O.OP_USE_PROGRAM,[13]); send(owner,O.OP_VIEWPORT,[0,0,1,1]);
        send(owner,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(owner,O.OP_BIND_VERTEX_ARRAY,[31]);
        send(owner,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(owner,O.OP_VERTEX_ATTRIB_POINTER,[0,2,gl.FLOAT,0,0,0]);
        send(owner,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]); send(owner,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,72]);
      }
      const pixels: number[][] = [];
      const draw = (owner: typeof a) => {
        send(owner,O.OP_CLEAR_COLOR,[0,0,0,0x3f800000]); send(owner,O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
        send(owner,O.OP_DRAW_ELEMENTS,[gl.TRIANGLE_STRIP,3,type,width]);
        pixels.push([...query(owner,O.QOP_READ_PIXELS,[0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]);
      };
      draw(b);
      for (const maximumIndex of [false,true]) {
        const data = indices(maximumIndex); send(a,O.OP_BUFFER_SUB_DATA,[gl.ELEMENT_ARRAY_BUFFER,0,data.length],data); draw(b);
      }
      const old = a.buffers.get(72)!;
      send(a,O.OP_DELETE_BUFFERS,[1,72]); const retained = gl.isBuffer(old);
      send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,72]); allocate(indices(false)); const replacement = a.buffers.get(72)!;
      draw(a); draw(b);
      const oldName = number(b,O.QOP_GET_INTEGERV,[gl.ELEMENT_ARRAY_BUFFER_BINDING]);
      send(b,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,0]); const oldRetired = !gl.isBuffer(old);
      const errors = [number(a,O.QOP_GET_ERROR),number(b,O.QOP_GET_ERROR)];
      mux.invalidateCurrent(); reg.destroyContext(96,101); reg.destroyContext(96,102);
      return {pixels,retained,oldName,oldRetired,errors,replacementRetired:!gl.isBuffer(replacement),allBuffersRetired:buffers.every(buffer => !gl.isBuffer(buffer))};
    },{sourceRoot:root,width});
    expect(result).toEqual({pixels:[[0,255,255,255],[0,0,0,255],[0,255,255,255],[0,0,0,255],[0,255,255,255]],
      retained:true,oldName:72,oldRetired:true,errors:[0,0],replacementRetired:true,allBuffersRetired:true});
  });
}

for (const first of ["vertex", "index", "fixed"] as const) {
  test(`one GLES buffer shares vertex and index storage starting as ${first} data`, async ({ page }) => {
    await page.goto("/trap-signal-test.html");
    const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
    const result = await page.evaluate(async ({sourceRoot,first}) => {
      const base = `/@fs/${sourceRoot}host/src/webgl/`;
      const { GlContextRegistry } = await import(base+"registry.ts");
      const { GlMuxer } = await import(base+"muxer.ts");
      const { decodeAndDispatch } = await import(base+"bridge.ts");
      const { runGlQuery } = await import(base+"query.ts");
      const O = await import(base+"ops.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      document.body.replaceChildren(canvas);
      const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
      if (!gl) throw new Error("WebGL2 required");
      const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
      const [a,b] = [101,102].map(sessionId => {
        reg.bind({pid:94,sessionId,cmdbufAddr:0,cmdbufLen:1024});
        const owner = reg.get(94,sessionId)!;
        owner.gl = gl; owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(1024); return owner;
      });
      if (!reg.shareObjects(94,102,101)) throw new Error("group construction failed");
      const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
        mux.switchTo(owner); const view = new DataView(owner.cmdbufView!.buffer);
        view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
        words.forEach((word,i) => view.setUint32(4+i*4,word,true));
        owner.cmdbufView!.set(tail,4+words.length*4);
        if (decodeAndDispatch(owner,0,4+words.length*4+tail.length)) throw new Error("command failed");
      };
      const query = (owner: typeof a, op: number, words: number[] = []) => {
        mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(4);
        words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
        if (runGlQuery(owner,op,input,out) !== 4) throw new Error("query failed"); return out;
      };
      const number = (owner: typeof a, op: number, words: number[] = []) => new DataView(query(owner,op,words).buffer).getUint32(0,true);
      const update = (target: number, offset: number, data: number[]) => send(a,O.OP_BUFFER_SUB_DATA,[target,offset,data.length],new Uint8Array(data));
      const copies: number[] = [];
      const read = gl.getBufferSubData.bind(gl);
      gl.getBufferSubData = (target,offset,dst,dstOffset,length) => {
        copies.push(dst.byteLength); read(target,offset,dst,dstOffset,length);
      };
      const savedRead = gl.createBuffer(), savedWrite = gl.createBuffer();
      gl.bindBuffer(gl.COPY_READ_BUFFER,savedRead); gl.bindBuffer(gl.COPY_WRITE_BUFFER,savedWrite);
      for (const [name,type,text] of [
        [11,gl.VERTEX_SHADER,"attribute vec4 color; varying vec4 c; void main(){c=color;gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
        [12,gl.FRAGMENT_SHADER,"precision mediump float; varying vec4 c; void main(){gl_FragColor=c;}"]
      ] as [number,number,string][]) {
        send(a,O.OP_CREATE_SHADER,[type,name]); const bytes = new TextEncoder().encode(text);
        send(a,O.OP_SHADER_SOURCE,[name,bytes.length],bytes); send(a,O.OP_COMPILE_SHADER,[name]);
        if (number(a,O.QOP_GET_SHADERIV,[name,gl.COMPILE_STATUS]) !== 1) throw new Error("compile failed");
      }
      send(a,O.OP_CREATE_PROGRAM,[13]); send(a,O.OP_ATTACH_SHADER,[13,11]); send(a,O.OP_ATTACH_SHADER,[13,12]);
      send(a,O.OP_BIND_ATTRIB_LOCATION,[13,0,5],new TextEncoder().encode("color")); send(a,O.OP_LINK_PROGRAM,[13]);
      if (number(a,O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS]) !== 1) throw new Error("link failed");
      const fixed = first === "fixed", colorSize = fixed ? 16 : 4, colorStride = fixed ? 1024 : 4, length = 131072+colorStride+colorSize;
      const colors = (values: number[]) => {
        if (!fixed) return values;
        const bytes = new Uint8Array(values.length*4), view = new DataView(bytes.buffer);
        values.forEach((v,i) => view.setInt32(i*4,Math.round(v/255*65536),true)); return [...bytes];
      };
      const pointer = [0,4,fixed ? 0x140c : gl.UNSIGNED_BYTE,1,colorStride,131072];
      const firstTarget = first === "vertex" ? gl.ARRAY_BUFFER : gl.ELEMENT_ARRAY_BUFFER;
      send(a,O.OP_GEN_BUFFERS,[1,71]); send(a,O.OP_BIND_BUFFER,[firstTarget,71]);
      send(a,O.OP_BUFFER_DATA,[firstTarget,length,gl.DYNAMIC_DRAW]);
      update(firstTarget,0,[0,1]); update(firstTarget,131072,colors([0,255,0,255]));
      update(firstTarget,131072+colorStride,colors([0,0,255,255]));
      for (const owner of [a,b]) {
        send(owner,O.OP_USE_PROGRAM,[13]); send(owner,O.OP_VIEWPORT,[0,0,1,1]);
        send(owner,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(owner,O.OP_BIND_VERTEX_ARRAY,[31]);
        send(owner,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]);
        send(owner,O.OP_VERTEX_ATTRIB_POINTER,pointer); send(owner,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
        send(owner,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,71]);
      }
      const pixels: number[][] = [];
      const draw = (owner: typeof a) => {
        send(owner,O.OP_DRAW_ELEMENTS,[gl.POINTS,1,gl.UNSIGNED_BYTE,0]);
        pixels.push([...query(owner,O.QOP_READ_PIXELS,[0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]);
      };
      draw(b);
      const names = [number(a,O.QOP_GET_INTEGERV,[gl.ARRAY_BUFFER_BINDING]),number(a,O.QOP_GET_INTEGERV,[gl.ELEMENT_ARRAY_BUFFER_BINDING])];
      const vertexView = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer;
      const indexView = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer;
      const packedView = gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer;
      update(gl.ARRAY_BUFFER,0,[1]); draw(b);
      update(gl.ELEMENT_ARRAY_BUFFER,131072+colorStride,colors([255,0,0,255])); draw(b);
      send(a,O.OP_BUFFER_DATA,[gl.ELEMENT_ARRAY_BUFFER,length+4,gl.STATIC_DRAW]);
      update(gl.ELEMENT_ARRAY_BUFFER,131072,colors([255,255,0,255])); draw(b);
      send(b,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,0]);
      // The original default VAO may retain an index binding too.
      send(a,O.OP_BIND_VERTEX_ARRAY,[0]); send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,0]); send(a,O.OP_BIND_VERTEX_ARRAY,[31]);
      send(a,O.OP_DELETE_BUFFERS,[1,71]);
      const viewsRetained = [vertexView,indexView,packedView].every(view => gl.isBuffer(view));
      send(a,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]); send(a,O.OP_BUFFER_DATA,[gl.ARRAY_BUFFER,length,gl.STATIC_DRAW]);
      update(gl.ARRAY_BUFFER,131072,colors([255,0,255,255]));
      send(a,O.OP_VERTEX_ATTRIB_POINTER,pointer); send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,71]);
      draw(a);
      const replacementVertex = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer;
      const replacementIndex = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer;
      const replacementPacked = gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer;
      draw(b);
      send(b,O.OP_DELETE_VERTEX_ARRAYS,[1,31]);
      const viewsRetired = [vertexView,indexView,packedView].every(view => !gl.isBuffer(view));
      const copyBindingsPreserved = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) === savedRead && gl.getParameter(gl.COPY_WRITE_BUFFER_BINDING) === savedWrite;
      const errors = [number(a,O.QOP_GET_ERROR),number(b,O.QOP_GET_ERROR)];
      mux.invalidateCurrent(); reg.destroyContext(94,101); reg.destroyContext(94,102);
      const replacementRetired = [replacementVertex,replacementIndex,replacementPacked].every(view => !gl.isBuffer(view));
      gl.deleteBuffer(savedRead); gl.deleteBuffer(savedWrite);
      return {names,pixels,distinct:vertexView !== indexView,viewsRetained,viewsRetired,replacementRetired,copyBindingsPreserved,errors,
        copiesBounded:copies.length > 0 && Math.max(...copies) <= 65536 && copies.includes(65536)};
    },{sourceRoot:root,first});
    expect(result).toEqual({names:[71,71],pixels:[[0,255,0,255],[0,0,255,255],[255,0,0,255],[255,255,0,255],[255,0,255,255],[255,255,0,255]],
      distinct:true,viewsRetained:true,viewsRetired:true,replacementRetired:true,copyBindingsPreserved:true,errors:[0,0],copiesBounded:true});
  });
}

for (const kind of ["attribute", "element"] as const) {
  test(`deleted shared ${kind} buffers retain unbound VAO storage across name reuse`, async ({ page }) => {
    await page.goto("/trap-signal-test.html");
    const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
    const result = await page.evaluate(async ({sourceRoot,kind}) => {
      const base = `/@fs/${sourceRoot}host/src/webgl/`;
      const { GlContextRegistry } = await import(base+"registry.ts");
      const { GlMuxer } = await import(base+"muxer.ts");
      const { decodeAndDispatch } = await import(base+"bridge.ts");
      const { runGlQuery } = await import(base+"query.ts");
      const O = await import(base+"ops.ts");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      document.body.replaceChildren(canvas);
      const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
      if (!gl) throw new Error("WebGL2 required");
      const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
      const [a,b] = [101,102].map(sessionId => {
        reg.bind({pid:93,sessionId,cmdbufAddr:0,cmdbufLen:1024});
        const owner = reg.get(93,sessionId)!;
        owner.gl = gl; owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(1024); return owner;
      });
      if (!reg.shareObjects(93,102,101)) throw new Error("group construction failed");
      const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array()) => {
        mux.switchTo(owner); const view = new DataView(owner.cmdbufView!.buffer);
        view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
        words.forEach((word,i) => view.setUint32(4+i*4,word,true));
        owner.cmdbufView!.set(tail,4+words.length*4);
        if (decodeAndDispatch(owner,0,4+words.length*4+tail.length)) throw new Error("command failed");
      };
      const query = (owner: typeof a, op: number, words: number[] = []) => {
        mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(4);
        words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
        if (runGlQuery(owner,op,input,out) !== 4) throw new Error("query failed"); return out;
      };
      const number = (owner: typeof a, op: number, words: number[] = []) => new DataView(query(owner,op,words).buffer).getUint32(0,true);
      const upload = (target: number, data: Uint8Array) => {
        const tail = new Uint8Array(data.length+4); tail.set(data);
        new DataView(tail.buffer).setUint32(data.length,gl.STATIC_DRAW,true);
        send(a,O.OP_BUFFER_DATA,[target,data.length],tail);
      };
      for (const [name,type,text] of [
        [11,gl.VERTEX_SHADER,"attribute vec4 color; varying vec4 c; void main(){c=color;gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}"],
        [12,gl.FRAGMENT_SHADER,"precision mediump float; varying vec4 c; void main(){gl_FragColor=c;}"]
      ] as [number,number,string][]) {
        send(a,O.OP_CREATE_SHADER,[type,name]); const bytes = new TextEncoder().encode(text);
        send(a,O.OP_SHADER_SOURCE,[name,bytes.length],bytes); send(a,O.OP_COMPILE_SHADER,[name]);
        if (number(a,O.QOP_GET_SHADERIV,[name,gl.COMPILE_STATUS]) !== 1) throw new Error("compile failed");
      }
      send(a,O.OP_CREATE_PROGRAM,[13]); send(a,O.OP_ATTACH_SHADER,[13,11]); send(a,O.OP_ATTACH_SHADER,[13,12]);
      send(a,O.OP_BIND_ATTRIB_LOCATION,[13,0,5],new TextEncoder().encode("color"));
      send(a,O.OP_LINK_PROGRAM,[13]);
      if (number(a,O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS]) !== 1) throw new Error("link failed");
      send(a,O.OP_GEN_BUFFERS,[2,71,72]);
      send(a,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]);
      upload(gl.ARRAY_BUFFER,new Uint8Array([0,255,0,255,0,0,255,255]));
      send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,72]); upload(gl.ELEMENT_ARRAY_BUFFER,new Uint8Array([0]));
      for (const owner of [a,b]) {
        send(owner,O.OP_USE_PROGRAM,[13]); send(owner,O.OP_VIEWPORT,[0,0,1,1]);
        send(owner,O.OP_GEN_VERTEX_ARRAYS,[1,31]); send(owner,O.OP_BIND_VERTEX_ARRAY,[31]);
        send(owner,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,71]);
        send(owner,O.OP_VERTEX_ATTRIB_POINTER,[0,4,gl.UNSIGNED_BYTE,1,0,0]); send(owner,O.OP_ENABLE_VERTEX_ATTRIB_ARRAY,[0]);
        send(owner,O.OP_BIND_BUFFER,[gl.ARRAY_BUFFER,0]); send(owner,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,72]);
      }
      const name = kind === "attribute" ? 71 : 72;
      const old = a.buffers.get(name)!;
      send(b,O.OP_BIND_VERTEX_ARRAY,[0]);
      send(a,O.OP_DELETE_BUFFERS,[1,name]);
      const callerCleared = kind === "attribute"
        ? gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === null
        : gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === null;
      const retained = gl.isBuffer(old);
      const target = kind === "attribute" ? gl.ARRAY_BUFFER : gl.ELEMENT_ARRAY_BUFFER;
      send(a,O.OP_GEN_BUFFERS,[1,name]);
      send(a,O.OP_BIND_BUFFER,[target,name]);
      upload(target,kind === "attribute" ? new Uint8Array([0,0,255,255]) : new Uint8Array([1]));
      const replacement = a.buffers.get(name)!;
      if (kind === "attribute") send(a,O.OP_VERTEX_ATTRIB_POINTER,[0,4,gl.UNSIGNED_BYTE,1,0,0]);
      send(b,O.OP_BIND_VERTEX_ARRAY,[31]);
      const oldBinding = kind === "attribute"
        ? gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === old
        : number(b,O.QOP_GET_INTEGERV,[gl.ELEMENT_ARRAY_BUFFER_BINDING]) === name;
      const pixels: number[][] = [];
      for (const owner of [b,a]) {
        send(owner,O.OP_DRAW_ELEMENTS,[gl.POINTS,1,gl.UNSIGNED_BYTE,0]);
        pixels.push([...query(owner,O.QOP_READ_PIXELS,[0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]);
      }
      send(b,O.OP_DELETE_VERTEX_ARRAYS,[1,31]);
      const defaultRetains = kind === "element" && gl.isBuffer(old);
      if (kind === "element") {
        send(a,O.OP_BIND_VERTEX_ARRAY,[0]);
        if (number(a,O.QOP_GET_INTEGERV,[gl.ELEMENT_ARRAY_BUFFER_BINDING]) !== name) throw new Error("default VAO lost old object name");
        send(a,O.OP_BIND_BUFFER,[gl.ELEMENT_ARRAY_BUFFER,0]);
      }
      const oldRetired = !gl.isBuffer(old), errors = [number(a,O.QOP_GET_ERROR),number(b,O.QOP_GET_ERROR)];
      mux.invalidateCurrent(); reg.destroyContext(93,101);
      const peerRetains = gl.isBuffer(replacement);
      mux.invalidateCurrent(); reg.destroyContext(93,102);
      return {callerCleared,retained,oldBinding,pixels,oldRetired,errors,peerRetains,defaultRetains,retired:!gl.isBuffer(replacement)};
    },{sourceRoot:root,kind});
    expect(result).toEqual({callerCleared:true,retained:true,oldBinding:true,pixels:[[0,255,0,255],[0,0,255,255]],
      oldRetired:true,errors:[0,0],peerRetains:true,defaultRetains:kind === "element",retired:true});
  });
}

test("deleted shared renderbuffers retain bindings and unbound framebuffer storage", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
    if(!gl) throw new Error("WebGL2 is required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const [a,b] = [101,102].map(sessionId => {
      reg.bind({pid:92,sessionId,cmdbufAddr:0,cmdbufLen:1024});
      const owner = reg.get(92,sessionId)!;
      owner.gl = gl; owner.contextId = sessionId; owner.cmdbufView = new Uint8Array(1024); return owner;
    });
    if(!reg.shareObjects(92,102,101)) throw new Error("group construction failed");
    const send = (owner: typeof a, op: number, words: number[], floats = false) => {
      mux.switchTo(owner); const view = new DataView(owner.cmdbufView!.buffer);
      view.setUint16(0,op,true); view.setUint16(2,words.length*4,true);
      words.forEach((word,i) => floats ? view.setFloat32(4+i*4,word,true) : view.setUint32(4+i*4,word,true));
      if(decodeAndDispatch(owner,0,4+words.length*4)) throw new Error("command failed");
    };
    const query = (owner: typeof a, op: number, words: number[] = []) => {
      mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(4);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
      if(runGlQuery(owner,op,input,out) !== 4) throw new Error("query failed"); return out;
    };
    const number = (owner: typeof a, op: number, words: number[] = []) => new DataView(query(owner,op,words).buffer).getUint32(0,true);
    const attach = (owner: typeof a, name: number) => send(owner,O.OP_FRAMEBUFFER_RENDERBUFFER,[gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,name]);
    const pixels = (owner: typeof a) => [...query(owner,O.QOP_READ_PIXELS,[0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE])];
    send(a,O.OP_GEN_RENDERBUFFERS,[1,71]); send(a,O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,71]);
    send(a,O.OP_RENDERBUFFER_STORAGE,[gl.RENDERBUFFER,gl.RGBA4,1,1]); const old = a.rbos.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,31]); attach(a,71);
    send(a,O.OP_CLEAR_COLOR,[0,1,0,1],true); send(a,O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
    send(b,O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,71]);
    send(b,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,32]); attach(b,71);
    send(b,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,0]);
    send(a,O.OP_DELETE_RENDERBUFFERS,[1,71]);
    const ownerStatus = number(a,O.QOP_CHECK_FB_STATUS,[gl.FRAMEBUFFER]);
    const retained = gl.isRenderbuffer(old);
    send(a,O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,71]);
    send(a,O.OP_RENDERBUFFER_STORAGE,[gl.RENDERBUFFER,gl.RGBA4,1,1]); const replacement = a.rbos.get(71)!;
    send(a,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,33]); attach(a,71);
    send(a,O.OP_CLEAR_COLOR,[0,0,1,1],true); send(a,O.OP_CLEAR,[gl.COLOR_BUFFER_BIT]);
    send(b,O.OP_BIND_FRAMEBUFFER,[gl.FRAMEBUFFER,32]);
    const oldPixels = pixels(b), oldName = number(b,O.QOP_GET_INTEGERV,[gl.RENDERBUFFER_BINDING]);
    attach(b,0); const bindingStillRetains = gl.isRenderbuffer(old);
    send(b,O.OP_BIND_RENDERBUFFER,[gl.RENDERBUFFER,0]); const oldRetired = !gl.isRenderbuffer(old);
    const newPixels = pixels(a), errors = [number(a,O.QOP_GET_ERROR),number(b,O.QOP_GET_ERROR)];
    mux.invalidateCurrent(); reg.destroyContext(92,101);
    const groupRetainsNew = gl.isRenderbuffer(replacement);
    mux.invalidateCurrent(); reg.destroyContext(92,102);
    return {ownerStatus,retained,oldPixels,oldName,bindingStillRetains,oldRetired,newPixels,errors,groupRetainsNew,newRetired:!gl.isRenderbuffer(replacement)};
  },root);
  expect(result).toEqual({ownerStatus:0x8cd7,retained:true,oldPixels:[0,255,0,255],oldName:71,
    bindingStillRetains:true,oldRetired:true,newPixels:[0,0,255,255],errors:[0,0],groupRetainsNew:true,newRetired:true});
});

test("internal object groups share textures and programs while context state and retirement stay separate", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const { applyCurrentDrawable } = await import(base+"current.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 4;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2",{antialias:false,preserveDrawingBuffer:true});
    if (!gl) throw new Error("WebGL2 is required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const bindings = [101,102].map(sessionId => {
      reg.bind({pid:91,sessionId,cmdbufAddr:0,cmdbufLen:1024});
      const b = reg.get(91,sessionId)!; b.contextId = sessionId; b.gl = gl; b.cmdbufView = new Uint8Array(1024);
      return b;
    });
    const [a,b] = bindings;
    const send = (owner: typeof a, op: number, words: number[], tail = new Uint8Array(), floats = false) => {
      mux.switchTo(owner);
      const bytes = owner.cmdbufView!, view = new DataView(bytes.buffer);
      view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
      words.forEach((word,i) => floats ? view.setFloat32(4+i*4,word,true) : view.setUint32(4+i*4,word,true));
      bytes.set(tail,4+words.length*4);
      const rc = decodeAndDispatch(owner,0,4+words.length*4+tail.length); if(rc) throw new Error(`command ${op}: ${rc}`);
    };
    const query = (owner: typeof a, op: number, words: number[], size = 4) => {
      mux.switchTo(owner); const input = new Uint8Array(words.length*4), out = new Uint8Array(size);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
      const rc = runGlQuery(owner,op,input,out); if(rc !== size) throw new Error(`query ${op}: ${rc}`);
      return out;
    };
    const number = (owner: typeof a, op: number, words: number[] = []) =>
      new DataView(query(owner,op,words).buffer).getUint32(0,true);
    for (const [name,type,text] of [
      [11,gl.VERTEX_SHADER,"void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=4.;}"],
      [12,gl.FRAGMENT_SHADER,"precision mediump float;uniform sampler2D image;uniform float alpha;void main(){gl_FragColor=texture2D(image,vec2(.5))*alpha;}"]
    ] as [number,number,string][]) {
      send(a,O.OP_CREATE_SHADER,[type,name]); const textBytes = new TextEncoder().encode(text);
      send(a,O.OP_SHADER_SOURCE,[name,textBytes.length],textBytes); send(a,O.OP_COMPILE_SHADER,[name]);
      if(number(a,O.QOP_GET_SHADERIV,[name,gl.COMPILE_STATUS]) !== 1) throw new Error("shader failed");
    }
    send(a,O.OP_CREATE_PROGRAM,[13]); send(a,O.OP_ATTACH_SHADER,[13,11]); send(a,O.OP_ATTACH_SHADER,[13,12]);
    send(a,O.OP_LINK_PROGRAM,[13]); if(number(a,O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS]) !== 1) throw new Error("link failed");
    send(a,O.OP_GEN_TEXTURES,[1,1]); send(a,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,1]);
    send(a,O.OP_TEX_PARAMETERI,[gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST]);
    send(a,O.OP_TEX_PARAMETERI,[gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST]);
    send(a,O.OP_TEX_IMAGE_2D,[gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,4],new Uint8Array([255,0,0,255]));
    if(!reg.shareObjects(91,102,101)) throw new Error("object group construction failed");
    bindings.forEach(owner => { mux.invalidateCurrent(); applyCurrentDrawable(owner,{drawSurfaceId:1,readSurfaceId:1,width:4,height:4}); });
    const initialPeerProgram = number(b,O.QOP_GET_INTEGERV,[gl.CURRENT_PROGRAM]);
    send(a,O.OP_USE_PROGRAM,[13]); send(b,O.OP_USE_PROGRAM,[13]);
    send(b,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,1]);
    send(b,O.OP_TEX_SUB_IMAGE_2D,[gl.TEXTURE_2D,0,0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,4],new Uint8Array([0,255,0,255]));
    const name = new TextEncoder().encode("alpha");
    // Query names have a byte tail, so supply this one directly.
    const input = new Uint8Array(8+name.length), output = new Uint8Array(4);
    new DataView(input.buffer).setUint32(0,13,true); new DataView(input.buffer).setUint32(4,name.length,true); input.set(name,8);
    if(runGlQuery(b,O.QOP_GET_UNIFORM_LOC,input,output) !== 4) throw new Error("uniform location failed");
    const alpha = new DataView(output.buffer).getUint32(0,true);
    const uniformBytes = new Uint8Array(12), uniformView = new DataView(uniformBytes.buffer);
    uniformView.setUint16(0,O.OP_UNIFORM1F,true); uniformView.setUint16(2,8,true);
    uniformView.setUint32(4,alpha,true); uniformView.setFloat32(8,1,true);
    b.cmdbufView!.set(uniformBytes); if(decodeAndDispatch(b,0,12)) throw new Error("uniform failed");
    const sharedUniform = new DataView(query(a,O.QOP_GET_UNIFORMFV,[13,alpha]).buffer).getFloat32(0,true);
    send(a,O.OP_VIEWPORT,[0,0,4,4]); send(b,O.OP_VIEWPORT,[0,0,2,2]);
    const pixels: number[][] = [];
    for(const owner of [a,b,a]) { send(owner,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]); pixels.push([...query(owner,O.QOP_READ_PIXELS,[1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]); }
    const deletedTexture = a.textures.get(1)!;
    send(a,O.OP_DELETE_TEXTURES,[1,1]);
    const retainedDeletedBinding = gl.isTexture(deletedTexture);
    const deletedBoundName = number(b,O.QOP_GET_INTEGERV,[gl.TEXTURE_BINDING_2D]);
    send(a,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,1]);
    send(a,O.OP_TEX_PARAMETERI,[gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST]);
    send(a,O.OP_TEX_PARAMETERI,[gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST]);
    send(a,O.OP_TEX_IMAGE_2D,[gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,4],new Uint8Array([0,0,255,255]));
    for(const owner of [b,a]) { send(owner,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]); pixels.push([...query(owner,O.QOP_READ_PIXELS,[1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]); }
    send(b,O.OP_BIND_TEXTURE,[gl.TEXTURE_2D,1]);
    send(b,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]); pixels.push([...query(b,O.QOP_READ_PIXELS,[1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]);
    const retiredDeletedTexture = !gl.isTexture(deletedTexture);
    const texture = a.textures.get(1)!, program = a.programs.get(13)!;
    send(a,O.OP_DELETE_PROGRAM,[13]); send(a,O.OP_USE_PROGRAM,[0]);
    mux.invalidateCurrent(); reg.destroyContext(91,101);
    const survived = gl.isTexture(texture) && gl.isProgram(program);
    send(b,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]); pixels.push([...query(b,O.QOP_READ_PIXELS,[1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE])]);
    const peerViewport = [...b.shadow.viewport], errors = number(b,O.QOP_GET_ERROR);
    send(b,O.OP_USE_PROGRAM,[0]); mux.invalidateCurrent(); reg.destroyContext(91,102);
    return {initialPeerProgram,sharedUniform,pixels,peerViewport,survived,retired:!gl.isTexture(texture)&&!gl.isProgram(program),errors,
      retainedDeletedBinding,deletedBoundName,retiredDeletedTexture};
  },root);
  expect(result).toEqual({initialPeerProgram:0,sharedUniform:1,
    pixels:[...Array(4).fill([0,255,0,255]),...Array(3).fill([0,0,255,255])],peerViewport:[0,0,2,2],survived:true,retired:true,errors:0,
    retainedDeletedBinding:true,deletedBoundName:1,retiredDeletedTexture:true});
});

test("surfaceless framebuffer zero rejects rendering while user framebuffers remain usable", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`, location.href).href;
    const { setupMainForward } = await import(base + "main-forward.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true })!;
    if (!gl) throw new Error("WebGL2 is required");
    gl.clearColor(0,0,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
    const source = `
      import { createMainForwardChannel } from ${JSON.stringify(base + "main-forward.ts")};
      import * as O from ${JSON.stringify(base + "ops.ts")};
      onmessage = () => {
        try {
          const c = createMainForwardChannel({ postMessage: m => postMessage(m) }, 81, 101);
          if (c.onCreateContext() !== 0 || c.onMakeCurrent({drawSurfaceId:0,readSurfaceId:0,width:0,height:0}) !== 0)
            throw new Error("surfaceless bind failed");
          const send = (op, words, tail = new Uint8Array(), float = false) => {
            const bytes = new Uint8Array(4+words.length*4+tail.length), v = new DataView(bytes.buffer);
            v.setUint16(0,op,true); v.setUint16(2,bytes.length-4,true);
            words.forEach((word,i) => float ? v.setFloat32(4+i*4,word,true) : v.setUint32(4+i*4,word,true));
            bytes.set(tail,4+words.length*4); c.onSubmit(bytes);
          };
          const query = (op, words = [], size = 4) => {
            const bytes = new Uint8Array(words.length*4), v = new DataView(bytes.buffer);
            words.forEach((word,i) => v.setUint32(i*4,word,true));
            return c.onQuery(op,bytes,size);
          };
          const number = (op,words = []) => {
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
            [12,0x8b30,"precision mediump float;void main(){gl_FragColor=vec4(0.,1.,0.,1.);}"]]) {
            send(O.OP_CREATE_SHADER,[type,name]);
            const bytes = new TextEncoder().encode(text); send(O.OP_SHADER_SOURCE,[name,bytes.length],bytes);
            send(O.OP_COMPILE_SHADER,[name]);
            if (number(O.QOP_GET_SHADERIV,[name,0x8b81]) !== 1) throw new Error("shader failed");
          }
          send(O.OP_CREATE_PROGRAM,[13]); send(O.OP_ATTACH_SHADER,[13,11]); send(O.OP_ATTACH_SHADER,[13,12]);
          send(O.OP_LINK_PROGRAM,[13]); if(number(O.QOP_GET_PROGRAMIV,[13,0x8b82]) !== 1) throw new Error("link failed");
          send(O.OP_USE_PROGRAM,[13]); send(O.OP_VIEWPORT,[0,0,1,1]);
          send(O.OP_GEN_TEXTURES,[2,7,8]); send(O.OP_BIND_TEXTURE,[0x0de1,7]);
          send(O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,4],new Uint8Array([255,0,0,255]));
          send(O.OP_GEN_BUFFERS,[1,5]); send(O.OP_BIND_BUFFER,[0x8893,5]);
          send(O.OP_BUFFER_DATA,[0x8893,2,0x88e4]);
          const setupError = error(), errors = [];
          for (const [op,words] of [
            [O.OP_CLEAR,[0x4000]], [O.OP_DRAW_ARRAYS,[0,0,1]], [O.OP_DRAW_ELEMENTS,[0,1,0x1403,0]],
            [O.OP_COPY_TEX_IMAGE_2D,[0x0de1,0,0x1908,0,0,1,1,0]],
            [O.OP_COPY_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,0,0,1,1]]]) {
            send(op,words); errors.push(error());
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
          send(O.OP_BIND_FRAMEBUFFER,[0x8ca9,0]);
          const splitPixels = query(O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401]);
          const split = {draw:status(),read:number(O.QOP_CHECK_FB_STATUS,[0x8ca8]),
            drawName:number(O.QOP_GET_INTEGERV,[0x8ca6]),readName:number(O.QOP_GET_INTEGERV,[0x8caa]),
            pixels:[...splitPixels.bytes],error:error()};
          send(O.OP_CLEAR,[0x4000]); split.clearError = error();
          send(O.OP_BIND_FRAMEBUFFER,[0x8d40,4]);
          send(O.OP_DELETE_FRAMEBUFFERS,[1,4]); const deletedStatus = status();
          send(O.OP_CLEAR,[0x4000]); const deletedError = error();
          c.onDestroyContext();
          postMessage({type:"surface_done",results:{initialStatus,viewport,setupError,errors,
            readRc:read.rc,readBytes:[...read.bytes],attachmentError,statusAfterAttachment,
            copiedTextureRc:copiedTexture.rc,copiedTexture:[...copiedTexture.bytes],
            userStatus,userPixels:[...userPixels.bytes],userError,split,deletedStatus,deletedError}});
        } catch(error) { postMessage({type:"surface_failed",error:String(error)}); }
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" }); const dispose = setupMainForward(worker,canvas,81);
    try {
      const results = await new Promise<Record<string, unknown>>((resolve,reject) => {
        const timeout = setTimeout(() => reject(new Error("surfaceless test timed out")),45_000);
        worker.addEventListener("error", event => { clearTimeout(timeout); reject(new Error(event.message)); });
        worker.addEventListener("message",({data}) => {
          if(data.type === "surface_done") { clearTimeout(timeout); resolve(data.results); }
          if(data.type === "surface_failed") { clearTimeout(timeout); reject(new Error(data.error)); }
        }); worker.postMessage({type:"start"});
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      const canvasPixels = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,canvasPixels);
      return {...results,canvasPixels:[...canvasPixels]};
    } finally { dispose(); worker.terminate(); URL.revokeObjectURL(url); }
  },root);
  expect(result).toEqual({initialStatus:0x8219,viewport:[0,0,0,0],setupError:0,
    errors:Array(6).fill(0x506),readRc:-22,readBytes:[],attachmentError:0x502,statusAfterAttachment:0x8219,
    copiedTextureRc:4,copiedTexture:[255,0,0,255],userStatus:0x8cd5,userPixels:[0,255,0,255],userError:0,
    split:{draw:0x8219,read:0x8cd5,drawName:0,readName:4,pixels:[0,255,0,255],error:0,clearError:0x506},
    deletedStatus:0x8219,deletedError:0x506,canvasPixels:[0,0,255,255]});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("forwarded native errors stay with their owner across switches and invalidation", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const results = await page.evaluate(async sourceRoot => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`, location.href).href;
    const { setupMainForward } = await import(base + "main-forward.ts");
    const canvas = document.createElement("canvas");
    document.body.replaceChildren(canvas);
    const source = `
      import { createMainForwardChannel } from ${JSON.stringify(base + "main-forward.ts")};
      import * as O from ${JSON.stringify(base + "ops.ts")};
      onmessage = () => {
        try {
          const channels = [101,102].map(session => createMainForwardChannel(
            { postMessage: message => postMessage(message) }, 71, session));
          const drawables = [101,102].map(id => ({drawSurfaceId:id,readSurfaceId:id,width:1,height:1}));
          for (const [index,channel] of channels.entries()) {
            if (channel.onCreateContext() !== 0
                || channel.onCreateSurface({surfaceId:101+index,kind:1,width:1,height:1,configId:1,targetBoId:0}).rc !== 0
                || channel.onMakeCurrent(drawables[index]) !== 0)
              throw new Error("failed to bind renderer");
          }
          const invalid = new Uint8Array(16), v = new DataView(invalid.buffer);
          v.setUint16(0, O.OP_TEX_PARAMETERI, true); v.setUint16(2, 12, true);
          v.setUint32(4, 0xdead, true); // invalid native texture target
          v.setUint32(8, 0x2801, true); v.setUint32(12, 0x2600, true);
          const error = channel => {
            const reply = channel.onQuery(O.QOP_GET_ERROR, new Uint8Array(), 4);
            if (reply.rc !== 4) throw new Error("error query failed: " + reply.rc);
            return new DataView(reply.bytes.buffer).getUint32(0, true);
          };
          const results = [];
          for (const invalidate of [false,true]) {
            channels[0].onSubmit(invalid);
            if (invalidate && channels[1].onMakeCurrent(drawables[1]) !== 0)
              throw new Error("replacement bind failed");
            results.push([error(channels[1]), error(channels[0]), error(channels[0])]);
          }
          channels.forEach(channel => channel.onDestroyContext());
          postMessage({ type: "errors_done", results });
        } catch (error) { postMessage({ type: "errors_failed", error: String(error) }); }
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const dispose = setupMainForward(worker, canvas, 71);
    try {
      return await new Promise<number[][]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("error isolation timed out")), 45_000);
        worker.addEventListener("error", event => { clearTimeout(timeout); reject(new Error(event.message)); });
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "errors_done") { clearTimeout(timeout); resolve(data.results); }
          if (data.type === "errors_failed") { clearTimeout(timeout); reject(new Error(data.error)); }
        });
        worker.postMessage({ type: "start" });
      });
    } finally { dispose(); worker.terminate(); URL.revokeObjectURL(url); }
  }, root);
  expect(results).toEqual([[0,0x500,0],[0,0x500,0]]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("GLES texture targets and pixel-store state survive alternating contexts", async ({ page }) => {
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT
    ?? fileURLToPath(new URL("../../../", import.meta.url));
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async (sourceRoot) => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base + "registry.ts");
    const { GlMuxer } = await import(base + "muxer.ts");
    const { decodeAndDispatch } = await import(base + "bridge.ts");
    const { runGlQuery } = await import(base + "query.ts");
    const ops = await import(base + "ops.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is required by this rendered contract test");
    const shader = (type: number, source: string) => {
      const object = gl.createShader(type)!;
      gl.shaderSource(object, source); gl.compileShader(object);
      if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(object)!);
      return object;
    };
    const vertex = shader(gl.VERTEX_SHADER, "attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}");
    const fragment = shader(gl.FRAGMENT_SHADER, `precision mediump float;
      uniform sampler2D image2d; uniform samplerCube imageCube;
      void main(){gl_FragColor=vec4(texture2D(image2d,vec2(.5)).rgb+
        textureCube(imageCube,vec3(1.,0.,0.)).rgb,1.);}`);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex); gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "p"); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)!);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "image2d"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "imageCube"), 1);
    const vertices = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    const registry = new GlContextRegistry();
    const muxer = new GlMuxer(gl);
    const bindings = [1,2].map(pid => {
      registry.bind({ pid, cmdbufAddr: 0, cmdbufLen: 4096 });
      const b = registry.get(pid)!;
      b.gl = gl; b.cmdbufView = new Uint8Array(4096);
      b.buffers.set(1, vertices); b.programs.set(1, program);
      b.shadow.viewport = [0,0,16,16];
      b.shadow.scissor.rect = [0,0,16,16];
      return b;
    });
    const send = (binding: typeof bindings[0], op: number, words: number[], floats = false, bytes?: number[]) => {
      const memory = binding.cmdbufView!;
      const view = new DataView(memory.buffer);
      const size = words.length * 4 + (bytes?.length ?? 0);
      view.setUint16(0, op, true); view.setUint16(2, size, true);
      words.forEach((word, i) => floats ? view.setFloat32(4+i*4, word, true) : view.setUint32(4+i*4, word, true));
      if (bytes) memory.set(bytes, 4 + words.length*4);
      muxer.switchTo(binding);
      const rc = decodeAndDispatch(binding, 0, size+4);
      if (rc) throw new Error(`GL decode ${op}: ${rc}`);
    };
    const bind = (b: typeof bindings[0], target: number, name: number, unit: number) => {
      send(b, ops.OP_ACTIVE_TEXTURE, [gl.TEXTURE0+unit]);
      send(b, ops.OP_BIND_TEXTURE, [target,name]);
    };
    const configure = (b: typeof bindings[0], color2d: number[], colorCube: number[]) => {
      send(b, ops.OP_GEN_TEXTURES, [2,1,2]);
      for (const [target, name, unit, color] of [
        [gl.TEXTURE_2D,1,0,color2d], [gl.TEXTURE_CUBE_MAP,2,1,colorCube],
      ] as [number,number,number,number[]][]) {
        bind(b,target,name,unit);
        send(b, ops.OP_TEX_PARAMETERI, [target,gl.TEXTURE_MIN_FILTER,gl.NEAREST]);
        send(b, ops.OP_TEX_PARAMETERI, [target,gl.TEXTURE_MAG_FILTER,gl.NEAREST]);
        const faces = target === gl.TEXTURE_2D ? [target]
          : Array.from({length:6}, (_,i) => gl.TEXTURE_CUBE_MAP_POSITIVE_X+i);
        for (const face of faces) send(b, ops.OP_TEX_IMAGE_2D,
          [face,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,4], false, color);
      }
      send(b, ops.OP_USE_PROGRAM, [1]);
      send(b, ops.OP_BIND_BUFFER, [gl.ARRAY_BUFFER,1]);
      send(b, ops.OP_VERTEX_ATTRIB_POINTER, [0,2,gl.FLOAT,0,0,0]);
      send(b, ops.OP_ENABLE_VERTEX_ATTRIB_ARRAY, [0]);
    };
    configure(bindings[0], [255,0,0,255], [0,255,0,255]);
    configure(bindings[1], [0,0,255,255], [255,0,0,255]);
    send(bindings[0], ops.OP_DISABLE, [gl.DITHER]);
    send(bindings[0], ops.OP_PIXEL_STOREI, [gl.UNPACK_ROW_LENGTH,7]);
    send(bindings[0], ops.OP_PIXEL_STOREI, [gl.UNPACK_SKIP_ROWS,2]);
    send(bindings[0], ops.OP_PIXEL_STOREI, [gl.UNPACK_SKIP_PIXELS,1]);
    const observations = [];
    const nameQueries: number[][] = [];
    const objectQuery = (b: typeof bindings[0], pname: number, float = false) => {
      const request = new Uint8Array(4), reply = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, pname, true);
      const count = runGlQuery(b, float ? ops.QOP_GET_FLOATV : ops.QOP_GET_INTEGERV, request, reply);
      if (count !== 4) throw new Error(`object query failed: ${count}`);
      return float ? new DataView(reply.buffer).getFloat32(0, true)
        : new DataView(reply.buffer).getInt32(0, true);
    };
    for (const index of [0,1,0,1,0,1]) {
      const b = bindings[index];
      send(b, ops.OP_DRAW_ARRAYS, [gl.TRIANGLES,0,3]);
      const pixels = new Uint8Array(4);
      gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      send(b, ops.OP_ACTIVE_TEXTURE, [gl.TEXTURE0]);
      const texture2d = objectQuery(b, gl.TEXTURE_BINDING_2D);
      send(b, ops.OP_ACTIVE_TEXTURE, [gl.TEXTURE1]);
      nameQueries.push([texture2d, objectQuery(b, gl.TEXTURE_BINDING_CUBE_MAP, true),
        objectQuery(b, gl.CURRENT_PROGRAM, true), objectQuery(b, gl.ARRAY_BUFFER_BINDING)]);
      observations.push({ index, rgba: [...pixels], dither: gl.isEnabled(gl.DITHER),
        rowLength: gl.getParameter(gl.UNPACK_ROW_LENGTH),
        skipRows: gl.getParameter(gl.UNPACK_SKIP_ROWS),
        skipPixels: gl.getParameter(gl.UNPACK_SKIP_PIXELS), error: gl.getError() });
    }
    const { bindForeignTexture } = await import(base + "foreign-texture.ts");
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 5);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 2);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 3);
    const physicalState = () => [gl.getParameter(gl.ACTIVE_TEXTURE),
      gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.UNPACK_ALIGNMENT),
      gl.getParameter(gl.UNPACK_ROW_LENGTH), gl.getParameter(gl.UNPACK_SKIP_ROWS),
      gl.getParameter(gl.UNPACK_SKIP_PIXELS)];
    const before = physicalState();
    bindings[0].shadow.unpackAlignment = 1;
    const imported = bindForeignTexture(bindings[0], 50, new Uint8Array([17,29,41,255]),
      { w: 1, h: 1, stride: 4 });
    const after = physicalState();
    const physicalStatePreserved = before.every((value,i) => value === after[i]);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      bindings[0].textures.get(imported) ?? null, 0);
    const importedPixels = new Uint8Array(4);
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,importedPixels);
    const importError = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.deleteFramebuffer(fb);
    registry.dropForeignTexturesForBo(50);
    // These objects belong to this short-lived test realm.
    gl.deleteBuffer(vertices); gl.deleteProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    return { observations, nameQueries, physicalStatePreserved, importedPixels: [...importedPixels], importError };
  }, root);
  expect(result.physicalStatePreserved).toBe(true);
  expect(result.importedPixels).toEqual([17,29,41,255]);
  expect(result.importError).toBe(0);
  expect(result.nameQueries).toEqual(Array(6).fill([1,2,1,1]));
  for (const observation of result.observations) {
    const first = observation.index === 0;
    expect(observation).toEqual({ index: observation.index,
      rgba: first ? [255,255,0,255] : [255,0,255,255], dither: !first,
      rowLength: first ? 7 : 0, skipRows: first ? 2 : 0,
      skipPixels: first ? 1 : 0, error: 0 });
  }
});

for (const sameProcess of [false, true]) {
test(`forwarded synchronous queries isolate ${sameProcess ? "sessions in one process" : "processes"} with one mailbox per channel`, async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async ({ sourceRoot, sameProcess }) => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`, location.href).href;
    const { setupMainForward } = await import(base + "main-forward.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    document.body.replaceChildren(canvas);
    const source = `
      import { createMainForwardChannel } from ${JSON.stringify(base + "main-forward.ts")};
      import * as O from ${JSON.stringify(base + "ops.ts")};
      onmessage = () => {
        try {
          const channels = [73,74].map((pid,index) => createMainForwardChannel(
            { postMessage: message => postMessage(message) },
            ${sameProcess ? 73 : "pid"}, ${sameProcess ? "index + 201" : 0}));
          const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
          const bytes = new Uint8Array(memory.buffer);
          const view = new DataView(memory.buffer);
          const results = [];
          for (let round = 0; round < 3; round++) {
            channels.forEach((channel,index) => {
              if (channel.onCreateContext() !== 0) throw new Error("renderer did not acknowledge context creation");
              if (round === 0 && channel.onCreateSurface({surfaceId:index+1,kind:1,width:8,height:8,configId:1,targetBoId:0}).rc !== 0)
                throw new Error("surface creation failed");
              if (channel.onMakeCurrent({ drawSurfaceId: index+1, readSurfaceId: index+1, width: 8, height: 8 }) !== 0)
                throw new Error("renderer did not acknowledge current drawable");
              view.setUint16(0, O.OP_CLEAR_COLOR, true); view.setUint16(2, 16, true);
              [index, 1-index, 0, 1].forEach((v,j) => view.setFloat32(4+4*j,v,true));
              channel.onSubmit(bytes.subarray(0,20));
            });
            for (const channel of channels) {
              // No color command here: the selected owner's prior state must
              // be restored for both drawing and synchronous queries.
              view.setUint16(0, O.OP_CLEAR, true); view.setUint16(2, 4, true);
              view.setUint32(4, 0x4000, true);
              channel.onSubmit(bytes.subarray(0,8));
              view.setUint32(0, 0x0c22, true);
              const state = channel.onQuery(O.QOP_GET_FLOATV, bytes.subarray(0,4), 16);
              [0,0,1,1,0x1908,0x1401].forEach((v,j) => view.setUint32(j*4,v,true));
              const pixels = channel.onQuery(O.QOP_READ_PIXELS, bytes.subarray(0,24), 4);
              const error = channel.onQuery(O.QOP_GET_ERROR, bytes.subarray(0,0), 4);
              results.push({ stateRc: state.rc, state: [...new Float32Array(state.bytes.buffer)],
                pixelsRc: pixels.rc, pixels: [...pixels.bytes],
                errorRc: error.rc, error: [...error.bytes] });
            }
            channels.forEach(channel => channel.onDestroyContext());
          }
          postMessage({ type: "contract_done", results });
        } catch (error) { postMessage({ type: "contract_failed", error: String(error) }); }
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const dispose = (sameProcess ? [73] : [73,74]).map(pid => setupMainForward(worker, canvas, pid));
    // Structured clone produces distinct SAB wrappers over the same storage.
    // Use an unused payload byte to observe backing reuse across messages.
    let mailboxCount = 0;
    const mailboxSizes: number[] = [];
    let independent = true;
    try {
      const results = await new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("forwarded query did not complete")), 45_000);
        worker.addEventListener("error", event => { clearTimeout(timeout); reject(new Error(event.message)); });
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "gl_forward_query") {
            const bytes = new Uint8Array(data.mailbox);
            if (bytes[bytes.length - 1] !== 0x5a) {
              mailboxCount++;
              mailboxSizes.push(bytes.length);
              bytes[bytes.length - 1] = 0x5a;
            }
            independent &&= data.input.buffer instanceof ArrayBuffer;
          } else if (data.type === "gl_forward_submit") {
            independent &&= data.bytes.buffer instanceof ArrayBuffer;
          } else if (data.type === "contract_done") {
            clearTimeout(timeout); resolve(data.results);
          } else if (data.type === "contract_failed") {
            clearTimeout(timeout); reject(new Error(data.error));
          }
        });
        worker.postMessage({ start: true });
      });
      return { results, independent, mailboxes: mailboxCount, mailboxSizes };
    } finally {
      worker.terminate(); dispose.forEach(close => close()); URL.revokeObjectURL(url);
    }
  }, { sourceRoot: root, sameProcess });
  expect(result.independent).toBe(true);
  expect(result.mailboxes).toBe(2);
  expect(result.mailboxSizes[0]).toBeLessThan(66_000);
  expect(result.results).toHaveLength(6);
  result.results.forEach((value, index) => {
    expect(value).toEqual({ stateRc: 16, state: [index % 2, 1 - index % 2, 0, 1],
      pixelsRc: 4, pixels: index % 2 ? [255,0,0,255] : [0,255,0,255],
      errorRc: 4, error: [0,0,0,0] });
  });
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

}

test("forwarded first-current initializes viewport and scissor once", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`, location.href).href;
    const { setupMainForward } = await import(base + "main-forward.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    document.body.replaceChildren(canvas);
    const source = `
      import { createMainForwardChannel } from ${JSON.stringify(base + "main-forward.ts")};
      import * as O from ${JSON.stringify(base + "ops.ts")};
      onmessage = () => {
        try {
          const channel = createMainForwardChannel({ postMessage: m => postMessage(m) }, 77, 321);
          if (channel.onCreateContext() !== 0) throw new Error("creation failed");
          const current = (surface) => channel.onMakeCurrent({ drawSurfaceId: surface, readSurfaceId: surface, width: 8, height: 8 });
          const state = (pname) => {
            const input = new Uint8Array(4); new DataView(input.buffer).setUint32(0, pname, true);
            const reply = channel.onQuery(O.QOP_GET_INTEGERV, input, 16);
            if (reply.rc !== 16) throw new Error("state query failed: " + reply.rc);
            return [...new Int32Array(reply.bytes.buffer)];
          };
          if (current(0) !== 0) throw new Error("surfaceless bind failed");
          const first = [state(0x0ba2), state(0x0c10)];
          for (const [op, values] of [[O.OP_VIEWPORT, [1,2,5,6]], [O.OP_SCISSOR, [0,1,4,5]]]) {
            const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
            view.setUint16(0, op, true); view.setUint16(2, 16, true);
            values.forEach((value, index) => view.setInt32(4 + index * 4, value, true));
            channel.onSubmit(bytes);
          }
          if (channel.onCreateSurface({surfaceId:1,kind:1,width:8,height:8,configId:1,targetBoId:0}).rc !== 0)
            throw new Error("window creation failed");
          if (current(1) !== 0) throw new Error("window bind failed");
          const rebound = [state(0x0ba2), state(0x0c10)];
          postMessage({ type: "first_current_result", first, rebound });
        } catch (error) { postMessage({ type: "first_current_failed", error: String(error) }); }
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const dispose = setupMainForward(worker, canvas, 77);
    try {
      return await new Promise<{ first: number[][]; rebound: number[][] }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("first-current contract timed out")), 35_000);
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "first_current_result") { clearTimeout(timeout); resolve(data); }
          if (data.type === "first_current_failed") { clearTimeout(timeout); reject(new Error(data.error)); }
        });
        worker.postMessage({ start: true });
      });
    } finally { worker.terminate(); dispose(); URL.revokeObjectURL(url); }
  }, root);
  expect(result.first).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
  expect(result.rebound).toEqual([[1, 2, 5, 6], [0, 1, 4, 5]]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("forwarded creation acknowledges real context loss and restoration", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const results = await page.evaluate(async sourceRoot => {
    const moduleUrl = new URL(`/@fs/${sourceRoot}host/src/webgl/main-forward.ts`, location.href).href;
    const { setupMainForward } = await import(moduleUrl);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required");
    const loss = gl.getExtension("WEBGL_lose_context");
    if (!loss) throw new Error("WEBGL_lose_context is required for the loss regression");
    const source = `
      import { createMainForwardChannel } from ${JSON.stringify(moduleUrl)};
      const channel = createMainForwardChannel({ postMessage: m => postMessage(m) }, 75);
      onmessage = ({ data }) => {
        if (data.retry) channel.onDestroyContext();
        postMessage({ type: "creation_result", rc: channel.onCreateContext() });
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const dispose = setupMainForward(worker, canvas, 75);
    const create = (retry: boolean) => new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("creation acknowledgement timed out")), 35_000);
      const receive = ({ data }: MessageEvent) => {
        if (data.type !== "creation_result") return;
        clearTimeout(timeout); worker.removeEventListener("message", receive);
        resolve(data.rc);
      };
      worker.addEventListener("message", receive);
      worker.postMessage({ retry });
    });
    function contextEvent(name: "webglcontextlost" | "webglcontextrestored") {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${name} did not arrive`)), 10_000);
        canvas.addEventListener(name, event => {
          event.preventDefault(); clearTimeout(timeout); resolve();
        }, { once: true });
      });
    }
    try {
      const accepted = await create(false);
      const lost = contextEvent("webglcontextlost");
      loss.loseContext(); await lost;
      const rejected = await create(true);
      const restored = contextEvent("webglcontextrestored");
      loss.restoreContext(); await restored;
      const retried = await create(false);
      return [accepted, rejected, retried];
    } finally {
      worker.terminate(); dispose(); URL.revokeObjectURL(url);
    }
  }, root);
  expect(results).toEqual([0, -19, 0]);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("deleted current programs survive owner switches and retire after their last reference", async ({ page }) => {
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT
    ?? fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async (sourceRoot) => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base + "registry.ts");
    const { GlMuxer } = await import(base + "muxer.ts");
    const { decodeAndDispatch } = await import(base + "bridge.ts");
    const { runGlQuery } = await import(base + "query.ts");
    const O = await import(base + "ops.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const bindings = [1,2].map(pid => {
      reg.bind({pid,cmdbufAddr:0,cmdbufLen:1024});
      const b = reg.get(pid)!;
      b.gl=gl; b.cmdbufView=new Uint8Array(1024);
      b.shadow.viewport=[0,0,8,8]; b.shadow.scissor.rect=[0,0,8,8];
      return b;
    });
    const send = (b: typeof bindings[0], op: number, words: number[], tail = new Uint8Array()) => {
      mux.switchTo(b);
      const bytes=b.cmdbufView!, view=new DataView(bytes.buffer);
      view.setUint16(0,op,true); view.setUint16(2,words.length*4+tail.length,true);
      words.forEach((word,i) => view.setUint32(4+i*4,word,true));
      bytes.set(tail,4+words.length*4);
      const rc=decodeAndDispatch(b,0,4+words.length*4+tail.length);
      if(rc) throw new Error(`command ${op}: ${rc}`);
    };
    const query = (b: typeof bindings[0], op: number, words: number[] = []) => {
      mux.switchTo(b);
      const input=new Uint8Array(words.length*4), output=new Uint8Array(4);
      words.forEach((word,i) => new DataView(input.buffer).setUint32(i*4,word,true));
      const rc=runGlQuery(b,op,input,output);
      if(rc!==4) throw new Error(`query ${op}: ${rc}`);
      return new DataView(output.buffer).getUint32(0,true);
    };
    bindings.forEach((b,index) => {
      for (const [name,type,source] of [
        [11,gl.VERTEX_SHADER,"void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=4.;}"],
        [12,gl.FRAGMENT_SHADER,`precision mediump float;void main(){gl_FragColor=vec4(${index}.,${1-index}.,0.,1.);}`],
      ] as [number,number,string][]) {
        send(b,O.OP_CREATE_SHADER,[type,name]);
        const bytes=new TextEncoder().encode(source);
        send(b,O.OP_SHADER_SOURCE,[name,bytes.length],bytes);
        send(b,O.OP_COMPILE_SHADER,[name]);
        if(query(b,O.QOP_GET_SHADERIV,[name,gl.COMPILE_STATUS])!==1) throw new Error("shader compile failed");
      }
      send(b,O.OP_CREATE_PROGRAM,[13]);
      send(b,O.OP_ATTACH_SHADER,[13,11]); send(b,O.OP_ATTACH_SHADER,[13,12]);
      send(b,O.OP_LINK_PROGRAM,[13]);
      if(query(b,O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS])!==1) throw new Error("program link failed");
      send(b,O.OP_USE_PROGRAM,[13]);
      send(b,O.OP_DELETE_SHADER,[11]); send(b,O.OP_DELETE_SHADER,[12]);
    });
    // GLES keeps the installed executable after a failed relink, even
    // while another owner temporarily occupies the native WebGL context.
    const oldExecutable=bindings[0].currentProgram!;
    const invalidSource=new TextEncoder().encode("this is not a shader");
    send(bindings[0],O.OP_SHADER_SOURCE,[12,invalidSource.length],invalidSource);
    send(bindings[0],O.OP_COMPILE_SHADER,[12]);
    if(query(bindings[0],O.QOP_GET_SHADERIV,[12,gl.COMPILE_STATUS])!==0) throw new Error("invalid shader compiled");
    send(bindings[0],O.OP_LINK_PROGRAM,[13]);
    const failedLink=query(bindings[0],O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS]);
    send(bindings[0],O.OP_DELETE_PROGRAM,[13]);
    const current=query(bindings[0],O.QOP_GET_INTEGERV,[gl.CURRENT_PROGRAM]);
    const deleted=query(bindings[0],O.QOP_GET_PROGRAMIV,[13,gl.DELETE_STATUS]);
    // An unlinked program is a driver rejection, not a state transition.
    send(bindings[0],O.OP_CREATE_PROGRAM,[14]);
    send(bindings[0],O.OP_USE_PROGRAM,[14]);
    const rejected=query(bindings[0],O.QOP_GET_ERROR);
    const pixels: number[][]=[];
    for(const index of [0,1,0,1,0,1]) {
      const b=bindings[index];
      send(b,O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]);
      const pixel=new Uint8Array(4);
      gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      pixels.push([...pixel]);
      if(query(b,O.QOP_GET_ERROR)!==0) throw new Error("draw error");
    }
    const blueSource=new TextEncoder().encode("precision mediump float;void main(){gl_FragColor=vec4(0.,0.,1.,1.);}");
    send(bindings[0],O.OP_SHADER_SOURCE,[12,blueSource.length],blueSource);
    send(bindings[0],O.OP_COMPILE_SHADER,[12]);
    send(bindings[0],O.OP_LINK_PROGRAM,[13]);
    const recoveredLink=query(bindings[0],O.QOP_GET_PROGRAMIV,[13,gl.LINK_STATUS]);
    send(bindings[0],O.OP_DRAW_ARRAYS,[gl.POINTS,0,1]);
    const recoveredPixels=new Uint8Array(4);
    gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,recoveredPixels);
    const oldExecutableRetired=!gl.isProgram(oldExecutable);
    send(bindings[0],O.OP_USE_PROGRAM,[0]);
    const retired=!bindings[0].programs.has(13) && !bindings[0].shaders.has(11) && !bindings[0].shaders.has(12);
    const otherLive=gl.isProgram(bindings[1].programs.get(13)!);
    for(const b of bindings) { mux.invalidateCurrent(); reg.destroyContext(b.pid); }
    return { current,deleted,rejected,pixels,retired,otherLive,failedLink,recoveredLink,
      recoveredPixels:[...recoveredPixels],oldExecutableRetired,error:gl.getError() };
  },root);
  expect(result).toEqual({ current:13,deleted:1,rejected:0x502,
    pixels:Array.from({length:6},(_,i) => i%2 ? [255,0,0,255] : [0,255,0,255]),
    retired:true,otherLive:true,failedLink:0,recoveredLink:1,
    recoveredPixels:[0,0,255,255],oldExecutableRetired:true,error:0 });
});

// Source surface ownership checks. Guest surface identities and cross-session
// routing remain a separate kernel/C integration requirement.
for (const replaceContext of [false,true]) {
test(`a live surface preserves pixels across ${replaceContext ? "context replacement and a failed resize" : "a failed resize"}`, async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
  const result = await page.evaluate(async ({sourceRoot,replaceContext}) => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { ensurePresentTarget } = await import(base+"present-target.ts");
    const { applyCurrentDrawable } = await import(base+"current.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2"); if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    reg.bind({pid:99,sessionId:1,cmdbufAddr:0,cmdbufLen:256});
    const b = reg.get(99,1)!; b.gl = gl; b.canvas = canvas; b.contextId = 1; b.surfaceId = 71;
    if (!ensurePresentTarget(b) || !applyCurrentDrawable(b,{drawSurfaceId:71,readSurfaceId:71,width:1,height:1})) throw new Error("initial drawable failed");
    mux.switchTo(b); gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    const original = b.presentTarget!;
    mux.invalidateCurrent(); if (replaceContext) reg.destroyContext(99,1);
    const retained = gl.isFramebuffer(original.fbo) && gl.isTexture(original.tex) && gl.isRenderbuffer(original.depthStencil);
    if (!retained) throw new Error("context destruction retired a live surface");
    b.gl = gl; b.contextId = 2;
    if (!ensurePresentTarget(b) || !applyCurrentDrawable(b,{drawSurfaceId:71,readSurfaceId:71,width:1,height:1})) throw new Error("replacement failed");
    const pixels = () => {
      mux.switchTo(b); const input = new Uint8Array(24), out = new Uint8Array(4);
      [0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE].forEach((n,i) => new DataView(input.buffer).setUint32(i*4,n,true));
      if (runGlQuery(b,O.QOP_READ_PIXELS,input,out) !== 4) throw new Error("pixel query failed");
      return [...out];
    };
    const before = pixels(); canvas.width = 2; mux.invalidateCurrent();
    const status = gl.checkFramebufferStatus.bind(gl);
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    let failed: boolean;
    try { failed = !ensurePresentTarget(b); } finally { gl.checkFramebufferStatus = status; }
    const unchanged = b.presentTarget === original && gl.isFramebuffer(original.fbo);
    const after = pixels(); mux.invalidateCurrent();
    const retried = ensurePresentTarget(b), replacement = b.presentTarget!;
    const oldRetired = !gl.isFramebuffer(original.fbo) && !gl.isTexture(original.tex) && !gl.isRenderbuffer(original.depthStencil);
    reg.unbind(99,1);
    return {retained,before,failed,unchanged,after,retried,oldRetired,
      retired:!gl.isFramebuffer(replacement.fbo) && !gl.isTexture(replacement.tex) && !gl.isRenderbuffer(replacement.depthStencil),error:gl.getError()};
  },{sourceRoot:root,replaceContext});
  expect(result).toEqual({retained:true,before:[255,0,0,255],failed:true,unchanged:true,after:[255,0,0,255],retried:true,oldRetired:true,retired:true,error:0});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
}

test("surface draw/read selectors retain storage across owner retirement and independent resizing", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = process.env.KANDELO_GRAPHICS_SOURCE_ROOT ?? fileURLToPath(new URL("../../../",import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = `/@fs/${sourceRoot}host/src/webgl/`;
    const { GlContextRegistry } = await import(base+"registry.ts");
    const { GlMuxer } = await import(base+"muxer.ts");
    const { resizeSurfaceTarget } = await import(base+"present-target.ts");
    const { applyCurrentDrawable } = await import(base+"current.ts");
    const { runGlQuery } = await import(base+"query.ts");
    const { decodeAndDispatch } = await import(base+"bridge.ts");
    const O = await import(base+"ops.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2"); if (!gl) throw new Error("WebGL2 required");
    const reg = new GlContextRegistry(), mux = new GlMuxer(gl);
    const [a,b,c] = [1,2,3].map(sessionId => {
      reg.bind({pid:100,sessionId,cmdbufAddr:0,cmdbufLen:256});
      const value = reg.get(100,sessionId)!; value.gl = gl; value.contextId = sessionId; return value;
    });
    a.surfaceId = 71; b.surfaceId = 72;
    if (!resizeSurfaceTarget(a,1,1) || !resizeSurfaceTarget(b,1,1)) throw new Error("independent storage failed");
    const original = a.presentTarget!, readTarget = b.presentTarget!, draw = a.surface, read = b.surface;
    const bind = (owner: typeof a, drawOwner: typeof a, readOwner = drawOwner) => {
      mux.invalidateCurrent();
      if (!applyCurrentDrawable(owner,{drawSurfaceId:drawOwner.surfaceId!,readSurfaceId:readOwner.surfaceId!,width:1,height:1},
        {draw:drawOwner.surface,read:readOwner.surface})) throw new Error("surface selection failed");
      mux.switchTo(owner);
    };
    bind(a,a); gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    bind(b,b); gl.clearColor(0,1,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    bind(c,a,b);
    c.fbos.set(99,gl.createFramebuffer()!); c.cmdbufView = new Uint8Array(12);
    const send = (name: number) => {
      const view = new DataView(c.cmdbufView!.buffer);
      view.setUint16(0,O.OP_BIND_FRAMEBUFFER,true); view.setUint16(2,8,true);
      view.setUint32(4,gl.FRAMEBUFFER,true); view.setUint32(8,name,true);
      if (decodeAndDispatch(c,0,12)) throw new Error("framebuffer command failed");
    };
    send(99); send(0);
    const framebufferZero = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === original.fbo
      && gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === readTarget.fbo;
    gl.clearColor(0,0,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
    const pixels = () => {
      mux.switchTo(c); const input = new Uint8Array(24), out = new Uint8Array(4);
      [0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE].forEach((n,i) => new DataView(input.buffer).setUint32(i*4,n,true));
      if (runGlQuery(c,O.QOP_READ_PIXELS,input,out) !== 4) throw new Error("pixel query failed");
      return [...out];
    };
    const separateRead = pixels(); mux.invalidateCurrent();
    if (!resizeSurfaceTarget(a,2,1)) throw new Error("resize failed");
    const resized = a.presentTarget!;
    const independent = c.shadow.fbo === resized.fbo && c.shadow.readFbo === readTarget.fbo && b.presentTarget === readTarget;
    reg.unbind(100,1); reg.unbind(100,2);
    const retained = gl.isFramebuffer(resized.fbo) && gl.isFramebuffer(readTarget.fbo) && draw.users.has(c) && read.users.has(c);
    const afterRetirement = pixels(); mux.invalidateCurrent(); reg.unbind(100,3);
    return {framebufferZero,separateRead,independent,retained,afterRetirement,oldRetired:!gl.isFramebuffer(original.fbo),
      final:!gl.isFramebuffer(resized.fbo) && !gl.isFramebuffer(readTarget.fbo) && !draw.users.size && !read.users.size,error:gl.getError()};
  },root);
  expect(result).toEqual({framebufferZero:true,separateRead:[0,255,0,255],independent:true,retained:true,afterRetirement:[0,255,0,255],oldRetired:true,final:true,error:0});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

test("forwarded surface creation acknowledges dimensions and preserves selected pixels through retirement", async ({page}) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../",import.meta.url));
  const result = await page.evaluate(async sourceRoot => {
    const base = new URL(`/@fs/${sourceRoot}host/src/webgl/`,location.href).href;
    const {setupMainForward} = await import(base+"main-forward.ts");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8;
    document.body.replaceChildren(canvas);
    const source = `
      import {createMainForwardChannel} from ${JSON.stringify(base+"main-forward.ts")};
      import * as O from ${JSON.stringify(base+"ops.ts")};
      onmessage = () => { try {
        const c = createMainForwardChannel({postMessage:m => postMessage(m)},77,321);
        const surface = (id,width,height) => c.onCreateSurface({surfaceId:id,kind:1,width,height,configId:1,targetBoId:0});
        const first = surface(71,3,2);
        if (first.rc !== 0 || c.onCreateContext() !== 0) throw new Error("creation failed");
        const bind = (id,width,height) => c.onMakeCurrent({drawSurfaceId:id,readSurfaceId:id,width,height});
        const clear = (color) => {
          const bytes = new Uint8Array(28), v = new DataView(bytes.buffer);
          v.setUint16(0,O.OP_CLEAR_COLOR,true); v.setUint16(2,16,true);
          color.forEach((n,i) => v.setFloat32(4+i*4,n,true));
          v.setUint16(20,O.OP_CLEAR,true); v.setUint16(22,4,true); v.setUint32(24,0x4000,true);
          c.onSubmit(bytes);
        };
        const pixels = () => {
          const input = new Uint8Array(24), v = new DataView(input.buffer);
          [0,0,1,1,0x1908,0x1401].forEach((n,i) => v.setUint32(i*4,n,true));
          const reply = c.onQuery(O.QOP_READ_PIXELS,input,4);
          if (reply.rc !== 4) throw new Error("pixel query failed: "+reply.rc);
          return [...reply.bytes];
        };
        if (bind(71,3,2) !== 0) throw new Error("first bind failed");
        clear([1,0,0,1]); const red = pixels();
        c.onDestroySurface(71); const retained = pixels();
        const second = surface(72,4,1);
        if (second.rc !== 0 || bind(72,4,1) !== 0) throw new Error("replacement failed");
        clear([0,1,0,1]); const green = pixels();
        const rejected = surface(73,5,5).rc;
        c.onDestroySurface(71); const afterStale = pixels();
        if (c.onPresent() !== 0) throw new Error("present failed");
        postMessage({type:"surface_result",first,second,red,retained,green,rejected,afterStale});
      } catch(error) {postMessage({type:"surface_failed",error:String(error)});} };
    `;
    const url = URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
    const worker = new Worker(url,{type:"module"}), dispose = setupMainForward(worker,canvas,77);
    try {
      const result = await new Promise<any>((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error("surface acknowledgement timed out")),35000);
        worker.addEventListener("message",({data}) => {
          if (data.type === "surface_result") {clearTimeout(timer);resolve(data);}
          if (data.type === "surface_failed") {clearTimeout(timer);reject(new Error(data.error));}
        });
        worker.postMessage({start:true});
      });
      const gl = canvas.getContext("webgl2")!;
      const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
      const visible = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,visible);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous);
      return {...result,visible:[...visible]};
    } finally {worker.terminate();dispose();URL.revokeObjectURL(url);}
  },root);
  expect(result).toEqual({type:"surface_result",first:{rc:0,width:3,height:2},second:{rc:0,width:4,height:1},
    red:[255,0,0,255],retained:[255,0,0,255],green:[0,255,0,255],rejected:-16,afterStale:[0,255,0,255],visible:[0,255,0,255]});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});

for (const mode of ["native","forwarded","retarget"] as const) {
  test(`${mode} cross-session surfaces preserve separate pixels and retire after their final selector`, async ({page}) => {
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto("/trap-signal-test.html");
    const root = fileURLToPath(new URL("../../../",import.meta.url));
    const result = await page.evaluate(async ({root,mode}) => {
      const canvas = document.createElement("canvas");canvas.width=canvas.height=8;document.body.replaceChildren(canvas);
      const gl = mode === "forwarded" ? canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})! : null;
      const created: object[] = [], deleted: object[] = [], live: Array<() => boolean> = [];
      if (gl) {
        for (const [createName,deleteName,isName] of [
          ["createFramebuffer","deleteFramebuffer","isFramebuffer"],
          ["createTexture","deleteTexture","isTexture"],
          ["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],
        ]) {
          const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
          api[createName]=() => {const value=create();if(value){created.push(value);live.push(() => isLive(value));}return value;};
          api[deleteName]=(value:object|null) => {if(value)deleted.push(value);destroy(value);};
        }
      }
      const worker = new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/surface-routing-worker.ts`,location.href),{type:"module"});
      const {setupMainForward} = await import(new URL(`/@fs/${root}host/src/webgl/main-forward.ts`,location.href).href);
      const dispose = mode === "forwarded" ? setupMainForward(worker,canvas,7) : () => {};
      try {
        const result = await new Promise<any>((resolve,reject) => {
          const timeout=setTimeout(() => reject(new Error("surface routing worker timed out")),35000);
          worker.addEventListener("error",event => {clearTimeout(timeout);reject(new Error(event.message));});
          worker.addEventListener("message",({data}) => {
            if (data.type === "surface_routing_result") {clearTimeout(timeout);resolve(data);}
            if (data.type === "surface_routing_failed") {clearTimeout(timeout);reject(new Error(data.error));}
          });
          if (mode === "forwarded") worker.postMessage({mode});
          else {const offscreen=canvas.transferControlToOffscreen();worker.postMessage({mode,canvas:offscreen},[offscreen]);}
        });
        if (gl) {
          const previous=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
          const visible=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,visible);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous);
          result.visible=[...visible];result.clean=created.length===deleted.length && created.every(value => deleted.includes(value)) && live.every(isLive => !isLive());
          result.error=gl.getError();
        }
        return result;
      } finally {worker.terminate();dispose();}
    },{root,mode});
    expect(result).toEqual({type:"surface_routing_result",red:[255,0,0,255],green:[0,255,0,255],independent:[0,255,0,255],
      blue:mode === "retarget" ? [0,0,255,255] : null,retained:[0,255,0,255],rejected:-22,afterRejected:[0,255,0,255],
      visible:mode === "retarget" ? null : [0,0,255,255],clean:true,error:0});
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
for(const scenario of ["shared-records-render","records-basic","names-render","image-target-render","image-bind-render","encoder-array-render","encoder-array-index-render"] as const) {
for (const mode of ["native", "forwarded"] as const) {
  test(`actual C ${scenario === "shared-records-render" ? "public shared contexts retain texture storage after source retirement" : scenario === "records-basic" ? "independent EGL records preserve draw/read pixels" : scenario === "names-render" ? "implicit and generated texture names retain independent storage" : scenario === "image-bind-render" ? "native binding allocation failure preserves binding and dimensionality" : scenario === "image-target-render" ? "a rejected texture target preserves binding and storage" : `client staging restores the retained buffer across a renderer peer deletion${scenario.includes("index") ? " with separate index/vertex views" : ""}`} through ${mode} dispatch`, async ({page}) => {
    const root=fileURLToPath(new URL("../../../",import.meta.url));
    const temporary=mkdtempSync(join(root,".context/graphics-egl-record-trace-"));
    let trace:number[];
    try {
      const path=join(temporary,"egl.bin");
      execFileSync("bash",[join(root,"tests/graphics/run-libc-unit.sh")],{
        cwd:root,env:{...process.env,KANDELO_GRAPHICS_LIBC_CASES:scenario,KANDELO_GRAPHICS_EGL_TRACE:path},
        timeout:60000,stdio:"pipe",
      });
      trace=[...readFileSync(path)];
    } finally {rmSync(temporary,{recursive:true,force:true});}
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto("/trap-signal-test.html");
    const result=await page.evaluate(async ({root,mode,trace,scenario})=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=8;document.body.replaceChildren(canvas);
      const gl=mode==="forwarded"?canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})!:null;
      const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[];
      if(gl)for(const [createName,deleteName,isName] of [
        ["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createTexture","deleteTexture","isTexture"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],
        ...(scenario.startsWith("encoder-array-")?[["createBuffer","deleteBuffer","isBuffer"],["createVertexArray","deleteVertexArray","isVertexArray"]]:[]),
      ]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=()=>{const value=create();if(value){created.push(value);live.push(()=>isLive(value));}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      const worker=new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/egl-record-worker.ts`,location.href),{type:"module"});
      const {setupMainForward}=await import(new URL(`/@fs/${root}host/src/webgl/main-forward.ts`,location.href).href);
      const dispose=mode==="forwarded"?setupMainForward(worker,canvas,7):()=>{};
      try {
        const result=await new Promise<any>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error("EGL record replay timed out")),35000);
          worker.addEventListener("error",event=>{clearTimeout(timeout);reject(new Error(event.message));});
          worker.addEventListener("message",({data})=>{
            if(data.type==="egl_record_fail_texture_create") {
              if(!gl)throw new Error("missing forwarding renderer");
              const api=gl as any,create=api.createTexture;
              api.createTexture=()=>{api.createTexture=create;return null;};
            }
            if(data.type==="egl_record_result"){clearTimeout(timeout);resolve(data);}
            if(data.type==="egl_record_failed"){clearTimeout(timeout);reject(new Error(data.error));}
          });
          if(mode==="forwarded")worker.postMessage({mode,trace,peerDelete:scenario.startsWith("encoder-array-"),captureUpload:scenario.startsWith("image-"),bindFailure:scenario==="image-bind-render"});
          else {const offscreen=canvas.transferControlToOffscreen();worker.postMessage({mode,trace,canvas:offscreen,peerDelete:scenario.startsWith("encoder-array-"),captureUpload:scenario.startsWith("image-"),bindFailure:scenario==="image-bind-render"},[offscreen]);}
        });
        if(gl) {
          result.clean=created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
          result.error=gl.getError();
        }
        return result;
      } finally {worker.terminate();dispose();}
    },{root,mode,trace,scenario});
    expect(result).toEqual(scenario === "shared-records-render" ? {type:"egl_record_result",observed:[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255]],retiredContexts:[31,32],retiredSurfaces:[],clean:true,error:0}
    :scenario === "records-basic" ? {type:"egl_record_result",observed:[
      [255,0,0,255],[0,255,0,255],[0,255,0,255],[0,0,255,255],[0,255,0,255],[0,255,0,255],
    ],retiredContexts:[32,31],retiredSurfaces:[132,131,133],clean:true,error:0}
    :scenario.startsWith("image-")?{type:"egl_record_result",observed:[[255,0,0,255],[0,0,255,255]],retiredContexts:[31],retiredSurfaces:[],clean:true,error:0}
    :scenario === "names-render"?{type:"egl_record_result",observed:[[255,0,0,255],[0,255,0,255],[255,0,0,255]],retiredContexts:[31],retiredSurfaces:[],clean:true,error:0}
    :{type:"egl_record_result",observed:[[0,255,0,255],[255,0,0,255]],retiredContexts:[31],retiredSurfaces:[131],clean:true,injected:true,error:0});
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
}

for(const mode of ["native","forwarded"] as const) {
  test(`ABI 58 shared context construction preserves object identity through ${mode} dispatch`,async({page})=>{
    await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
    const root=fileURLToPath(new URL("../../../",import.meta.url));
    const result=await page.evaluate(async({root,mode})=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=1;document.body.replaceChildren(canvas);
      const gl=mode==="forwarded"?canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})!:null;
      const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[];
      if(gl)for(const [createName,deleteName,isName] of [["createTexture","deleteTexture","isTexture"],["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"]]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=()=>{const value=create();if(value){created.push(value);live.push(()=>isLive(value));}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      const worker=new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/share-context-worker.ts`,location.href),{type:"module"});
      const {setupMainForward}=await import(new URL(`/@fs/${root}host/src/webgl/main-forward.ts`,location.href).href);
      const dispose=mode==="forwarded"?setupMainForward(worker,canvas,7):()=>{};
      try {
        const result=await new Promise<any>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error("shared context worker timed out")),35000);
          worker.addEventListener("error",event=>{clearTimeout(timeout);reject(new Error(event.message));});
          worker.addEventListener("message",({data})=>{
            if(data.type==="share_context_result"){clearTimeout(timeout);resolve(data);}
            if(data.type==="share_context_failed"){clearTimeout(timeout);reject(new Error(data.error));}
          });
          if(mode==="forwarded")worker.postMessage({mode});
          else {const offscreen=canvas.transferControlToOffscreen();worker.postMessage({mode,canvas:offscreen},[offscreen]);}
        });
        if(gl){result.clean=created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());result.error=gl.getError();}
        return result;
      } finally {worker.terminate();dispose();}
    },{root,mode});
    expect(result).toEqual({type:"share_context_result",red:[255,0,0,255],sharedRed:[255,0,0,255],sharedGreen:[0,255,0,255],independent:[0,0,255,255],
      survivor:[0,255,0,255],chained:[0,255,0,255],unnamed:[0,255,0,255],publicName:[0,0,0,0],afterReuse:[0,255,0,255],afterPeerDestroy:[0,255,0,255],clean:true,error:0});
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}


for(const mode of ["native","forwarded"] as const) {
  test(`checked shared uniform values survive source retirement and reject relinked locations through ${mode} dispatch`,async({page})=>{
    await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
    const root=fileURLToPath(new URL("../../../",import.meta.url));
    const result=await page.evaluate(async({root,mode})=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=1;document.body.replaceChildren(canvas);
      const gl=mode==="forwarded"?canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})!:null;
      const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[];
      if(gl)for(const [createName,deleteName,isName] of [["createTexture","deleteTexture","isTexture"],["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],["createProgram","deleteProgram","isProgram"],["createShader","deleteShader","isShader"]]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=(...args:unknown[])=>{const value=create(...args);if(value){created.push(value);live.push(()=>isLive(value));}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      const worker=new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/share-context-worker.ts`,location.href),{type:"module"});
      const {setupMainForward}=await import(new URL(`/@fs/${root}host/src/webgl/main-forward.ts`,location.href).href);
      const dispose=mode==="forwarded"?setupMainForward(worker,canvas,7):()=>{};
      try {
        const result=await new Promise<any>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error("uniform values worker timed out")),35000);
          worker.addEventListener("error",event=>{clearTimeout(timeout);reject(new Error(event.message));});
          worker.addEventListener("message",({data})=>{
            if(data.type==="uniform_values_result"){clearTimeout(timeout);resolve(data);}
            if(data.type==="share_context_failed"){clearTimeout(timeout);reject(new Error(data.error));}
          });
          if(mode==="forwarded")worker.postMessage({mode,uniforms:true});
          else {const offscreen=canvas.transferControlToOffscreen();worker.postMessage({mode,uniforms:true,canvas:offscreen},[offscreen]);}
        });
        if(gl){result.clean=created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());result.error=gl.getError();}
        return result;
      } finally {worker.terminate();dispose();}
    },{root,mode});
    const ok=(values:number[])=>({status:0,count:values.length,values});
    const reflected:Array<[string,number,number]>=[["colorValue",1,0x8b52],["normal",1,0x8b5b],["transform",1,0x8b5c],["items[0]",2,0x8b51],["flags",1,0x8b59],["scalar",1,0x1406],["u"+"n".repeat(248),1,0x1406]];
    reflected.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    expect(result).toEqual({type:"uniform_values_result",stable:true,peerStable:true,missingBulk:-1,reflected,shared:[ok([.25,.5,.75,1]),ok([1,2,3,4,5,6,7,8,9]),ok([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),ok([1,2,3]),ok([4,5,6]),ok([1,0,1,0]),ok([.5]),ok([0])],
      integers:ok([0,1,1,1]),booleans:ok([1,0,1,0]),survivor:ok([.25,.5,.75,1]),rendered:[255,0,0,255],failedLink:{status:1,count:0,values:[]},failedError:[2,5,0,0],retainedExecutable:[255,0,0,255],invalidated:{status:1,count:0,values:[]},staleError:[2,5,0,0],relinked:ok([0,0,0,0]),pending:ok([0,0,0,0]),afterDelete:{status:1,count:0,values:[]},deletedError:[1,5,0,0],clean:true,error:0});
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}


for(const mode of ["native","forwarded"] as const) {
  test(`delayed shared reservations preserve realized storage through ${mode} dispatch`,async({page})=>{
    await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
    const root=fileURLToPath(new URL("../../../",import.meta.url));
    const result=await page.evaluate(async({root,mode})=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=1;document.body.replaceChildren(canvas);
      const gl=mode==="forwarded"?canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})!:null;
      const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[],counts:Record<string,number>={};
      if(gl)for(const [createName,deleteName,isName] of [["createTexture","deleteTexture","isTexture"],["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],["createBuffer","deleteBuffer","isBuffer"]]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=(...args:unknown[])=>{const value=create(...args);if(value){created.push(value);live.push(()=>isLive(value));counts[createName]=(counts[createName]??0)+1;}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      const worker=new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/share-context-worker.ts`,location.href),{type:"module"});
      const {setupMainForward}=await import(new URL(`/@fs/${root}host/src/webgl/main-forward.ts`,location.href).href);
      const dispose=mode==="forwarded"?setupMainForward(worker,canvas,7):()=>{};
      try {
        const result=await new Promise<any>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error("reservation worker timed out")),35000);
          worker.addEventListener("error",event=>{clearTimeout(timeout);reject(new Error(event.message));});
          worker.addEventListener("message",({data})=>{
            if(data.type==="reservation_result"){clearTimeout(timeout);resolve(data);}
            if(data.type==="share_context_failed"){clearTimeout(timeout);reject(new Error(data.error));}
          });
          if(mode==="forwarded")worker.postMessage({mode,reservations:true});
          else {const offscreen=canvas.transferControlToOffscreen();worker.postMessage({mode,reservations:true,canvas:offscreen},[offscreen]);}
        });
        if(gl){result.clean=created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());result.error=gl.getError();result.allocations=[counts.createBuffer??0,counts.createTexture??0,counts.createRenderbuffer??0];}
        return result;
      } finally {worker.terminate();dispose();}
    },{root,mode});
    expect(result).toEqual({type:"reservation_result",reserved:[false,false,false],realized:[true,true,true],retired:[false,false,false],texturePixels:[255,0,0,255],renderbufferPixels:[0,255,0,255],bufferMaximum:3,bufferBits:15,errors:[[0,0,0,0],[0,0,0,0]],allocations:[2,1,1],clean:true,error:0});
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}

// Native source registration and logical image views; public C sharing and
// normal guest ioctl marshalling are separate validation phases.
test("logical image views preserve sibling parameters, pixels and retained identity",async({page})=>{
  await installBrowserMemoryBoundaryProbe(page);await page.goto("/trap-signal-test.html");
  const root=fileURLToPath(new URL("../../../",import.meta.url));
  const result=await page.evaluate(async(root)=>{
    const canvas=document.createElement("canvas");canvas.width=canvas.height=4;document.body.replaceChildren(canvas);
    const worker=new Worker(new URL(`/@fs/${root}apps/browser-demos/test/support/image-storage-worker.ts`,location.href),{type:"module"});
    try{return await new Promise<any>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("image view replay timed out")),35000);
      worker.addEventListener("error",event=>{clearTimeout(timeout);reject(new Error(event.message));});
      worker.addEventListener("message",({data})=>{if(data.type==="image_storage_failed"){clearTimeout(timeout);reject(new Error(data.error));}
        if(data.type==="image_storage_result"){clearTimeout(timeout);resolve(data);}});
      const offscreen=canvas.transferControlToOffscreen();worker.postMessage({canvas:offscreen},[offscreen]);
    });}finally{worker.terminate();}
  },root);
  expect(result).toEqual({type:"image_storage_result",namespace:[0,0,255,255],firstParam:0x2600,secondParam:0x2601,
    red:[[255,0,0,255],[255,0,0,255]],rboName:2,green:[[0,255,0,255],[0,255,0,255]],sampledGreen:[0,255,0,255],
    orphan:[[0,0,255,255],[0,255,0,255]],aSource:0,bSource:0,mipOrphan:[0,255,0,255],reimport:[255,0,0,255],rboSource:0,rboOrphan:[[0,0,255,255],[255,0,0,255]],
    rejected:[0,0,255,255],retargetRejected:[0,0,255,255],reused:[255,255,0,255],retained:[0,0,255,255],retainedState:[0,2],retainedImport:[1,3],retainedImported:[255,0,0,255],reusedAfterPeerImport:[255,255,0,255],afterSourceRetirement:[255,0,0,255],mutationRollback:[[255,255,0,255],[255,0,0,255],[0,0,255,255],[0,0,255,255],[255,255,0,255],[255,0,0,255]],storageReject:[[255,255,0,255],[0,0,255,255]],ownedStorageRetry:[0,0,255,255],framebufferBindReject:[[0,0,255,255],[0,0,255,255]],framebufferBindRetry:[0,0,255,255],bufferBindReject:[[100,11,22,33,44],[100,11,22,33,44],[102,11,22,33,44],[102,11,22,33,44]],bufferBindRetry:[101,103],bufferDeleteRollback:[[0,255,0,255],[0,255,0,255],[0,255,0,255],[0,255,0,255]],bufferDeleteCleared:[0,0,0,0],bufferDeleteRetry:[0,0,255,255],captureEnd:-5,captureBlocked:-5,captureOutput:[165,165,165,165],captureState:[200,0],capturePixels:[0,0,255,255],promotionSubmit:-5,promotionBlocked:-5,promotionDraws:1,promotionPixels:[0,0,255,255],pointerSubmit:-5,pointerBlocked:-5,pointerOutput:[165,165,165,165],pointerPixels:[0,0,255,255],convertedRetryPixels:[0,255,0,255],repairBlocked:-5,repairBlockedOutput:[165,165,165,165],repairPeerBlocked:-5,repairBatchBlocked:-5,repairRestored:[255,0,0,255],storageBlocked:-5,storageBlockedOutput:[165,165,165,165],storageRestored:[[255,0,0,255],[255,0,0,255]],storageState:[1,1],storageCommit:[1,0,2],storageCleanupBlocked:-5,storageOwned:[[0,0,255,255],[0,0,255,255]],rawNamespace:[0,0,255,255],rawParams:[0x2600,0x2601],rawGreen:[0,255,0,255],rawOrphan:[[255,0,0,255],[0,255,0,255]],rawRefresh:[0,255,0,255],rawInvalid:-14,rawBlocked:-5,rawBlockedOutput:[165,165,165,165],rawRevoked:[0,0,1],rawReplacement:[0,0,255,255],rawMissing:0x8cd7,errors:[0,0],clean:true,error:0});
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
