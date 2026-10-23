import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

// Actual WebGL rendering through the shared decoder and muxer. This checks
// host execution pixels; guest ABI/compositor integration has separate tests.
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

test("forwarded synchronous queries isolate owners with one mailbox per channel", async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto("/trap-signal-test.html");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await page.evaluate(async (sourceRoot) => {
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
          const channels = [73,74].map(pid => createMainForwardChannel({ postMessage: message => postMessage(message) }, pid));
          const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
          const bytes = new Uint8Array(memory.buffer);
          const view = new DataView(memory.buffer);
          const results = [];
          for (let round = 0; round < 3; round++) {
            channels.forEach((channel,index) => {
              channel.onCreateContext();
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
    const dispose = [73,74].map(pid => setupMainForward(worker, canvas, pid));
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
  }, root);
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
    send(bindings[0],O.OP_USE_PROGRAM,[0]);
    const retired=!bindings[0].programs.has(13) && !bindings[0].shaders.has(11) && !bindings[0].shaders.has(12);
    const otherLive=gl.isProgram(bindings[1].programs.get(13)!);
    for(const b of bindings) { mux.invalidateCurrent(); reg.destroyContext(b.pid); }
    return { current,deleted,rejected,pixels,retired,otherLive,error:gl.getError() };
  },root);
  expect(result).toEqual({ current:13,deleted:1,rejected:0x502,
    pixels:Array.from({length:6},(_,i) => i%2 ? [255,0,0,255] : [0,255,0,255]),
    retired:true,otherLive:true,error:0 });
});
