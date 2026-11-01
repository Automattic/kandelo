/**
 * Real-compiler check of the host's private GLSL rewrites (browser side).
 *
 * The host rewrites guest GLSL ES 1.00 shaders for three ES 2.0 behaviours
 * WebGL 2 lacks: reversed depth ranges (reversed-depth.ts), attribute
 * aliasing (attribute-aliasing.ts) and luminance sampling of depth textures
 * (depth-sampling.ts). Unit tests only see the text. This page compiles and
 * links the rewritten shaders with the engine's real WebGL 2 compiler and
 * draws with them, reading back pixels to prove the ES 2.0 semantics.
 * It is bundled and driven by run.mjs; it is not the Kandelo runtime.
 */
import { aliasedVertexShaderSource } from "../../../host/src/webgl/attribute-aliasing.js";
import { variantStageSource, type VariantOptions } from "../../../host/src/webgl/reversed-depth.js";

/** "inconclusive": the engine fails the same check on unrewritten shaders
 * (a recorded "engine-defect" control), so it cannot judge the rewrite. */
type Status = "pass" | "fail" | "inconclusive" | "engine-defect";
type Result = { name: string; ok: boolean; status: Status; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail = "", status: Status = ok ? "pass" : "fail"): void {
  results.push({ name, ok: status !== "fail", status, detail });
}

const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const gl = canvas.getContext("webgl2", { antialias: false, depth: false })!;

// ---------------------------------------------------------------------------
// GL helpers

type Built = { program: WebGLProgram | null; log: string };
function build(vertex: string, fragment: string, bindings: Iterable<[string, number]> = []): Built {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source); gl.compileShader(s);
    return s;
  };
  const v = shader(gl.VERTEX_SHADER, vertex), f = shader(gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram()!;
  gl.attachShader(program, v); gl.attachShader(program, f);
  for (const [name, at] of bindings) gl.bindAttribLocation(program, at, name);
  gl.linkProgram(program);
  const ok = gl.getProgramParameter(program, gl.LINK_STATUS);
  const log = [gl.getShaderInfoLog(v), gl.getShaderInfoLog(f), gl.getProgramInfoLog(program)].filter(Boolean).join(" | ");
  gl.deleteShader(v); gl.deleteShader(f);
  if (!ok) { gl.deleteProgram(program); return { program: null, log }; }
  return { program, log };
}

/** A 1x1 RGBA8 target, optionally with a depth renderbuffer. */
function target(depth: boolean): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const color = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  if (depth) {
    const rb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.viewport(0, 0, 1, 1);
  return fbo;
}

function pixel(): number[] {
  const out = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return [...out].map(x => x / 255);
}
const near = (a: number[], b: number[], tolerance = 1.5 / 255) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tolerance);
const fmt = (a: number[]) => `[${a.map(x => x.toFixed(4)).join(", ")}]`;

/** Draw one point at the centre with `program` (clip z from u_z when used). */
function drawPoint(program: WebGLProgram, uniforms: Record<string, number> = {}): void {
  gl.useProgram(program);
  for (const [name, value] of Object.entries(uniforms)) {
    const location = gl.getUniformLocation(program, name);
    if (location) gl.uniform1f(location, value);
  }
  gl.drawArrays(gl.POINTS, 0, 1);
}

// ---------------------------------------------------------------------------
// 1. Attribute aliasing: the dEQP-GLES2 attribute_location templates

const TYPES: Record<string, { slots: number; rows: number }> = {
  float: { slots: 1, rows: 1 }, vec2: { slots: 1, rows: 2 }, vec3: { slots: 1, rows: 3 }, vec4: { slots: 1, rows: 4 },
  mat2: { slots: 2, rows: 2 }, mat3: { slots: 3, rows: 3 }, mat4: { slots: 4, rows: 4 },
};
type Cond = "always" | "never" | "A" | "!A";
type DeqpAttribute = { type: string; name: string; cond: Cond };

