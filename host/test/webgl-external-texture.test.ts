import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { registerImageSource } from "../src/webgl/image-storage.js";
import { noteStorageWrite } from "../src/webgl/image-writes.js";
import { noteSamplerWrite } from "../src/webgl/depth-sampling.js";
// Loaded per test, so the GL behavior tests run against any host build.
const externalShaderSource = async (source: string) =>
  (await import("../src/webgl/external-texture.js")).externalShaderSource(source);

/**
 * GL_OES_EGL_image_external: TEXTURE_EXTERNAL_OES bindings, parameter
 * rules, samplerExternalOES, reflection, draw-time sampling and the
 * sampler-type rule, against a fake renderer that models per-unit native
 * TEXTURE_2D bindings, texture parameters, and a GLSL front end that
 * accepts only types the source defines.
 */

const TEX = 0x0de1, CUBE = 0x8513, EXTERNAL = 0x8d65, SAMPLER_2D = 0x8b5e, SAMPLER_EXTERNAL = 0x8d66;
const MIN = 0x2801, MAG = 0x2800, WRAP_S = 0x2802, WRAP_T = 0x2803;
const LINEAR = 0x2601, NEAREST = 0x2600, CLAMP = 0x812f, REPEAT = 0x2901, MIPMAP = 0x2702;

type Texture = { id: number; target?: number; params: Map<number, number>; content: number };
type Shader = { type: number; source: string; compiled: boolean };
type Uniform = { name: string; type: number; size: number; values: number[] };
type Program = { shaders: Shader[]; linked: boolean; uniforms: Uniform[]; validated?: boolean };

