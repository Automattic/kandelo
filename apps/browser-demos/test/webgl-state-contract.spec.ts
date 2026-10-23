import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

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
    for (const index of [0,1,0,1,0,1]) {
      const b = bindings[index];
      send(b, ops.OP_DRAW_ARRAYS, [gl.TRIANGLES,0,3]);
      const pixels = new Uint8Array(4);
      gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
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
    return { observations, physicalStatePreserved, importedPixels: [...importedPixels], importError };
  }, root);
  expect(result.physicalStatePreserved).toBe(true);
  expect(result.importedPixels).toEqual([17,29,41,255]);
  expect(result.importError).toBe(0);
  for (const observation of result.observations) {
    const first = observation.index === 0;
    expect(observation).toEqual({ index: observation.index,
      rgba: first ? [255,255,0,255] : [255,0,255,255], dither: !first,
      rowLength: first ? 7 : 0, skipRows: first ? 2 : 0,
      skipPixels: first ? 1 : 0, error: 0 });
  }
});