/** modules/glshared/glsAttributeLocationTests.cpp generateVertexShaderTemplate()
 * specialized for GLSL ES 1.00, which dEQP forces whenever bindings alias. */
function deqpVertexShader(attributes: DeqpAttribute[]): string {
  const toVec4 = (a: DeqpAttribute) =>
    a.type === "vec2" ? `vec4(${a.name}.xy, ${a.name}.yx)` : a.type === "vec3" ? `vec4(${a.name}.xyz, ${a.name}.x)` : `vec4(${a.name})`;
  let src = "#version 100\nvarying mediump vec4 v_color;\n";
  for (const a of attributes) src += `attribute mediump ${a.type} ${a.name};\n`;
  const conditions = new Set(attributes.filter(a => a.cond === "A" || a.cond === "!A").map(() => "A"));
  src += "\n" + [...conditions].map(c => `uniform mediump float u_${c};\n`).join("") + "\n";
  src += "void main (void)\n{\n\tmediump vec4 color = vec4(0.0);\n\n";
  for (const a of attributes) {
    if (a.cond === "always") src += `\tcolor += ${toVec4(a)};\n`;
    else src += `\tif (${a.cond === "never" ? "0 != 0" : `u_A ${a.cond === "A" ? "!=" : "=="} 0.0`})\n\t{\n\t\tcolor += ${toVec4(a)};\n\t}\n`;
  }
  return src + "\n\tv_color = color;\n\tgl_Position = color;\n}\n";
}
const DEQP_FRAGMENT = "#version 100\n\nvarying mediump vec4 v_color;\nvoid main (void)\n{\n\tgl_FragColor = v_color;\n}\n";

/** Link the host's aliasing executable for a source and guest bindings. */
function buildAliased(vertex: string, fragment: string, bindings: Map<string, number>): Built & { source?: string } {
  const rewrite = aliasedVertexShaderSource(vertex, bindings);
  if (!rewrite) return { program: null, log: "no aliasing rewrite" };
  const native: [string, number][] = [...bindings].filter(([n]) => !rewrite.aliased.has(n));
  for (const l of rewrite.slots) native.push([`kandelo_alias_${l}`, l]);
  return { ...build(rewrite.source, fragment, native), source: rewrite.source };
}

function deqpAliasingCases(maxAttributes: number): void {
  const cases: [string, DeqpAttribute[], [string, number][]][] = [];
  for (const type of Object.keys(TYPES)) {
    const slots = TYPES[type].slots;
    const cond = (offset: number): [DeqpAttribute[], [string, number][]] => [
      [{ type, name: "a_0", cond: "A" }, { type: "vec4", name: "a_1", cond: "!A" }], [["a_0", 1], ["a_1", 1 + offset]]];
    cases.push([`cond_${type}`, ...cond(0)]);
    if (slots > 1) cases.push([`cond_${type}_offset_1`, ...cond(1)]);
    for (const [prefix, second] of [["max_cond", "!A"], ["max_inactive", "never"]] as const) {
      const attributes: DeqpAttribute[] = [], bindings: [string, number][] = [];
      let ndx = 0;
      for (let at = maxAttributes - slots; at >= 0; at -= slots, ndx++) {
        attributes.push({ type, name: `a_${ndx}`, cond: prefix === "max_cond" ? "A" : "A" },
          { type, name: `a_${ndx + maxAttributes}`, cond: second });
        bindings.push([`a_${ndx}`, at], [`a_${ndx + maxAttributes}`, at]);
      }
      cases.push([`${prefix}_${type}`, attributes, bindings]);
    }
  }
  for (const [name, attributes, bindings] of cases) {
    const vertex = deqpVertexShader(attributes);
    const original = build(vertex, DEQP_FRAGMENT, bindings);
    if (original.program) {
      // WebGL accepted it (e.g. an inactive alias): the host never rewrites.
      gl.deleteProgram(original.program);
      record(`aliasing.deqp.${name}`, true, "native link succeeded; no rewrite needed");
      continue;
    }
    const aliased = buildAliased(vertex, DEQP_FRAGMENT, new Map(bindings));
    record(`aliasing.deqp.${name}`, !!aliased.program, aliased.program ? `native: ${original.log}` : `rewrite failed: ${aliased.log}`);
    if (aliased.program) gl.deleteProgram(aliased.program);
  }
}