class ExternalGl {
  error = 0;
  active = 0;
  units: (Texture | null)[] = [];
  cube: (Texture | null)[] = [];
  current: Program | null = null;
  /** Each draw: the texture content each unit's TEXTURE_2D sampled. */
  draws: (number | null)[][] = [];
  calls = new Map<string, number>();
  read: object | null = null;
  draw: object | null = null;
  attachments = new Map<object, Texture>();
  private next = 1;
  private contents = 100;
  getError() { const error = this.error; this.error = 0; return error; }
  isContextLost() { return false; }
  getExtension() { return null; }
  getParameter(pname: number): unknown {
    switch (pname) {
      case 0x8069: return this.units[this.active] ?? null;
      case 0x8514: return this.cube[this.active] ?? null;
      case 0x84e0: return 0x84c0 + this.active;
      case 0x8b8d: return this.current;
      case 0x8ca6: return this.draw;
      case 0x8caa: return this.read;
      case 0x8b4d: case 0x8872: case 0x8869: return 16;
      default: return 0;
    }
  }
  isEnabled() { return false; }
  activeTexture(unit: number) { this.active = unit - 0x84c0; }
  createTexture(): Texture { return { id: this.next++, params: new Map(), content: 0 }; }
  deleteTexture() {}
  bindTexture(target: number, texture: Texture | null) {
    if (target !== TEX && target !== CUBE) { this.error ||= 0x500; return; }
    if (texture?.target && texture.target !== target) { this.error ||= 0x502; return; }
    if (texture) texture.target = target;
    (target === TEX ? this.units : this.cube)[this.active] = texture;
  }
  private bound(target: number) {
    if (target !== TEX && target !== CUBE) { this.error ||= 0x500; return null; }
    return (target === TEX ? this.units : this.cube)[this.active] ?? null;
  }
  texParameteri(target: number, pname: number, value: number) { this.bound(target)?.params.set(pname, value); }
  texParameterf(target: number, pname: number, value: number) { this.texParameteri(target, pname, value); }
  getTexParameter(target: number, pname: number) {
    const texture = this.bound(target);
    const initial = pname === MIN ? MIPMAP : pname === MAG ? LINEAR : REPEAT;
    return texture?.params.get(pname) ?? initial;
  }
  texImage2D(target: number) { const t = this.bound(target); if (t) t.content = ++this.contents; }
  generateMipmap(target: number) { this.bound(target); }
  createFramebuffer() { return { framebuffer: this.next++ }; }
  deleteFramebuffer() {}
  bindFramebuffer(target: number, framebuffer: object | null) {
    if (target !== 0x8ca8) this.draw = framebuffer;
    if (target !== 0x8ca9) this.read = framebuffer;
  }
  framebufferTexture2D(_target: number, _point: number, _textarget: number, texture: Texture | null) {
    if (texture) this.attachments.set(this.read!, texture);
  }
  checkFramebufferStatus() { return 0x8cd5; }
  bindRenderbuffer() {}
  framebufferRenderbuffer() {}
  copyTexSubImage2D() { this.units[this.active]!.content = this.attachments.get(this.read!)!.content; }
  /** Canonical storage written by another API. */
  write(texture: Texture) { texture.content = ++this.contents; }
  createShader(type: number): Shader { return { type, source: "", compiled: false }; }
  deleteShader() {}
  shaderSource(shader: Shader, source: string) { shader.source = source; }
  /** A GLSL ES 1.00 front end that knows sampler2D/samplerCube and the
   * types the source #defines; samplerExternalOES is no native type. */
  compileShader(shader: Shader) {
    const defined = new Set([...shader.source.matchAll(/^#define (\w+) sampler2D$/gm)].map(m => m[1]));
    shader.compiled = [...shader.source.matchAll(/uniform\s+(?:\w+p\s+)?(\w+)\s+\w+/g)]
      .every(([, type]) => ["sampler2D", "samplerCube", "vec4", "float"].includes(type) || defined.has(type));
  }
  getShaderParameter(shader: Shader, pname: number) { return pname === 0x8b4f ? shader.type : shader.compiled; }
  createProgram(): Program { return { shaders: [], linked: false, uniforms: [] }; }
  attachShader(program: Program, shader: Shader) { program.shaders.push(shader); }
  linkProgram(program: Program) {
    program.linked = program.shaders.every(shader => shader.compiled);
    const defined = new Set(program.shaders.flatMap(shader =>
      [...shader.source.matchAll(/^#define (\w+) sampler2D$/gm)].map(m => m[1])));
    program.uniforms = program.shaders.flatMap(shader =>
      [...shader.source.matchAll(/uniform\s+(?:\w+p\s+)?(\w+)\s+(\w+)(?:\[(\d+)\])?;/g)].map(([, type, name, size]) => ({
        name, size: Number(size ?? 1), values: new Array(Number(size ?? 1)).fill(0),
        type: type === "samplerCube" ? 0x8b60 : type === "sampler2D" || defined.has(type) ? SAMPLER_2D : 0x8b52,
      })));
  }
  getProgramParameter(program: Program, pname: number) {
    if (pname === 0x8b82) return program.linked;
    if (pname === 0x8b83) return !!program.validated;
    if (pname === 0x8b86) return program.uniforms.length;
    return 0;
  }
  validateProgram(program: Program) { program.validated = true; }
  getActiveUniform(program: Program, i: number) {
    const u = program.uniforms[i];
    return u ? { name: u.size > 1 ? `${u.name}[0]` : u.name, size: u.size, type: u.type } : null;
  }
  getUniformLocation(program: Program, name: string) {
    const [, base, index] = /^(\w+)(?:\[(\d+)\])?$/.exec(name) ?? [];
    const u = program.uniforms.find(uniform => uniform.name === base);
    return u ? { u, index: Number(index ?? 0) } : null;
  }
  getUniform(_program: Program, location: { u: Uniform; index: number }) { return location.u.values[location.index]; }
  useProgram(program: Program | null) { this.current = program; }
  getProgramInfoLog() { return ""; }
  getShaderInfoLog() { return ""; }
  bindBuffer() {}
  vertexAttribPointer() {}
  enableVertexAttribArray() {}
  drawArrays() {
    this.draws.push(Array.from({ length: 4 }, (_, unit) => this.units[unit]?.content ?? null));
  }
}

function setup() {
  const gl = new ExternalGl();
  const proxy = new Proxy(gl, {
    get(target, key: string) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { gl.calls.set(key, (gl.calls.get(key) ?? 0) + 1); return value.apply(target, args); };
    },
  });
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 65536 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(65536);
  b.gl = proxy as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], text = "") => {
    const bytes = new TextEncoder().encode(text);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const query = (op: number, words: number[], size = 4) => {
    const out = new Uint8Array(size + 8);
    runGlQuery(b, op, new Uint8Array(new Uint32Array(words).buffer), out);
    return new DataView(out.buffer);
  };
  const error = () => {
    const out = new Uint8Array(4);
    expect(runGlQuery(b, O.QOP_GET_ERROR, new Uint8Array(), out)).toBe(4);
    return new DataView(out.buffer).getUint32(0, true);
  };
  const program = (name: number, fragment: string) => {
    const vertex = "attribute vec2 pos;\nvoid main() { gl_Position = vec4(pos, 0.0, 1.0); }\n";
    send(O.OP_CREATE_SHADER, [0x8b31, name + 1]);
    send(O.OP_CREATE_SHADER, [0x8b30, name + 2]);
    send(O.OP_SHADER_SOURCE, [name + 1, vertex.length], vertex);
    send(O.OP_SHADER_SOURCE, [name + 2, fragment.length], fragment);
    send(O.OP_COMPILE_SHADER, [name + 1]);
    send(O.OP_COMPILE_SHADER, [name + 2]);
    send(O.OP_CREATE_PROGRAM, [name]);
    send(O.OP_ATTACH_SHADER, [name, name + 1]);
    send(O.OP_ATTACH_SHADER, [name, name + 2]);
    send(O.OP_LINK_PROGRAM, [name]);
    send(O.OP_USE_PROGRAM, [name]);
    return b.programs.get(name) as unknown as Program;
  };
  /** Uniform1i on the installed program's sampler, as the encoder does. */
  const sampler = (uniform: string, unit: number, element = 0) => {
    const u = (b.currentProgram as unknown as Program).uniforms.find(entry => entry.name === uniform)!;
    u.values[element] = unit;
    noteSamplerWrite(b.currentProgram);
  };
  const bind = (unit: number, target: number, name: number) => {
    send(O.OP_ACTIVE_TEXTURE, [0x84c0 + unit]);
    send(O.OP_BIND_TEXTURE, [target, name]);
  };
  return { gl, b, send, query, error, program, sampler, bind };
}

const externalFragment = "#extension GL_OES_EGL_image_external : require\nprecision mediump float;\n" +
  "uniform samplerExternalOES uVideo;\nuniform sampler2D uOverlay;\n" +
  "void main() { gl_FragColor = texture2D(uVideo, vec2(0.5)) + texture2D(uOverlay, vec2(0.5)); }\n";

describe("samplerExternalOES shader sources", () => {
  it("defines the type only where the shader enables the extension, keeping its lines", async () => {
    const { text, samplers } = await externalShaderSource(externalFragment);
    expect(text).toContain("#define kandelo_samplerExternalOES sampler2D\n");
    expect(text).toContain("uniform kandelo_samplerExternalOES uVideo;");
    expect(text).not.toMatch(/#extension GL_OES_EGL_image_external/);
    expect(samplers).toEqual(["uVideo"]);
    // The guest's line 3 is still line 3 after the macro definition.
    expect(text.split("\n").filter(line => !/^#(define GL_OES_EGL_image_external 1|line)/.test(line)))
      .toEqual(externalFragment.split("\n").map(line =>
        line.replace("#extension GL_OES_EGL_image_external : require", "#define kandelo_samplerExternalOES sampler2D")
          .replace("samplerExternalOES uVideo", "kandelo_samplerExternalOES uVideo")));
    // disable leaves the type undefined; no directive leaves it undefined.
    const disabled = await externalShaderSource(externalFragment.replace(": require", ": disable"));
    expect(disabled.text).toContain("#undef kandelo_samplerExternalOES\n");
    expect((await externalShaderSource("uniform samplerExternalOES s;\n")).text).not.toContain("sampler2D");
    // The extension's macro is defined, after #version 100.
    const versioned = (await externalShaderSource("#version 100\n#ifdef GL_OES_EGL_image_external\n#endif\n")).text;
    expect(versioned).toBe("#version 100\n#define GL_OES_EGL_image_external 1\n#line 2\n#ifdef GL_OES_EGL_image_external\n#endif\n");
    // Sources that never name the extension compile unchanged.
    expect((await externalShaderSource("void main() {}\n")).text).toBe("void main() {}\n");
  });

  it("finds external samplers in arrays, structs and macro-named types", async () => {
    const source = "#extension GL_OES_EGL_image_external : enable\n#define EXT samplerExternalOES\n" +
      "struct Layer { mediump samplerExternalOES image; float alpha; };\n" +
      "struct Stack { Layer top; Layer layers[2]; };\n" +
      "uniform samplerExternalOES frames[3];\nuniform EXT aliased;\nuniform Stack stack;\n" +
      "uniform struct { samplerExternalOES y; sampler2D plain; } inline;\nuniform sampler2D other;\n";
    expect((await externalShaderSource(source)).samplers.sort())
      .toEqual(["aliased", "frames", "inline.y", "stack.layers.image", "stack.top.image"]);
  });
});

it("keeps an external sampler resolvable when a depth texture shares the program", async () => {
  const { depthSamplingShaderSource } = await import("../src/webgl/depth-sampling.js");
  const { text } = await externalShaderSource(externalFragment.replace("uOverlay", "uDepth").replace("uOverlay", "uDepth"));
  const variant = depthSamplingShaderSource(text, new Set(["uDepth"]));
  expect(variant).not.toBeNull();
  // Only the depth sampler's lookup is wrapped.
  expect(variant).toContain("kandelo_depth_texel(true, texture2D(uDepth");
  expect(variant).not.toContain("kandelo_depth_texel(true, texture2D(uVideo");
});

describe("samplerExternalOES misuse", () => {
  const header = "#extension GL_OES_EGL_image_external : require\n#extension GL_EXT_shader_texture_lod : enable\n" +
    "precision mediump float;\nuniform samplerExternalOES uVideo;\nuniform samplerExternalOES frames[2];\n" +
    "struct Layer { samplerExternalOES image; };\nuniform Layer layer;\nuniform sampler2D uPlain;\nvarying vec2 uv;\n";
  const rewrite = async (body: string) => (await externalShaderSource(header + body)).text;

  it("fails the compile of a lookup the extension does not define, naming it", async () => {
    // Every lookup samplerExternalOES has no overload for is an undeclared
    // function after the rewrite, which the compiler reports by name.
    for (const [call, name] of [
      ["texture2DLodEXT(uVideo, uv, 0.0)", "texture2DLodEXT"],
      ["texture2DGradEXT(frames[1], uv, uv, uv)", "texture2DGradEXT"],
      ["texture2DProjLodEXT(layer.image, vec3(uv, 1.0), 0.0)", "texture2DProjLodEXT"],
      ["texture2D(uVideo, uv, 1.0)", "texture2D_with_bias"],
      ["textureCube(uVideo, vec3(uv, 1.0))", "textureCube"],
    ]) {
      const text = await rewrite(`void main() { gl_FragColor = ${call}; }\n`);
      expect(text, call).toContain(`samplerExternalOES_cannot_use_${name}(`);
    }
    // The extension's own lookups, and other samplers' lookups, are left alone.
    const ok = await rewrite("void main() { gl_FragColor = texture2D(uVideo, uv) + texture2DProj(frames[0], vec3(uv, 1.0))" +
      " + texture2DLodEXT(uPlain, uv, 0.0) + texture2D(uPlain, uv, 1.0); }\n");
    expect(ok).not.toContain("samplerExternalOES_cannot_use");
  });

  it("follows external samplers through function parameters", async () => {
    const through = await rewrite("vec4 grad(samplerExternalOES s, vec2 p) { return texture2DGradEXT(s, p, p, p); }\n" +
      "vec4 plain(samplerExternalOES s, vec2 p) { return texture2D(s, p); }\n" +
      "void main() { gl_FragColor = grad(uVideo, uv) + plain(uVideo, uv); }\n");
    expect(through).toContain("return samplerExternalOES_cannot_use_texture2DGradEXT(s, p, p, p)");
    expect(through).toContain("return texture2D(s, p)");
    // An external sampler given to a sampler2D parameter, and the reverse.
    const mismatch = await rewrite("vec4 f(sampler2D s) { return texture2D(s, uv); }\n" +
      "vec4 g(samplerExternalOES s) { return texture2D(s, uv); }\n" +
      "void main() { gl_FragColor = f(uVideo) + g(uPlain) + f(uPlain) + g(layer.image); }\n");
    expect(mismatch).toContain("samplerExternalOES_argument_mismatch_f(uVideo)");
    expect(mismatch).toContain("samplerExternalOES_argument_mismatch_g(uPlain)");
    expect(mismatch).toContain(" f(uPlain)");
    expect(mismatch).toContain(" g(layer.image)");
  });

  it("keeps overloads that differ only between sampler2D and samplerExternalOES apart", async () => {
    const text = await rewrite("vec4 h(sampler2D s, vec2 p);\n" +
      "vec4 h(sampler2D s, vec2 p) { return texture2D(s, p); }\n" +
      "vec4 h(samplerExternalOES s, vec2 p) { return texture2D(s, p) * 0.5; }\n" +
      "void main() { gl_FragColor = h(uPlain, uv) + h(uVideo, uv) + h(frames[1], uv); }\n");
    expect(text.match(/vec4 h_kandelo_2n\(/g)).toHaveLength(2);
    expect(text).toContain("vec4 h_kandelo_en(");
    expect(text).toContain("h_kandelo_2n(uPlain, uv) + h_kandelo_en(uVideo, uv) + h_kandelo_en(frames[1], uv)");
  });
});

describe("TEXTURE_EXTERNAL_OES", () => {
  it("binds per unit without a native binding and reports the binding", () => {
    const h = setup();
    h.bind(1, TEX, 5);
    h.bind(1, EXTERNAL, 6);
    expect(h.error()).toBe(0);
    // The unit's native TEXTURE_2D binding is still the 2D texture.
    expect(h.gl.units[1]).toBe(h.b.textures.get(5));
    expect(h.query(O.QOP_GET_INTEGERV, [0x8d67]).getInt32(0, true)).toBe(6);
    expect(h.query(O.QOP_GET_INTEGERV, [0x8069]).getInt32(0, true)).toBe(5);
    // An object keeps the target of its first bind.
    h.send(O.OP_BIND_TEXTURE, [TEX, 6]);
    expect(h.error()).toBe(0x502);
    h.send(O.OP_BIND_TEXTURE, [EXTERNAL, 5]);
    expect(h.error()).toBe(0x502);
    // Deleting the texture binds zero to its external target.
    const out = new Uint8Array(8);
    new DataView(out.buffer).setUint32(0, 1, true); new DataView(out.buffer).setUint32(4, 6, true);
    h.send(O.OP_DELETE_TEXTURES, [1, 6]);
    expect(h.query(O.QOP_GET_INTEGERV, [0x8d67]).getInt32(0, true)).toBe(0);
  });

  it("starts LINEAR/CLAMP_TO_EDGE and accepts only the external parameter values", () => {
    const h = setup();
    h.bind(0, EXTERNAL, 7);
    // Checked replies: a status word, then the value.
    const parameter = (pname: number) => h.query(O.QOP_GET_TEX_PARAMETER, [EXTERNAL, pname]).getInt32(4, true);
    expect([parameter(MIN), parameter(MAG), parameter(WRAP_S), parameter(WRAP_T)]).toEqual([LINEAR, LINEAR, CLAMP, CLAMP]);
    for (const [pname, value] of [[MIN, MIPMAP], [WRAP_S, REPEAT], [WRAP_T, 0x8370], [0x813c, 0]]) {
      h.send(O.OP_TEX_PARAMETERI, [EXTERNAL, pname, value]);
      expect(h.error(), `${pname}=${value}`).toBe(0x500);
    }
    h.send(O.OP_TEX_PARAMETERI, [EXTERNAL, MIN, NEAREST]);
    h.send(O.OP_TEX_PARAMETERI, [EXTERNAL, MAG, NEAREST]);
    expect(h.error()).toBe(0);
    expect([parameter(MIN), parameter(MAG)]).toEqual([NEAREST, NEAREST]);
    // The default external texture (zero) has the same initial state.
    h.send(O.OP_BIND_TEXTURE, [EXTERNAL, 0]);
    expect(parameter(MIN)).toBe(LINEAR);
    // No image call takes the external target.
    h.send(O.OP_GENERATE_MIPMAP, [EXTERNAL]);
    expect(h.error()).toBe(0x500);
  });

  it("samples the unit's external texture through samplerExternalOES, restoring the 2D binding", () => {
    const h = setup();
    const program = h.program(40, externalFragment);
    expect(program.linked).toBe(true);
    h.sampler("uVideo", 1);
    h.sampler("uOverlay", 0);
    h.bind(0, TEX, 5);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0]);
    h.bind(1, TEX, 8);
    h.send(O.OP_TEX_IMAGE_2D, [TEX, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, 0]);
    h.bind(1, EXTERNAL, 6);
    const external = h.b.textures.get(6)! as unknown as Texture;
    h.gl.write(external);
    h.send(O.OP_ACTIVE_TEXTURE, [0x84c0]);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
    const overlay = (h.b.textures.get(5) as unknown as Texture).content;
    expect(h.gl.draws.at(-1)!.slice(0, 2)).toEqual([overlay, external.content]);
    // Unit 1's TEXTURE_2D is the guest's 2D texture again.
    expect(h.gl.units[1]).toBe(h.b.textures.get(8));
    expect(h.gl.active).toBe(0);
    // Reflection names the external sampler's own type.
    const uniforms = [0, 1].map(index => {
      const out = h.query(O.QOP_GET_ACTIVE_UNIFORM, [40, index, 32], 44);
      return [new TextDecoder().decode(new Uint8Array(out.buffer, 12, out.getUint32(0, true))), out.getUint32(8, true)];
    });
    expect(uniforms).toEqual([["uVideo", SAMPLER_EXTERNAL], ["uOverlay", SAMPLER_2D]]);
  });

  it("refuses a draw whose sampler2D and samplerExternalOES share a unit", () => {
    const h = setup();
    h.program(40, externalFragment);
    h.sampler("uVideo", 2);
    h.sampler("uOverlay", 2);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0x502);
    expect(h.gl.draws).toHaveLength(0);
    h.send(O.OP_VALIDATE_PROGRAM, [40]);
    expect(h.query(O.QOP_GET_PROGRAMIV, [40, 0x8b83]).getInt32(0, true)).toBe(0);
    h.sampler("uOverlay", 0);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.error()).toBe(0);
    expect(h.gl.draws).toHaveLength(1);
    h.send(O.OP_VALIDATE_PROGRAM, [40]);
    expect(h.query(O.QOP_GET_PROGRAMIV, [40, 0x8b83]).getInt32(0, true)).toBe(1);
  });

  it("gives an external texture an EGLImage and copies it only after the image is written", () => {
    const h = setup();
    h.program(40, externalFragment);
    h.sampler("uVideo", 0);
    h.sampler("uOverlay", 3);
    // A canonical RGBA image, as an imported dma-buf's mirror is.
    const canonical = h.gl.createTexture();
    h.gl.write(canonical);
    const token = registerImageSource(h.b, 99, canonical as unknown as WebGLTexture, 4, 4);
    h.bind(0, EXTERNAL, 6);
    const state = h.query(O.QOP_BOUND_IMAGE_TARGET, [1, EXTERNAL, token], 8);
    expect([state.getUint32(0, true), state.getUint32(4, true)]).toEqual([0, token]);
    expect(h.error()).toBe(0);
    for (let i = 0; i < 3; i++) h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.draws.map(draw => draw[0])).toEqual([canonical.content, canonical.content, canonical.content]);
    const copies = h.gl.calls.get("copyTexSubImage2D") ?? 0;
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.calls.get("copyTexSubImage2D") ?? 0).toBe(copies);
    h.gl.write(canonical);
    noteStorageWrite(canonical);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect(h.gl.calls.get("copyTexSubImage2D")).toBe(copies + 1);
    expect(h.gl.draws.at(-1)![0]).toBe(canonical.content);
    // The 2D unit 0 binding (none) is restored after each draw.
    expect(h.gl.units[0]).toBeNull();
  });

  it("costs a program without external samplers no native work", () => {
    const h = setup();
    h.program(40, "precision mediump float;\nuniform sampler2D uTex;\nvoid main() { gl_FragColor = texture2D(uTex, vec2(0.5)); }\n");
    h.bind(0, EXTERNAL, 6);
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    h.gl.calls.clear();
    h.send(O.OP_DRAW_ARRAYS, [5, 0, 4]);
    expect([...h.gl.calls.keys()].sort()).toEqual(["drawArrays"]);
  });
});
