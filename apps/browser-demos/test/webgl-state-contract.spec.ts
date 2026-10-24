import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

// Actual WebGL rendering through the shared decoder and muxer. This checks
// host execution pixels; guest ABI/compositor integration has separate tests.
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
          const drawable = { drawSurfaceId: 1, readSurfaceId: 1, width: 1, height: 1 };
          for (const channel of channels) {
            if (channel.onCreateContext() !== 0 || channel.onMakeCurrent(drawable) !== 0)
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
            if (invalidate && channels[1].onMakeCurrent(drawable) !== 0)
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
              if (channel.onMakeCurrent({ drawSurfaceId: 1, readSurfaceId: 1, width: 8, height: 8 }) !== 0)
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