/** Generic attribute L holds components (20 + 50k + 10(L mod 5)) / 255: for
 * the locations the semantic checks read (1..4) every component of every
 * location differs from every other by at least 10/255, far beyond the
 * readback tolerance, so a swapped component or location cannot pass. */
function genericValue(location: number): number[] {
  return [0, 1, 2, 3].map(k => (20 + 50 * k + 10 * (location % 5)) / 255);
}

/** Each branch of an aliased pair reads its own components of the shared
 * generic attributes: a_0 (type, column c) at 1, a_1 (vec4) at 1 + offset. */
function aliasingSemantics(maxAttributes: number): void {
  for (let l = 0; l < maxAttributes; l++) gl.vertexAttrib4f(l, ...(genericValue(l) as [number, number, number, number]));
  target(false);
  const fragment = "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n";
  for (const type of Object.keys(TYPES)) {
    const { slots, rows } = TYPES[type];
    for (const offset of slots > 1 ? [0, 1] : [0]) for (let column = 0; column < slots; column++) {
      const read = slots > 1 ? `a_0[${column}]` : "a_0";
      const pad = [", 0.0, 0.0, 1.0", ", 0.0, 1.0", ", 1.0", ""][rows - 1];
      const vertex = `attribute mediump ${type} a_0;\nattribute mediump vec4 a_1;\nuniform float u_A;\nvarying mediump vec4 v;\n` +
        `void main() {\n  if (u_A != 0.0) v = vec4(${read}${pad});\n  else v = a_1;\n` +
        "  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);\n  gl_PointSize = 1.0;\n}\n";
      const built = buildAliased(vertex, fragment, new Map([["a_0", 1], ["a_1", 1 + offset]]));
      const name = `aliasing.semantics.${type}${offset ? "_offset_1" : ""}.column${column}`;
      if (!built.program) { record(name, false, built.log); continue; }
      const expectA0 = [...genericValue(1 + column).slice(0, rows), ...[0, 0, 0, 1].slice(rows)];
      drawPoint(built.program, { u_A: 1 });
      const got0 = pixel();
      drawPoint(built.program, { u_A: 0 });
      const got1 = pixel(), expectA1 = genericValue(1 + offset);
      record(name, near(got0, expectA0) && near(got1, expectA1),
        `a_0 ${fmt(got0)} want ${fmt(expectA0)}; a_1 ${fmt(got1)} want ${fmt(expectA1)}`);
      gl.deleteProgram(built.program);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Reversed depth range

/** Logical (n, f) with n > f is installed natively as (f, n); the twin's
 * vertex shader negates clip z. ES 2.0: z_w = ((f - n) / 2) z_d + (n + f) / 2. */
function reversedDepth(): void {
  target(true);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  const n = 0.75, f = 0.25;
  const options: VariantOptions = { reversedDepth: true, depthSamplers: [] };
  const vertex = "uniform float u_z;\nvarying mediump vec4 v_range;\n" +
    "void main() { gl_Position = vec4(0.0, 0.0, u_z, 1.0); gl_PointSize = 1.0;\n" +
    "  v_range = vec4(gl_DepthRange.near, gl_DepthRange.far, -gl_DepthRange.diff, 1.0); }\n";
  const fragment = "precision highp float;\nvarying mediump vec4 v_range;\nuniform float u_mode;\n" +
    "void main() { gl_FragColor = u_mode == 0.0 ? vec4(gl_FragCoord.z, 0.0, 0.0, 1.0)\n" +
    "  : u_mode == 1.0 ? vec4(gl_DepthRange.near, gl_DepthRange.far, -gl_DepthRange.diff, 1.0) : v_range; }\n";
  const vs = variantStageSource(vertex, true, options), fs = variantStageSource(fragment, false, options);
  const built = vs && fs ? build(vs, fs) : { program: null, log: "no variant" };
  record("reversed-depth.link", !!built.program, built.log);
  if (!built.program) { gl.disable(gl.DEPTH_TEST); return; }
  gl.depthRange(f, n); // the host's native ordered pair
  for (const zc of [-0.8, -0.2, 0.0, 0.6, 0.9]) {
    const expected = ((f - n) / 2) * zc + (n + f) / 2;
    // Depth test against cleared depth: passes iff z_w < clear value.
    const passes = (clearDepth: number) => {
      gl.clearDepth(clearDepth); gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawPoint(built.program!, { u_z: zc, u_mode: 0 });
      return pixel()[3] > 0.5;
    };
    const above = passes(expected + 0.004), below = passes(expected - 0.004);
    gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawPoint(built.program, { u_z: zc, u_mode: 0 });
    const fragZ = pixel()[0];
    record(`reversed-depth.window-z.zc=${zc}`, above && !below && Math.abs(fragZ - expected) <= 1.5 / 255,
      `expected z_w ${expected.toFixed(4)}; passes below+0.004 ${above}, below-0.004 ${below}; gl_FragCoord.z ${fragZ.toFixed(4)}`);
  }
  gl.disable(gl.DEPTH_TEST);
  // Control: the same unrewritten program under an ordered native range.
  // Some engines lose the vertex stage's gl_DepthRange when the fragment
  // stage also reads it alongside another uniform; that is not the rewrite.
  const control = build(vertex, fragment);
  let vertexControl = true;
  if (control.program) {
    gl.depthRange(0.25, 0.75);
    drawPoint(control.program, { u_z: 0, u_mode: 2 });
    const got = pixel(), want = [0.25, 0.75, 0, 1];
    vertexControl = near(got, want);
    record("reversed-depth.gl_DepthRange.vertex.native-control", vertexControl,
      `unrewritten, ordered range: ${fmt(got)} want ${fmt(want)}`, vertexControl ? "pass" : "engine-defect");
    gl.deleteProgram(control.program);
    gl.depthRange(f, n);
  }
  for (const [mode, stage] of [[1, "fragment"], [2, "vertex"]] as const) {
    drawPoint(built.program, { u_z: 0, u_mode: mode });
    const got = pixel(), want = [n, f, n - f, 1], ok = near(got, want);
    record(`reversed-depth.gl_DepthRange.${stage}`, ok, `${fmt(got)} want ${fmt(want)} (near, far, -diff)`,
      ok ? "pass" : stage === "vertex" && !vertexControl ? "inconclusive" : "fail");
  }
  gl.deleteProgram(built.program);
  // The vertex stage alone (the fragment stage does not read gl_DepthRange).
  const vertexOnly = variantStageSource(vertex, true, options);
  const plain = build(vertexOnly!, "precision mediump float;\nvarying mediump vec4 v_range;\nvoid main() { gl_FragColor = v_range; }\n");
  if (!plain.program) record("reversed-depth.gl_DepthRange.vertex-only", false, plain.log);
  else {
    drawPoint(plain.program, { u_z: 0 });
    const got = pixel(), want = [n, f, n - f, 1];
    record("reversed-depth.gl_DepthRange.vertex-only", near(got, want), `${fmt(got)} want ${fmt(want)} (near, far, -diff)`);
    gl.deleteProgram(plain.program);
  }
  gl.depthRange(0, 1);
}

// ---------------------------------------------------------------------------
// 3. Depth textures sample as (d, d, d, 1)

function depthTexture(unit: number, stencil: boolean): number {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  if (stencil) {
    const d = 0x600000; // 24-bit depth in the high bits of UNSIGNED_INT_24_8
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH24_STENCIL8, 1, 1, 0, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, new Uint32Array([d << 8 | 0x5a]));
    return d / 0xffffff;
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, new Uint16Array([0x6000]));
  return 0x6000 / 0xffff;
}
function colorTexture(unit: number, rgba: number[]): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.map(x => Math.round(x * 255))));
}

const POINT_VERTEX = "void main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n";
type SamplingCase = { name: string; vertex: string; fragment: string; units: Record<string, number>;
  depth: string[]; expected: (d: number) => number[]; reversed?: boolean; aliasBindings?: Map<string, number> };

function depthSampling(): void {
  target(false);
  const color = [0.2, 0.4, 0.6, 0.8];
  const cases: SamplingCase[] = [
    { name: "uniform", vertex: POINT_VERTEX, units: { d: 1 }, depth: ["d"],
      fragment: "precision mediump float;\nuniform sampler2D d;\nvoid main() { gl_FragColor = texture2D(d, vec2(0.5)); }\n",
      expected: d => [d, d, d, 1] },
    { name: "proj-and-bias", vertex: POINT_VERTEX, units: { d: 1 }, depth: ["d"],
      fragment: "precision mediump float;\nuniform sampler2D d;\n" +
        "void main() { gl_FragColor = 0.5 * texture2DProj(d, vec3(1.0, 1.0, 2.0)) + 0.5 * texture2D(d, vec2(0.5), 0.0); }\n",
      expected: d => [d, d, d, 1] },
    { name: "mixed-with-color", vertex: POINT_VERTEX, units: { d: 1, c: 2 }, depth: ["d"],
      fragment: "precision mediump float;\nuniform sampler2D d, c;\n" +
        "void main() { gl_FragColor = 0.5 * texture2D(d, vec2(0.5)) + 0.5 * texture2D(c, vec2(0.5)); }\n",
      expected: d => [0.5 * d + 0.1, 0.5 * d + 0.2, 0.5 * d + 0.3, 0.9] },
    { name: "array-loop", vertex: POINT_VERTEX, units: { "s[0]": 2, "s[1]": 1 }, depth: ["s[1]"],
      fragment: "precision mediump float;\nuniform sampler2D s[2];\n" +
        "void main() { vec4 sum = vec4(0.0); for (int i = 0; i < 2; i++) sum += 0.5 * texture2D(s[i], vec2(0.5)); gl_FragColor = sum; }\n",
      expected: d => [0.5 * d + 0.1, 0.5 * d + 0.2, 0.5 * d + 0.3, 0.9] },
    { name: "function-parameter", vertex: POINT_VERTEX, units: { d: 1, c: 2 }, depth: ["d"],
      fragment: "precision mediump float;\nuniform sampler2D d, c;\n" +
        "vec4 look(sampler2D t, vec2 at);\n" +
        "vec4 halve(vec2 at, sampler2D t) { return 0.5 * look(t, at); }\n" +
        "vec4 look(sampler2D t, vec2 at) { return texture2D(t, at); }\n" +
        "void main() { gl_FragColor = halve(vec2(0.5), d) + halve(vec2(0.5), c); }\n",
      expected: d => [0.5 * d + 0.1, 0.5 * d + 0.2, 0.5 * d + 0.3, 0.9] },
    { name: "vertex-lod", depth: ["h"], units: { h: 1 },
      vertex: "uniform sampler2D h;\nvarying vec4 v;\n" +
        "void main() { v = texture2DLod(h, vec2(0.5), 0.0) + 0.0 * texture2DProjLod(h, vec3(0.5, 0.5, 1.0), 0.0);\n" +
        "  gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
      fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n",
      expected: d => [d, d, d, 1] },
  ];
  // Combinations: the same variant composition the draw path uses.
  cases.push({ ...cases[4], name: "function-parameter+reversed-depth", reversed: true });
  cases.push({ name: "aliasing+depth-sampler", depth: ["d"], units: { d: 1 },
    aliasBindings: new Map([["a_0", 3], ["a_1", 3]]),
    vertex: "attribute mediump vec2 a_0;\nattribute mediump vec4 a_1;\nuniform float u_A;\nuniform sampler2D d;\nvarying vec4 v;\n" +
      "void main() { v = (u_A != 0.0 ? vec4(a_0, 0.0, 0.0) : a_1) * 0.0 + texture2DLod(d, vec2(0.5), 0.0);\n" +
      "  gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
    fragment: "precision mediump float;\nvarying vec4 v;\nuniform sampler2D d;\n" +
      "void main() { gl_FragColor = 0.5 * v + 0.5 * texture2D(d, vec2(0.5)); }\n",
    expected: d => [d, d, d, 1] });
  cases.push({ ...cases[cases.length - 1], name: "aliasing+depth-sampler+reversed-depth", reversed: true });

  for (const stencil of [false, true]) {
    const d = depthTexture(1, stencil);
    colorTexture(2, color);
    for (const c of cases) {
      const name = `depth-sampling.${stencil ? "depth-stencil" : "depth"}.${c.name}`;
      const options: VariantOptions = { reversedDepth: !!c.reversed, depthSamplers: c.depth };
      let vertex = c.vertex, bindings: [string, number][] = [];
      if (c.aliasBindings) {
        const rewrite = aliasedVertexShaderSource(vertex, c.aliasBindings);
        if (!rewrite) { record(name, false, "no aliasing rewrite"); continue; }
        vertex = rewrite.source;
        bindings = rewrite.slots.map(l => [`kandelo_alias_${l}`, l]);
      }
      const vs = variantStageSource(vertex, true, options), fs = variantStageSource(c.fragment, false, options);
      const built = vs && fs ? build(vs, fs, bindings) : { program: null, log: "no variant" };
      if (!built.program) { record(name, false, built.log); continue; }
      gl.useProgram(built.program);
      for (const [uniform, unit] of Object.entries(c.units)) gl.uniform1i(gl.getUniformLocation(built.program, uniform), unit);
      if (c.reversed) gl.depthRange(0, 1);
      drawPoint(built.program, { u_A: 1 });
      const got = pixel(), want = c.expected(d);
      record(name, near(got, want, 2.5 / 255), `${fmt(got)} want ${fmt(want)}`);
      gl.deleteProgram(built.program);
    }
    const control = build(POINT_VERTEX, cases[0].fragment);
    if (control.program) {
      gl.useProgram(control.program);
      gl.uniform1i(gl.getUniformLocation(control.program, "d"), 1);
      drawPoint(control.program);
      // The unmodified guest program sees WebGL's (d, 0, 0, 1).
      const got = pixel();
      record(`depth-sampling.${stencil ? "depth-stencil" : "depth"}.control-unrewritten`, near(got, [d, 0, 0, 1], 2.5 / 255),
        `native sample ${fmt(got)} (WebGL 2 / ES 3.0 returns (d, 0, 0, 1))`);
      gl.deleteProgram(control.program);
    }
  }
}

// ---------------------------------------------------------------------------

(window as unknown as { runShaderRewriteChecks: () => unknown }).runShaderRewriteChecks = () => {
  if (!gl) return { renderer: "no WebGL 2", results: [{ name: "webgl2", ok: false, status: "fail", detail: "getContext('webgl2') failed" }] };
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const maxAttributes = Number(gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
  for (const check of [() => deqpAliasingCases(maxAttributes), () => aliasingSemantics(maxAttributes), reversedDepth, depthSampling]) {
    try { check(); } catch (error) { record(`exception.${check.name}`, false, String(error)); }
    const error = gl.getError();
    if (error) record(`gl-error.after.${check.name || "check"}`, false, `0x${error.toString(16)}`);
  }
  return { renderer, maxAttributes, results };
};
