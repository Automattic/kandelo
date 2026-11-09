/**
 * Real-compiler check of the host's private GLSL rewrites (browser side).
 *
 * The host rewrites guest GLSL ES 1.00 shaders for three ES 2.0 behaviours
 * WebGL 2 lacks: reversed depth ranges (reversed-depth.ts), attribute
 * aliasing (attribute-aliasing.ts), luminance sampling of depth textures
 * (depth-sampling.ts) and samplerExternalOES (external-texture.ts), and
 * rewrites the GLSL ES 1.00 built-in limit constants to the values the
 * guest queries (limits.ts), and compiles ES 1.00 shaders that WebGL rejects
 * only for GLSL ES 1.00 Appendix A as ESSL 3.00 (essl3-translation.ts).
 * Unit tests only see the text. This page compiles and
 * links the rewritten shaders with the engine's real WebGL 2 compiler and
 * draws with them, reading back pixels to prove the ES 2.0 semantics.
 * It is bundled and driven by run.mjs; it is not the Kandelo runtime.
 */
import { aliasedVertexShaderSource } from "../../../host/src/webgl/attribute-aliasing.js";
import { variantStageSource, type VariantOptions } from "../../../host/src/webgl/reversed-depth.js";
import { NATIVE_DEPTH_RANGE_UNIFORM, nativeDepthRangeValues } from "../../../host/src/webgl/vertex-depth-range.js";
import { externalShaderSource } from "../../../host/src/webgl/external-texture.js";
import { builtinLimitShaderSource, guestBuiltinLimits } from "../../../host/src/webgl/limits.js";
import { compileGuestShader, compatibleShaderSource, nativeInterfaceName, prepareLinkLanguages, programNativeName, recordProgramLanguage,
  recordShaderLanguage, standardDerivativesShaderSource, translateEssl100, type ShaderLanguage } from "../../../host/src/webgl/essl3-translation.js";

/** "inconclusive": the engine fails the same check on unrewritten shaders
 * (a recorded "engine-defect" control), so it cannot judge the rewrite. */
type Status = "pass" | "fail" | "inconclusive" | "engine-defect";
type Result = { name: string; ok: boolean; status: Status; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail = "", status: Status = ok ? "pass" : "fail"): void {
  results.push({ name, ok: status !== "fail", status, detail });
  if ((globalThis as { shaderCheckProgress?: boolean }).shaderCheckProgress) console.info(`shader-check: ${name}: ${status}`);
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
  // FIREFOX-VERTEX-DEPTH-RANGE-UNIFORM: the host's variant for that trigger
  // (vertex stage reads a private uniform) must be right on every engine.
  const workaround = { ...options, vertexDepthRange: true };
  const wvs = variantStageSource(vertex, true, workaround), wfs = variantStageSource(fragment, false, workaround);
  const fixed = wvs && wfs ? build(wvs, wfs) : { program: null, log: "no variant" };
  if (!fixed.program) record("reversed-depth.gl_DepthRange.vertex.with-workaround", false, fixed.log);
  else {
    gl.useProgram(fixed.program);
    gl.uniform3f(gl.getUniformLocation(fixed.program, NATIVE_DEPTH_RANGE_UNIFORM), ...nativeDepthRangeValues([n, f]));
    drawPoint(fixed.program, { u_z: 0, u_mode: 2 });
    const got = pixel(), want = [n, f, n - f, 1];
    record("reversed-depth.gl_DepthRange.vertex.with-workaround", near(got, want), `${fmt(got)} want ${fmt(want)} (near, far, -diff)`);
    gl.deleteProgram(fixed.program);
  }
  gl.depthRange(0, 1);
}

/** The reproduction's trigger with an ordered range: both stages read
 * gl_DepthRange and the fragment stage has another uniform. Unrewritten is a
 * control (an engine-defect record on Firefox); the workaround variant must
 * give the vertex stage (0.25, 0.75, 0.5) everywhere. */
function vertexDepthRangeTrigger(): void {
  target(false);
  const vertex = "varying mediump vec4 v;\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0;\n" +
    "  v = vec4(gl_DepthRange.near, gl_DepthRange.far, gl_DepthRange.diff, 1.0); }\n";
  const fragment = "precision mediump float;\nvarying vec4 v;\nuniform float u_other;\n" +
    "void main() { gl_FragColor = u_other > 2.0 ? vec4(gl_DepthRange.near) : v; }\n";
  const want = [0.25, 0.75, 0.5, 1];
  gl.depthRange(0.25, 0.75);
  for (const workaround of [false, true]) {
    const options: VariantOptions = { reversedDepth: false, depthSamplers: [], vertexDepthRange: workaround };
    const vs = variantStageSource(vertex, true, options), fs = variantStageSource(fragment, false, options);
    const built = vs && fs ? build(vs, fs) : { program: null, log: "no variant" };
    const name = `vertex-depth-range.trigger.${workaround ? "with-workaround" : "native-control"}`;
    if (!built.program) { record(name, false, built.log); continue; }
    gl.useProgram(built.program);
    if (workaround) gl.uniform3f(gl.getUniformLocation(built.program, NATIVE_DEPTH_RANGE_UNIFORM), ...nativeDepthRangeValues([0.25, 0.75]));
    drawPoint(built.program, { u_other: 0.5 });
    const got = pixel(), ok = near(got, want);
    record(name, ok, `${fmt(got)} want ${fmt(want)}`, ok ? "pass" : workaround ? "fail" : "engine-defect");
    gl.deleteProgram(built.program);
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
// 4. samplerExternalOES and the GL_OES_EGL_image_external macro

/** wlroots 0.20 render/gles2/shaders/tex_external.frag, verbatim. */
const WLROOTS_TEX_EXTERNAL = "#extension GL_OES_EGL_image_external : require\n\n" +
  "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n\n" +
  "varying vec2 v_texcoord;\nuniform samplerExternalOES texture0;\nuniform float alpha;\n\n" +
  "void main() {\n\tgl_FragColor = texture2D(texture0, v_texcoord) * alpha;\n}\n";
const TEXCOORD_VERTEX = "varying vec2 v_texcoord;\n" +
  "void main() { v_texcoord = vec2(0.5); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n";

function externalSampling(): void {
  target(false);
  const color = [0.2, 0.4, 0.6, 0.8];
  colorTexture(2, color);
  const green = [0, 1, 0, 1];
  const cases: { name: string; vertex: string; fragment: string; expected: number[]; sampler?: string }[] = [
    { name: "wlroots-tex-external", vertex: TEXCOORD_VERTEX, fragment: WLROOTS_TEX_EXTERNAL, expected: color, sampler: "texture0" },
    { name: "macro-ifdef", vertex: POINT_VERTEX, expected: green,
      fragment: "#extension GL_OES_EGL_image_external : enable\nprecision mediump float;\n" +
        "void main() {\n#ifdef GL_OES_EGL_image_external\ngl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);\n" +
        "#else\ngl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);\n#endif\n}\n" },
    { name: "macro-value", vertex: POINT_VERTEX, expected: green,
      fragment: "precision mediump float;\nvoid main() {\n" +
        "#if defined(GL_OES_EGL_image_external) && GL_OES_EGL_image_external == 1\n" +
        "gl_FragColor = vec4(0.0, float(GL_OES_EGL_image_external), 0.0, 1.0);\n" +
        "#else\ngl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);\n#endif\n}\n" },
  ];
  for (const c of cases) {
    const name = `external-sampler.${c.name}`;
    const built = build(c.vertex, externalShaderSource(c.fragment).text);
    if (!built.program) { record(name, false, `rewrite failed to compile/link: ${built.log}`); continue; }
    gl.useProgram(built.program);
    if (c.sampler) gl.uniform1i(gl.getUniformLocation(built.program, c.sampler), 2);
    const alpha = gl.getUniformLocation(built.program, "alpha");
    if (alpha) gl.uniform1f(alpha, 1);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, 1);
    const got = pixel();
    record(name, near(got, c.expected), `got ${fmt(got)}, expected ${fmt(c.expected)}`);
    gl.deleteProgram(built.program);
  }
  // GLSL ES 1.00 section 3.4: a guest redefinition of the reserved macro
  // name is a compile error, not something the rewrite absorbs.
  const redefined = build(POINT_VERTEX, externalShaderSource("#define GL_OES_EGL_image_external 1\n" +
    "precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }\n").text);
  record("external-sampler.guest-redefinition-rejected", !redefined.program, redefined.log || "compiled");
  if (redefined.program) gl.deleteProgram(redefined.program);
}

// ---------------------------------------------------------------------------
// 5. Built-in limit constants equal the guest's queries (limits.ts)

/** dEQP-GLES2.functional.shaders.builtin_variable.max_* compare each
 * built-in with glGetIntegerv in both stages; the guest-visible values are
 * `guestBuiltinLimits`, which the unit tests tie to the query path. Each
 * use form a constant allows is exercised: comparison, array size, const
 * initializer and a #define body. */
function builtinLimits(): void {
  target(false);
  const limits = guestBuiltinLimits({ gl, errors: [] } as unknown as Parameters<typeof guestBuiltinLimits>[0]);
  if (!limits) { record("builtin-limits.values", false, "no limits"); return; }
  const test = (name: string, value: number) =>
    `#define K_DEFINED ${name}\nconst int k_const = ${name};\nuniform mediump vec4 k_array[${name}];\n` +
    `bool k_ok() { return ${name} == ${value} && K_DEFINED == ${value} && k_const == ${value}; }\n`;
  const green = [0, 1, 0, 1];
  for (const [name, value] of limits) for (const stage of ["vertex", "fragment"] as const) {
    const vertex = stage === "vertex"
      ? test(name, value) + "varying mediump vec4 v;\nvoid main() { v = k_ok() ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0); " +
        "gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n"
      : "varying mediump vec4 v;\nvoid main() { v = vec4(0.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n";
    const fragment = stage === "fragment"
      ? "precision mediump float;\n" + test(name, value) + "varying mediump vec4 v;\n" +
        "void main() { gl_FragColor = k_ok() ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0) + v; }\n"
      : "precision mediump float;\nvarying mediump vec4 v;\nvoid main() { gl_FragColor = v; }\n";
    const built = build(builtinLimitShaderSource(vertex, limits), builtinLimitShaderSource(fragment, limits));
    const check = `builtin-limits.${name}.${stage}`;
    if (!built.program) { record(check, false, `rewrite failed to compile/link: ${built.log}`); continue; }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    drawPoint(built.program);
    const got = pixel();
    record(check, near(got, green), `got ${fmt(got)} for guest value ${value}, native ${engineValue(name, stage)}`);
    gl.deleteProgram(built.program);
  }
}

/** The engine's own value of a built-in in one stage (detail only). */
function engineValue(name: string, stage: "vertex" | "fragment"): string {
  const probe = (value: number) => {
    const ok = `${name} >= ${value}`;
    const built = stage === "vertex"
      ? build(`varying mediump vec4 v;\nvoid main() { v = ${ok} ? vec4(1.0) : vec4(0.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n`,
        "precision mediump float;\nvarying mediump vec4 v;\nvoid main() { gl_FragColor = v; }\n")
      : build(POINT_VERTEX, `precision mediump float;\nvoid main() { gl_FragColor = ${ok} ? vec4(1.0) : vec4(0.0); }\n`);
    if (!built.program) return null;
    drawPoint(built.program);
    gl.deleteProgram(built.program);
    return pixel()[0] > 0.5;
  };
  let low = 0, high = 1 << 16;
  while (low < high) {
    const mid = (low + high + 1) >> 1, at = probe(mid);
    if (at === null) return "unknown";
    if (at) low = mid; else high = mid - 1;
  }
  return String(low);
}


// ---------------------------------------------------------------------------
// 6. ES 1.00 shaders beyond Appendix A, compiled as ESSL 3.00
//    (essl3-translation.ts)

type GuestBuilt = Built & { languages: (ShaderLanguage | null)[]; compileLog: string };
/** The host's compile and link path (bridge.ts OP_COMPILE_SHADER and
 * program-objects.ts linkProgramRetainingExecutable), with the guest's
 * attribute bindings by guest name. */
function buildGuest(vertex: string, fragment: string, bindings: Iterable<[string, number]> = []): GuestBuilt {
  const shaders = ([[gl.VERTEX_SHADER, vertex, false], [gl.FRAGMENT_SHADER, fragment, true]] as const).map(([type, source, fragment]) => {
    const shader = gl.createShader(type)!, text = standardDerivativesShaderSource(source);
    const language = compileGuestShader(gl, shader, text, fragment);
    recordShaderLanguage(shader, language, compatibleShaderSource(shader, text), fragment);
    return { shader, language };
  });
  const compileLog = shaders.map(s => gl.getShaderInfoLog(s.shader)).filter(Boolean).join(" | ");
  const program = gl.createProgram()!;
  for (const { shader } of shaders) gl.attachShader(program, shader);
  const translated = prepareLinkLanguages(gl, shaders.map(s => s.shader));
  recordProgramLanguage(program, translated);
  for (const [name, at] of bindings) gl.bindAttribLocation(program, at, translated ? nativeInterfaceName(name) : name);
  gl.linkProgram(program);
  const ok = gl.getProgramParameter(program, gl.LINK_STATUS);
  const log = [compileLog, gl.getProgramInfoLog(program)].filter(Boolean).join(" | ");
  for (const { shader } of shaders) gl.deleteShader(shader);
  const languages = shaders.map(s => s.language);
  if (!ok) { gl.deleteProgram(program); return { program: null, log, languages, compileLog }; }
  return { program, log, languages, compileLog };
}

/** The ES 1.00 compile WebGL performs without the host's path. */
function nativeCompile(source: string, fragment: boolean): { ok: boolean; log: string } {
  const shader = gl.createShader(fragment ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER)!;
  gl.shaderSource(shader, source); gl.compileShader(shader);
  const result = { ok: !!gl.getShaderParameter(shader, gl.COMPILE_STATUS), log: (gl.getShaderInfoLog(shader) ?? "").trim().split("\n")[0] };
  gl.deleteShader(shader);
  return result;
}

const GREEN = [0, 1, 0, 1];
/** A fragment-stage check: green when `ok` (an ES 1.00 bool expression). */
const okFragment = (declarations: string, body: string, ok: string) =>
  `precision mediump float;\n${declarations}\nvoid main() {\n${body}\ngl_FragColor = (${ok}) ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);\n}\n`;
const VARYING_VERTEX = "varying mediump vec4 v;\nvoid main() { v = vec4(0.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n";
/** A loop whose bound is a uniform: Appendix A rejects it, ES 1.00 does not. */
const DYNAMIC_LOOP = "uniform int n;\nfloat dynamicSum() { float s = 0.0; for (int i = 0; i < n; i++) s += 0.25; return s; }\n";

type TranslationCase = { name: string; vertex: string; fragment: string; uniforms?: Record<string, number | number[]>;
  ints?: Record<string, number>; bindings?: [string, number][]; attributes?: Record<number, number[]>; textures?: () => void;
  /** Which stage WebGL's ES 1.00 compile rejects (the control)... */
  rejected: ("vertex" | "fragment")[];
  /** ...or the color the unmodified shaders draw instead. */
  nativeDraws?: number[]; expected?: number[] };

function essl3Translation(): void {
  target(false);
  const cases: TranslationCase[] = [
    { name: "while-loop.fragment", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 },
      fragment: okFragment("uniform int n;", "float s = 0.0; int i = 0;\nwhile (i < n) { s += 0.25; i++; }", "s == 1.0") },
    { name: "do-while.vertex", rejected: ["vertex"], ints: { n: 3 },
      vertex: "uniform int n;\nvarying mediump vec4 v;\nvoid main() { float s = 0.0; int i = 0;\n" +
        "do { s += 1.0; i++; } while (i < n);\nv = s == 3.0 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);\n" +
        "gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
      fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n" },
    { name: "uniform-loop-bound", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 },
      fragment: okFragment(DYNAMIC_LOOP, "", "dynamicSum() == 1.0") },
    // dEQP-GLES2.functional.shaders.indexing.tmp_array.*: a temporary array
    // indexed by a uniform.
    { name: "tmp-array-dynamic-index", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { k: 2 },
      fragment: okFragment("uniform int k;", "float a[4]; a[0] = 0.0; a[1] = 1.0; a[2] = 2.0; a[3] = 3.0;", "a[k] == 2.0") },
    // ESSL 3.00 keywords and built-in names that are ES 1.00 identifiers,
    // API-visible ones included: uniforms, attributes and varyings.
    { name: "reserved-names", rejected: ["fragment"], ints: { n: 4 }, uniforms: { sample: 0.5 },
      bindings: [["texture", 3]], attributes: { 3: [0.25, 0, 0, 1] },
      vertex: "attribute vec4 texture;\nvarying mediump vec4 smooth;\n" +
        "void main() { smooth = texture; gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
      fragment: okFragment(DYNAMIC_LOOP + "uniform float sample;\nvarying vec4 smooth;\nfloat round(float layout) { return layout + 1.0; }",
        "float filter = sample; int uint = 2; vec2 uvec2 = vec2(float(uint));",
        "dynamicSum() == 1.0 && filter == 0.5 && round(1.0) == 2.0 && uvec2.y == 2.0 && smooth.x == 0.25") },
    // ES 1.00 allows overloading a built-in; ESSL 3.00 does not.
    { name: "builtin-overload", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 },
      fragment: okFragment(DYNAMIC_LOOP + "float max(int a, int b) { return a > b ? float(a) : float(b); }\n" +
        "vec4 texture2D(float x) { return vec4(x); }\nconst float k = max(1.0, 2.0);",
        "", "dynamicSum() == 1.0 && max(3, 5) == 5.0 && max(0.5, 0.25) == 0.5 && k == 2.0 && texture2D(0.5).y == 0.5") },
    // ANGLE accepts non-constant global initializers only in ES 1.00.
    { name: "global-initializer", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 }, uniforms: { u: 0.5 },
      fragment: okFragment(DYNAMIC_LOOP + "uniform float u;\nfloat g = u * 2.0, h = g + 1.0;\nconst float c = 3.0;\nfloat d = c;",
        "", "dynamicSum() == 1.0 && g == 1.0 && h == 2.0 && d == 3.0") },
    { name: "fragdata", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 },
      fragment: "precision mediump float;\n" + DYNAMIC_LOOP +
        "void main() { gl_FragData[0] = dynamicSum() == 1.0 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0); }\n" },
    { name: "texture-lookups", rejected: ["vertex", "fragment"], ints: { n: 4 }, uniforms: { t: 2 }, textures: () => colorTexture(2, [0.2, 0.4, 0.6, 0.8]),
      vertex: "uniform mediump int n;\nuniform sampler2D t;\nvarying mediump vec4 v;\n" +
        "void main() { float s = 0.0; for (int i = 0; i < n; i++) s += 1.0;\n" +
        "v = texture2DLod(t, vec2(0.5), 0.0) * (s / 4.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
      fragment: okFragment(DYNAMIC_LOOP + "uniform sampler2D t;\nvarying vec4 v;",
        "vec4 a = texture2D(t, vec2(0.5)), b = texture2DProj(t, vec3(1.0, 1.0, 2.0)), c = texture2D(t, vec2(0.5), 0.0);",
        "dynamicSum() == 1.0 && distance(a, vec4(0.2, 0.4, 0.6, 0.8)) < 0.01 && distance(a, b) < 0.01 && distance(a, c) < 0.01 && distance(a, v) < 0.01") },
    // GL_OES_standard_derivatives: WebGL 2 has no ES 1.00 extensions.
    // Natively the extension is absent: the shader compiles its #else (red).
    { name: "standard-derivatives", vertex: VARYING_VERTEX, rejected: [], nativeDraws: [1, 0, 0, 1],
      fragment: "#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\n" +
        "void main() {\n#if defined(GL_OES_standard_derivatives) && GL_OES_standard_derivatives == 1\n" +
        "float w = fwidth(gl_FragCoord.x) + dFdx(gl_FragCoord.x) - abs(dFdy(gl_FragCoord.x));\n" +
        "gl_FragColor = w == 2.0 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);\n" +
        "#else\ngl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);\n#endif\n}\n" },
    { name: "predefined-macros", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: { n: 4 },
      fragment: okFragment(DYNAMIC_LOOP + "#define TWICE(x) ((x) + (x))\n#line 40\nconst int line = __LINE__;",
        "", "dynamicSum() == 1.0 && __VERSION__ == 100 && line == 40 && TWICE(GL_ES) == 2 && GL_FRAGMENT_PRECISION_HIGH == 1") },
    // ES100 has a function-body scope inside its parameters. The native
    // controls reject this; both native-compatible and translated paths must
    // keep the parameter read before the local declaration, and its new value
    // after it. A second shader forces partner translation during link.
    // One product exceeds the native expression-depth budget. Compare its
    // lowered straight-line result with a uniform-bounded sequential loop;
    // the latter also requires native ES100 validation followed by ES300.
    { name: "long-product-fragment", vertex: VARYING_VERTEX, rejected: ["fragment"], ints:{n:1000}, uniforms:{a:[1.0001,0.9999,1.0,1.0]},
      fragment: "precision mediump float;uniform highp vec4 a;uniform int n;void main(){highp vec4 value="+Array(1001).fill("a").join("*")+";highp vec4 reference=a;for(int i=0;i<n;i++)reference=reference*a;gl_FragColor=distance(value,reference)<0.0002?vec4(0.0,1.0,0.0,1.0):vec4(1.0,0.0,0.0,1.0);}" },
    { name: "long-product-vertex", rejected: ["vertex"], ints:{n:1000}, uniforms:{a:[1.0001,0.9999,1.0,1.0]},
      vertex: "uniform highp vec4 a;uniform int n;varying mediump vec4 v;void main(){highp vec4 value="+Array(1001).fill("a").join("*")+";highp vec4 reference=a;for(int i=0;i<n;i++)reference=reference*a;v=distance(value,reference)<0.0002?vec4(0.0,1.0,0.0,1.0):vec4(1.0,0.0,0.0,1.0);gl_Position=vec4(0.0,0.0,0.0,1.0);gl_PointSize=1.0;}",
      fragment: "precision mediump float;varying vec4 v;void main(){gl_FragColor=v;}" },
    { name:"struct-type-shadow-scalar",vertex:VARYING_VERTEX,rejected:[],ints:{u:2},
      fragment:okFragment("uniform int u;struct S{int val;};","int S=S(u).val;","S==2")},
    { name:"struct-type-shadow-aggregate",vertex:VARYING_VERTEX,rejected:[],ints:{u:2},
      fragment:okFragment("uniform int u;struct S{int val;};","S S=S(u);","S.val==2")},
    { name:"struct-type-shadow-scope-end",vertex:VARYING_VERTEX,rejected:[],ints:{u:2},
      fragment:okFragment("uniform int u;struct S{int val;};","int value=0;{int S=S(u).val;value=S;}int after=S(u+1).val;","value==2&&after==3")},
    { name:"struct-type-shadow-member",vertex:VARYING_VERTEX,rejected:[],ints:{u:2},
      fragment:okFragment("uniform int u;struct S{int S;};","S S=S(u);","S.S==2")},
    { name:"struct-type-shadow-comma",vertex:VARYING_VERTEX,rejected:[],ints:{u:2},
      fragment:okFragment("uniform int u;struct S{int val;};","int S=S(u).val,x=S;","x==2")},
    { name: "parameter-shadow-native", vertex: VARYING_VERTEX, rejected: ["fragment"],
      fragment: okFragment("int f(int inp,int x){int before=x;int x=5;return inp+x-5+before;}", "", "f(2,42)==44") },
    { name: "parameter-shadow-translated", vertex: VARYING_VERTEX, rejected: ["fragment"], ints: {n:4},
      fragment: okFragment(DYNAMIC_LOOP+"int f(int inp,int x){int x=5;return inp+x-5;}", "", "f(2,42)==2 && dynamicSum()==1.0") },
    { name: "parameter-shadow-link-promotion", rejected: ["vertex", "fragment"], ints: {n:4},
      vertex: "varying mediump vec4 v;\nint f(int inp,int x){int before=x;int x=5;return inp+x-5+before;}\nvoid main(){v=vec4(0.0,float(f(2,42)==44),0.0,1.0);gl_Position=vec4(0.0,0.0,0.0,1.0);gl_PointSize=1.0;}",
      fragment: "precision mediump float;\nvarying vec4 v;\n"+DYNAMIC_LOOP+"void main(){gl_FragColor=v*dynamicSum();}" },
    { name: "macro-defined-native", vertex: VARYING_VERTEX, rejected: ["fragment"],
      fragment: "precision mediump float;\n#define A defined(B)\n#if !A\n#define VALUE 1.0\n#else\n#error wrong initial table\n#endif\n#define B 7\n#if A\n#define LATER 1.0\n#else\n#error wrong later table\n#endif\nvoid main(){gl_FragColor=vec4(0.0,VALUE*LATER,0.0,1.0);}" },
    { name: "macro-defined-translated", vertex: VARYING_VERTEX, rejected: ["fragment"], ints:{n:4},
      fragment: "precision mediump float;\n#define A defined(B)\n#if !A\n#define VALUE 1.0\n#else\n#error wrong table\n#endif\n"+DYNAMIC_LOOP+"void main(){gl_FragColor=vec4(0.0,VALUE*dynamicSum(),0.0,1.0);}" },
    { name: "invariant-varyings", rejected: ["fragment"], ints: { n: 4 },
      vertex: "invariant varying mediump vec4 v;\nvoid main() { v = vec4(0.0, 1.0, 0.0, 1.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n",
      fragment: "precision mediump float;\ninvariant varying vec4 v;\n" + DYNAMIC_LOOP + "void main() { gl_FragColor = v * dynamicSum(); }\n" },
  ];
  for (const c of cases) {
    const name = `essl3-translation.${c.name}`;
    for (const stage of c.rejected) {
      // Control: WebGL's ES 1.00 compile rejects the stage, so the check
      // below passes only through the translation.
      const native = nativeCompile(stage === "vertex" ? c.vertex : c.fragment, stage === "fragment");
      record(`${name}.native-control.${stage}`, !native.ok, native.ok ? "WebGL compiled it as ES 1.00" : native.log);
    }
    c.textures?.();
    if (c.nativeDraws) {
      const native = build(c.vertex, c.fragment);
      if (native.program) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); drawPoint(native.program); gl.deleteProgram(native.program); }
      const got = pixel();
      record(`${name}.native-control`, !!native.program && near(got, c.nativeDraws), `unrewritten ${native.program ? fmt(got) : native.log}`);
    }
    const built = buildGuest(c.vertex, c.fragment, c.bindings);
    if (!built.program) { record(name, false, `host path failed: ${built.log}`); continue; }
    gl.useProgram(built.program);
    const at = (uniform: string) => gl.getUniformLocation(built.program!, programNativeName(built.program!, uniform));
    for (const [uniform, value] of Object.entries(c.ints ?? {})) gl.uniform1i(at(uniform), value);
    for (const [uniform, value] of Object.entries(c.uniforms ?? {}))
      if (uniform === "t") gl.uniform1i(at(uniform), value as number);
      else if (Array.isArray(value)) gl.uniform4fv(at(uniform), value);
      else gl.uniform1f(at(uniform), value);
    for (const [index, value] of Object.entries(c.attributes ?? {})) gl.vertexAttrib4fv(Number(index), value);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, 1);
    const got = pixel(), want = c.expected ?? GREEN;
    record(name, near(got, want), `got ${fmt(got)} want ${fmt(want)} [${built.languages.join(",")}]`);
    gl.deleteProgram(built.program);
  }

  // The compile receipt must retain compatible source for private rebuilds,
  // then revoke it on a new failed compile instead of serving stale text.
  {
    const source="precision mediump float;\nint f(int x){int x=5;return x;}\nvoid main(){gl_FragColor=vec4(float(f(42)));}";
    const shader=gl.createShader(gl.FRAGMENT_SHADER)!;
    const language=compileGuestShader(gl,shader,source,true), retained=compatibleShaderSource(shader,source);
    const rebuilt=nativeCompile(retained,true);
    record("essl100-compatible-source.private-rebuild",language==="essl100" && retained!==source && rebuilt.ok,rebuilt.log);
    const rejected="#version 300 es\nprecision mediump float;out vec4 color;void main(){color=vec4(1.0);}";
    const failed=compileGuestShader(gl,shader,rejected,true);
    record("essl100-compatible-source.reject-revokes-old-source",failed===null && compatibleShaderSource(shader,rejected)===rejected && !gl.getShaderParameter(shader,gl.COMPILE_STATUS));
    gl.deleteShader(shader);
  }

  // Shaders ES 1.00 rejects stay rejected: each also needs the translation
  // (a uniform loop bound), so only the translated compile could accept it.
  const invalid: { name: string; vertex?: string; fragment: string; link?: boolean }[] = [
    { name: "long-product-type-mismatch", fragment: "precision mediump float;uniform highp vec4 a;void main(){highp float value="+Array(1001).fill("a").join("*")+";gl_FragColor=vec4(value);}" },
    { name: "long-product-undefined-name", fragment: "precision mediump float;uniform highp vec4 a;void main(){highp vec4 value="+Array.from({length:1001},(_,i)=>i===500?"missing":"a").join("*")+";gl_FragColor=value;}" },
    {name:"struct-type-shadow-duplicate",fragment:okFragment("struct S{int val;};","int S=1;int S=2;","S==2")},
    {name:"struct-type-shadow-const-write",fragment:okFragment("struct S{int val;};","const int S=1;S=2;","S==2")},
    {name:"struct-type-shadow-constructor-after-declaration",fragment:okFragment("struct S{int val;};","int S=1;int value=S(2).val;","value==2")},
    { name: "parameter-scope-duplicate-local", fragment: okFragment("int f(int x){int y=1;int y=2;return y;}", "", "f(1)==1") },
    { name: "parameter-scope-duplicate-parameter", fragment: okFragment("int f(int x,int x){return x;}", "", "f(1,2)==1") },
    { name: "macro-defined-malformed-operand", fragment: "precision mediump float;\n#define A defined(B,C)\n#if A\n#endif\nvoid main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}" },
    { name: "macro-defined-preserves-error", fragment: "precision mediump float;\n#define A defined(B)\n#if !A\n#error this must remain an error\n#endif\nvoid main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}" },
    { name: "fragcolor-and-fragdata", fragment: `precision mediump float;\n${DYNAMIC_LOOP}void main() { gl_FragColor = vec4(dynamicSum()); gl_FragData[0] = vec4(1.0); }\n` },
    { name: "fragdata-index-1", fragment: `precision mediump float;\n${DYNAMIC_LOOP}void main() { gl_FragData[1] = vec4(dynamicSum()); }\n` },
    { name: "modulo-operator", fragment: okFragment(DYNAMIC_LOOP, "int m = n % 2;", "m == 0") },
    { name: "bitwise-operator", fragment: okFragment(DYNAMIC_LOOP, "int m = n & 1;", "m == 0") },
    { name: "switch", fragment: okFragment(DYNAMIC_LOOP, "float s = 0.0; switch (n) { case 1: s = 1.0; break; default: s = 2.0; }", "s == 1.0") },
    { name: "uint-type", fragment: okFragment(DYNAMIC_LOOP, "uint u = 1u;", "u == 1u") },
    { name: "float-suffix", fragment: okFragment(DYNAMIC_LOOP, "float f = 1.0f;", "f == 1.0") },
    { name: "array-constructor", fragment: okFragment(DYNAMIC_LOOP, "float a[2] = float[2](1.0, 2.0);", "a[1] == 2.0") },
    { name: "array-length", fragment: okFragment(DYNAMIC_LOOP, "float a[2]; a[0] = 1.0;", "a.length() == 2") },
    { name: "in-out-globals", fragment: `precision mediump float;\n${DYNAMIC_LOOP}out vec4 color;\nvoid main() { color = vec4(dynamicSum()); }\n` },
    { name: "texture-function", fragment: `precision mediump float;\n${DYNAMIC_LOOP}uniform sampler2D t;\nvoid main() { gl_FragColor = texture(t, vec2(dynamicSum())); }\n` },
    { name: "builtin-redefinition", fragment: okFragment(DYNAMIC_LOOP + "float sin(float x) { return x; }", "", "sin(1.0) == 1.0") },
    { name: "derivatives-without-extension", fragment: okFragment(DYNAMIC_LOOP, "float d = dFdx(gl_FragCoord.x);", "d == 1.0") },
    { name: "derivatives-disabled", fragment: "#extension GL_OES_standard_derivatives : disable\n" + okFragment(DYNAMIC_LOOP, "float d = dFdx(1.0);", "d == 0.0") },
    { name: "derivatives-in-vertex", fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n",
      vertex: "#extension GL_OES_standard_derivatives : enable\nvarying vec4 v;\nvoid main() { v = vec4(dFdx(1.0)); gl_Position = vec4(0.0); }\n" },
    { name: "redefine-derivatives-macro", fragment: "#define GL_OES_standard_derivatives 1\nprecision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }\n" },
    // ES 1.00 section 4.6.4: varying invariance must match (a link error).
    { name: "invariance-mismatch", link: true,
      vertex: "invariant varying mediump vec4 v;\nvoid main() { v = vec4(1.0); gl_Position = vec4(0.0); }\n",
      fragment: `precision mediump float;\nvarying vec4 v;\n${DYNAMIC_LOOP}void main() { gl_FragColor = v * dynamicSum(); }\n` },
  ];
  for (const c of invalid) {
    const built = buildGuest(c.vertex ?? VARYING_VERTEX, c.fragment);
    const ok = !built.program && (c.link ? built.languages.every(Boolean) : built.languages.includes(null));
    record(`essl3-translation.rejects.${c.name}`, ok, `${built.program ? "linked" : c.link ? "link failed" : "compile failed"} [${built.languages.join(",")}]: ${built.log.split("\n")[0]}`);
    if (built.program) gl.deleteProgram(built.program);
  }

  // Info logs keep the guest's line numbers: the translated text of a
  // shader whose line 7 is in error reports line 7.
  const translated = translateEssl100("precision mediump float;\nuniform int n;\n\n\nvoid main() {\n  float s = 0.0;\n  s += undefinedName;\n" +
    "  for (int i = 0; i < n; i++) s += 1.0;\n  gl_FragColor = vec4(s);\n}\n", true).text;
  const shader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(shader, translated); gl.compileShader(shader);
  const log = gl.getShaderInfoLog(shader) ?? "";
  gl.deleteShader(shader);
  record("essl3-translation.info-log-line", /\b0:7:/.test(log), log.trim().split("\n")[0]);
}


// ---------------------------------------------------------------------------
// 7. Cube maps sampled per face (ES 2.0 sections 3.7.5 and 3.7.7) from the
//    cube's six-layer 2D array storage (cube-storage.ts) by the translation's
//    lookups (essl3-translation.ts). Each check compares with an ES 2.0
//    reference computed here; the controls show what WebGL 2 does without
//    the emulation (seamless filtering) or with a naive array lookup
//    (implicit derivatives of the face coordinates).

const FACE_COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
const LEVEL_COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128]];

/** A 2D array (cube-storage.ts layout) or native cube map on `unit`, with
 * `texel(face, level, x, y)` RGB bytes, `size` texels per side, `levels`
 * levels. */
function cubeTexture(unit: number, array: boolean, size: number, levels: number,
    texel: (face: number, level: number, x: number, y: number) => number[], min: number, mag: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + unit);
  const target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_CUBE_MAP;
  gl.bindTexture(target, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (let level = 0; level < levels; level++) {
    const n = Math.max(1, size >> level);
    if (array) gl.texImage3D(target, level, gl.RGBA8, n, n, 6, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let face = 0; face < 6; face++) {
      const pixels = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) pixels.set([...texel(face, level, x, y), 255], (y * n + x) * 4);
      if (array) gl.texSubImage3D(target, level, 0, 0, face, n, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      else gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, level, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
  }
  for (const [pname, value] of [[gl.TEXTURE_MIN_FILTER, min], [gl.TEXTURE_MAG_FILTER, mag],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(target, pname, value);
  if (!array) gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels - 1);
  else gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels - 1);
  gl.activeTexture(gl.TEXTURE0);
  return texture;
}

/** ES 2.0 table 3.21: face index and (s, t) of direction r. */
function cubeFaceCoords(r: number[]): { face: number; s: number; t: number; sc: number; tc: number; ma: number; axes: number[][] } {
  const [x, y, z] = r, ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face: number, axes: number[][];
  if (az >= ax && az >= ay) {
    const d = z >= 0 ? 1 : -1; face = d > 0 ? 4 : 5; axes = [[d, 0, 0], [0, -1, 0], [0, 0, d]];
  } else if (ay >= ax) {
    const d = y >= 0 ? 1 : -1; face = d > 0 ? 2 : 3; axes = [[1, 0, 0], [0, 0, d], [0, d, 0]];
  } else {
    const d = x >= 0 ? 1 : -1; face = d > 0 ? 0 : 1; axes = [[0, 0, -d], [0, -1, 0], [d, 0, 0]];
  }
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sc = dot(r, axes[0]), tc = dot(r, axes[1]), ma = dot(r, axes[2]);
  return { face, s: 0.5 * sc / ma + 0.5, t: 0.5 * tc / ma + 0.5, sc, tc, ma, axes };
}

function pixels(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}
const rgbNear = (got: ArrayLike<number>, at: number, want: number[], tolerance = 2) =>
  want.every((v, i) => Math.abs(got[at + i] - v) <= tolerance);

/** A size x size RGBA8 target. */
function bigTarget(size: number): void {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const color = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  gl.viewport(0, 0, size, size);
}

const QUAD_VERTEX = "attribute vec2 p;\nvoid main() { gl_Position = vec4(p, 0.0, 1.0); }\n";
function drawQuad(program: WebGLProgram): void {
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.useProgram(program);
  const at = gl.getAttribLocation(program, programNativeName(program, "p"));
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(at);
  gl.deleteBuffer(buffer);
}

function cubeSampling(): void {
  // (a) Linear filtering at a face edge: per face, not seamless. 4x4 solid
  // faces; just inside +X near +Y. The repro in
  // .context/cts-fix-limits-texture-runs/cube-seam-repro without Kandelo.
  target(false);
  const solid = (face: number) => FACE_COLORS[face];
  const LINEAR = gl.LINEAR, NEAREST = gl.NEAREST;
  const edge = "vec3(1.0, 0.99, 0.0)";
  const stages = [
    { name: "fragment-textureCube", vertex: VARYING_VERTEX,
      fragment: `precision mediump float;\nuniform samplerCube s;\nvoid main() { gl_FragColor = textureCube(s, ${edge}); }\n` },
    { name: "vertex-textureCube",
      vertex: `uniform samplerCube s;\nvarying mediump vec4 v;\nvoid main() { v = textureCube(s, ${edge}); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n`,
      fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n" },
    { name: "vertex-textureCubeLod",
      vertex: `uniform samplerCube s;\nvarying mediump vec4 v;\nvoid main() { v = textureCubeLod(s, ${edge}, 0.0); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n`,
      fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n" },
  ];
  for (const stage of stages) {
    const array = cubeTexture(1, true, 4, 1, solid, LINEAR, LINEAR), native = cubeTexture(1, false, 4, 1, solid, LINEAR, LINEAR);
    // Control: WebGL 2's own cube map filters across the edge (ES 3.0).
    const control = build(stage.vertex, stage.fragment);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_CUBE_MAP, native); gl.activeTexture(gl.TEXTURE0);
    let seamless = false;
    if (control.program) {
      gl.useProgram(control.program); gl.uniform1i(gl.getUniformLocation(control.program, "s"), 1);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
      const got = pixel(); seamless = got[2] > 0.15;
      record(`cube.${stage.name}.native-control`, seamless, `native cube ${fmt(got)} (blue from +Y means seamless)`);
      gl.deleteProgram(control.program);
    } else record(`cube.${stage.name}.native-control`, false, control.log);
    const built = buildGuest(stage.vertex, stage.fragment);
    if (!built.program) { record(`cube.${stage.name}`, false, `host path failed: ${built.log}`); continue; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, array); gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(built.program); gl.uniform1i(gl.getUniformLocation(built.program, "s"), 1);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
    const got = pixel();
    record(`cube.${stage.name}`, near(got, [1, 0, 0, 1]), `got ${fmt(got)} want +X red only [${built.languages.join(",")}]`);
    gl.deleteProgram(built.program); gl.deleteTexture(array); gl.deleteTexture(native);
  }

  // (b) Face selection and orientation: every face's four quadrants agree
  // with WebGL's native cube map (NEAREST at quadrant centres is the same
  // seamless or not).
  const quadrant = (face: number, _level: number, x: number, y: number) =>
    [face * 40, x * 120 + 10, y * 120 + 10];
  const array = cubeTexture(1, true, 2, 1, quadrant, NEAREST, NEAREST), native = cubeTexture(1, false, 2, 1, quadrant, NEAREST, NEAREST);
  const pick = "precision mediump float;\nuniform samplerCube s;\nuniform vec3 d;\nvoid main() { gl_FragColor = textureCube(s, d); }\n";
  const control = build(VARYING_VERTEX, pick), built = buildGuest(VARYING_VERTEX, pick);
  if (!control.program || !built.program) record("cube.orientation", false, `${control.log} ${built.log}`);
  else {
    const mismatches: string[] = [];
    for (let face = 0; face < 6; face++) for (const [s, t] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      // Invert table 3.21 for a direction at (s, t) of `face`.
      const sc = 2 * s - 1, tc = 2 * t - 1;
      const d = [[1, -tc, -sc], [-1, -tc, sc], [sc, 1, tc], [sc, -1, -tc], [sc, -tc, 1], [-sc, -tc, -1]][face];
      const reference = cubeFaceCoords(d);
      const draw = (program: WebGLProgram, texture: WebGLTexture, cube: boolean) => {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D_ARRAY, texture); gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, "s"), 1);
        gl.uniform3fv(gl.getUniformLocation(program, "d"), d);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
        return pixel();
      };
      const want = draw(control.program, native, true), got = draw(built.program, array, false);
      if (!near(got, want) || reference.face !== face) mismatches.push(`face ${face} (${s},${t}): got ${fmt(got)} native ${fmt(want)}`);
    }
    record("cube.orientation", mismatches.length === 0, mismatches.join("; ") || "24 face quadrants match the native cube map");
  }
  for (const p of [control.program, built.program]) if (p) gl.deleteProgram(p);
  gl.deleteTexture(array); gl.deleteTexture(native);

  // (c) Level of detail across face edges. A 32x32 quad whose direction
  // (1, y, z) spans [-2, 2] in y and z crosses all four edges of +X; every
  // level of the 64x64 cube has its own colour (NEAREST_MIPMAP_NEAREST).
  // The ES 2.0 reference level: lambda from the derivatives of the selected
  // face's (s, t) (section 3.7.7), computed analytically. A naive array
  // lookup (implicit derivatives of the face coordinates) is the control:
  // it picks far smaller levels along every edge.
  const SIZE = 32, FACE = 64, LEVELS = 7;
  bigTarget(SIZE);
  const byLevel = (_face: number, level: number) => LEVEL_COLORS[level];
  for (const bias of [0, 1.5]) {
    const fragment = "precision highp float;\nuniform samplerCube s;\n" +
      `void main() { vec3 r = vec3(1.0, (gl_FragCoord.y - ${SIZE / 2}.0) / ${SIZE / 4}.0, (gl_FragCoord.x - ${SIZE / 2}.0) / ${SIZE / 4}.0);\n` +
      `gl_FragColor = ${bias ? `textureCube(s, r, ${bias.toFixed(1)})` : "textureCube(s, r)"}; }\n`;
    const texture = cubeTexture(1, true, FACE, LEVELS, byLevel, gl.NEAREST_MIPMAP_NEAREST, NEAREST);
    const guest = buildGuest(QUAD_VERTEX, fragment, [["p", 0]]);
    if (!guest.program) { record(`cube.lod-across-edges.bias-${bias}`, false, `host path failed: ${guest.log}`); continue; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture); gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(guest.program); gl.uniform1i(gl.getUniformLocation(guest.program, "s"), 1);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); drawQuad(guest.program);
    const got = pixels(SIZE, SIZE);
    let bad = 0, first = "";
    const levelOf = (at: number) => LEVEL_COLORS.findIndex(c => rgbNear(got, at, c));
    for (let py = 0; py < SIZE; py++) for (let px = 0; px < SIZE; px++) {
      const r = [1, (py + 0.5 - SIZE / 2) / (SIZE / 4), (px + 0.5 - SIZE / 2) / (SIZE / 4)];
      const f = cubeFaceCoords(r);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const grad = (d: number[]) => [0.5 * (dot(d, f.axes[0]) * f.ma - f.sc * dot(d, f.axes[2])) / (f.ma * f.ma),
        0.5 * (dot(d, f.axes[1]) * f.ma - f.tc * dot(d, f.axes[2])) / (f.ma * f.ma)];
      const gx = grad([0, 0, 1 / (SIZE / 4)]), gy = grad([0, 1 / (SIZE / 4), 0]);
      const rho = FACE * Math.max(Math.hypot(gx[0], gx[1]), Math.hypot(gy[0], gy[1]));
      const lambda = Math.log2(rho) + bias;
      const allowed = [Math.floor(lambda), Math.ceil(lambda)].map(l => Math.min(LEVELS - 1, Math.max(0, l)));
      const level = levelOf((py * SIZE + px) * 4);
      if (!allowed.includes(level)) { bad++; if (!first) first = `(${px},${py}) face ${f.face} level ${level}, lambda ${lambda.toFixed(2)}`; }
    }
    record(`cube.lod-across-edges.bias-${bias}`, bad === 0, bad ? `${bad} pixels off the ES 2.0 level, first ${first}` : `${SIZE * SIZE} pixels at the ES 2.0 level [${guest.languages.join(",")}]`);
    gl.deleteProgram(guest.program);
    if (bias === 0) {
      // Control: the same face selection with texture()'s implicit derivatives.
      const naive = translateEssl100(fragment, true).text
        .replace(/return textureGrad\(x, c, [^;]*;/g, "return texture(x, c);");
      const program = build(translateEssl100(QUAD_VERTEX, false).text, naive);
      if (program.program) {
        gl.useProgram(program.program); gl.uniform1i(gl.getUniformLocation(program.program, "s"), 1);
        gl.clear(gl.COLOR_BUFFER_BIT); drawQuad(program.program);
        const naiveGot = pixels(SIZE, SIZE);
        let deep = 0;
        for (let i = 0; i < SIZE * SIZE; i++) if (LEVEL_COLORS.findIndex(c => rgbNear(naiveGot, i * 4, c)) >= 4) deep++;
        record("cube.lod-across-edges.naive-control", deep > 0, `${deep} pixels at level 4 or smaller with implicit derivatives`);
        gl.deleteProgram(program.program);
      } else record("cube.lod-across-edges.naive-control", false, program.log);
    }
    gl.deleteTexture(texture);
  }

  // (d) Guest declarations: sampler precisions, function parameters, arrays,
  // a guest overload of textureCube, and a 1.00 partner shader.
  target(false);
  const texture = cubeTexture(1, true, 4, 1, solid, NEAREST, NEAREST);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture); gl.activeTexture(gl.TEXTURE0);
  const declarations: [string, string][] = [
    ["precisions", "uniform lowp samplerCube a;\nuniform mediump samplerCube b;\nuniform highp samplerCube c;\n" +
      "vec4 look() { return (textureCube(a, vec3(0.0, 1.0, 0.0)) + textureCube(b, vec3(0.0, 1.0, 0.0)) + textureCube(c, vec3(0.0, 1.0, 0.0))) / 3.0; }"],
    ["parameter", "uniform samplerCube a;\nvec4 sampleIt(samplerCube x, vec3 d) { return textureCube(x, d); }\nvec4 look() { return sampleIt(a, vec3(0.0, 1.0, 0.0)); }"],
    ["array", "uniform samplerCube a[2];\nvec4 look() { return textureCube(a[1], vec3(0.0, 1.0, 0.0)); }"],
    ["array-loop", "uniform samplerCube a[2];\nvec4 look() { vec4 v=vec4(0.0); for(int i=0;i<2;i++) v+=textureCube(a[i],vec3(0.0,1.0,0.0)); return v/2.0; }"],
    ["array-parameter-loop", "uniform samplerCube a[2];\nvec4 f(samplerCube x[2]) { vec4 v=vec4(0.0); for(int i=0;i<2;i++) v+=textureCube(x[i],vec3(0.0,1.0,0.0)); return v/2.0; }\nvec4 look() { return f(a); }"],
    ["array-element-parameter", "uniform samplerCube a[2];\nvec4 f(samplerCube x, vec3 d) { return textureCube(x,d); }\nvec4 look() { vec4 v=vec4(0.0); for(int i=0;i<2;i++) v+=f(a[i],vec3(0.0,1.0,0.0)); return v/2.0; }"],
    ["array-element-inout", "uniform samplerCube a[2];\nvec4 f(samplerCube x, inout float count) { count+=1.0; return textureCube(x,vec3(0.0,1.0,0.0)); }\nvec4 look() { vec4 v=vec4(0.0); float count=0.0; for(int i=0;i<2;i++) v+=f(a[i],count); return v/count; }"],
    ["array-element-struct-result", "struct Color { vec4 c; };\nuniform samplerCube a[2];\nColor f(samplerCube x) { Color v; v.c=textureCube(x,vec3(0.0,1.0,0.0)); return v; }\nvec4 look() { vec4 v=vec4(0.0); for(int i=0;i<2;i++) { Color c=f(a[i]); v+=c.c; } return v/2.0; }"],
    ["array-constant-size", "const int N=1+1;\nuniform samplerCube a[N];\nvec4 look() { vec4 v=vec4(0.0); for(int i=0;i<N;i++) v+=textureCube(a[i],vec3(0.0,1.0,0.0)); return v/2.0; }"],
    ["array-coordinate-effects", "uniform samplerCube a[2];\nint calls=0;\nvec3 coord() { calls++; return vec3(0.0,1.0,0.0); }\nvec4 look() { vec4 v=vec4(0.0); for(int i=0;i<2;i++) v+=textureCube(a[i],coord()); return v/float(calls); }"],
    ["struct", "struct S { samplerCube m; float k; };\nuniform S a;\nvec4 look() { return textureCube(a.m, vec3(0.0, 1.0, 0.0)) * a.k; }"],
    ["overload", "uniform samplerCube a;\nvec4 textureCube(samplerCube x, vec3 d, int k) { return textureCube(x, d) * float(k); }\n" +
      "vec4 look() { return textureCube(a, vec3(0.0, 1.0, 0.0), 1); }"],
    ["precision-statement", "precision highp samplerCube;\nuniform samplerCube a;\nvec4 look() { return textureCube(a, vec3(0.0, 1.0, 0.0)); }"],
  ];
  for (const [name, body] of declarations) {
    const fragment = `precision mediump float;\n${body}\nvoid main() { gl_FragColor = look(); }\n`;
    const guest = buildGuest(VARYING_VERTEX, fragment);
    if (!guest.program) { record(`cube.declarations.${name}`, false, `host path failed: ${guest.log}`); continue; }
    gl.useProgram(guest.program);
    const count = Number(gl.getProgramParameter(guest.program, gl.ACTIVE_UNIFORMS));
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(guest.program, i)!;
      const base = info.name.replace(/\[0\]$/, "");
      for (let e = 0; e < info.size; e++) {
        const location = gl.getUniformLocation(guest.program, info.size > 1 ? `${base}[${e}]` : base);
        if (info.type === gl.SAMPLER_2D_ARRAY) gl.uniform1i(location, 1); else gl.uniform1f(location, 1);
      }
    }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
    const got = pixel();
    // The fragment shader samples a cube, so it compiles as ESSL 3.00 (its
    // 1.00 partner is recompiled as 3.00 at link).
    record(`cube.declarations.${name}`, near(got, [0, 0, 1, 1]) && guest.languages[1] === "essl300",
      `got ${fmt(got)} want +Y blue [${guest.languages.join(",")}]`);
    gl.deleteProgram(guest.program);
  }
  gl.deleteTexture(texture);
}

function samplerArraySelection(): void {
  for (const cube of [false, true]) {
    target(false);
    const nativeTarget = cube ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
    const textures = [[255, 0, 0], [0, 255, 0]].map((rgb, i) => {
      if (cube) return cubeTexture(i + 1, true, 1, 1, () => rgb, gl.NEAREST, gl.NEAREST);
      const texture = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + i + 1); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...rgb, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return texture;
    });
    const sampler = cube ? "samplerCube" : "sampler2D", lookup = cube ? "textureCube" : "texture2D";
    const coordinate = cube ? "vec3(1.0,0.0,0.0)" : "vec2(0.5)";
    const cases: Array<[string, string, number[]]> = [
      ["global-loop", `vec4 look() { vec4 v=vec4(0.0); for(int i=0;i<2;i++) v+=${lookup}(a[i],${coordinate}); return v/2.0; }`, [0.5,0.5,0,1]],
      ["scalar-parameter", `vec4 f(${sampler} x) { return ${lookup}(x,${coordinate}); }\nvec4 look() { vec4 v; for(int i=0;i<2;i++) v=f(a[i]); return v; }`, [0,1,0,1]],
      ["array-parameter", `vec4 f(${sampler} x[2]) { vec4 v; for(int i=0;i<2;i++) v=${lookup}(x[i],${coordinate}); return v; }\nvec4 look() { return f(a); }`, [0,1,0,1]],
      ["shadowed-constant", `const int I=1;\nvec4 f(${sampler} x[2]) { const int I=0; return ${lookup}(x[I],${coordinate}); }\nvec4 look() { return f(a); }`, [1,0,0,1]],
      ["parameter-forwarding", `vec4 f(${sampler} x[2]) { return ${lookup}(x[1],${coordinate}); }\nvec4 g(${sampler} y[2]) { return f(y); }\nvec4 look() { return g(a); }`, [0,1,0,1]],
    ];
    for (const [name, functions, want] of cases) {
      const fragment = `precision highp float;\nuniform ${sampler} a[2];\n${functions}\nvoid main() { gl_FragColor=look(); }\n`;
      const built = build(translateEssl100(VARYING_VERTEX, false).text, translateEssl100(fragment, true).text);
      if (!built.program) { record(`sampler-array.${cube ? "cube" : "2d"}.${name}`, false, built.log); continue; }
      gl.useProgram(built.program);
      textures.forEach((texture, i) => {
        gl.activeTexture(gl.TEXTURE0 + i + 1); gl.bindTexture(nativeTarget, texture);
        gl.uniform1i(gl.getUniformLocation(built.program!, `a[${i}]`), i + 1);
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS,0,1);
      const got = pixel();
      record(`sampler-array.${cube ? "cube" : "2d"}.${name}`, near(got,want), `${fmt(got)} want ${want}`);
      gl.deleteProgram(built.program);
    }
    textures.forEach(texture => gl.deleteTexture(texture));
  }
}

// ---------------------------------------------------------------------------
// 8. GLSL ES 1.00 is the only guest language (essl3-translation.ts
//    unsupportedShaderVersion): a shader declaring #version 300 es (or any
//    other number) fails its compile with a driver-style log, while the
//    engine's control shows WebGL 2 would have compiled it.

function shadingLanguageVersion(): void {
  const fragments: [string, string][] = [
    ["300-es", "#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }\n"],
    ["310-es-after-comments", "// comment\n/* block\n */\n#version 310 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }\n"],
    ["110", "#version 110\nvoid main() { gl_FragColor = vec4(1.0); }\n"],
  ];
  for (const [name, source] of fragments) {
    const shader = gl.createShader(gl.FRAGMENT_SHADER)!;
    const language = compileGuestShader(gl, shader, source, true);
    const status = !!gl.getShaderParameter(shader, gl.COMPILE_STATUS), log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    const line = source.split("\n").findIndex(l => l.startsWith("#version")) + 1;
    const ok = language === null && !status && log.includes("unsupported shading language version") && log.includes(`:${line}:`);
    record(`version.${name}`, ok, `language ${language}, COMPILE_STATUS ${status}, log ${JSON.stringify(log.trim())}`);
  }
  // Control: WebGL 2 compiles ESSL 3.00 as written.
  const native = nativeCompile(fragments[0][1], true);
  record("version.300-es.native-control", native.ok, native.ok ? "WebGL 2 compiles #version 300 es" : native.log);
  // #version 100 and no directive still compile and draw.
  target(false);
  for (const [label, header] of [["100", "#version 100\n"], ["100-after-comment", "/* asdf */\n#version 100\n"], ["none", ""]]) {
    const built = buildGuest(VARYING_VERTEX, `${header}precision mediump float;\nvoid main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }\n`);
    let got: number[] = [];
    if (built.program) {
      gl.useProgram(built.program); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
      got = pixel(); gl.deleteProgram(built.program);
    }
    record(`version.accepted.${label}`, !!built.program && near(got, GREEN), built.program ? `got ${fmt(got)}` : built.log);
  }
}

// ---------------------------------------------------------------------------
// 9. ES 2.0's magnification/minification switch-over point c = 0.5 (section
//    3.7.9) for MAG_FILTER LINEAR with MIN_FILTER NEAREST_MIPMAP_NEAREST or
//    NEAREST_MIPMAP_LINEAR (lod-switchover.ts; the variant's lookups are
//    essl3-translation.ts lodSwitchHelpers). Level 0 is a black/white
//    checker (LINEAR and NEAREST differ between texel centres), level 1 red,
//    smaller levels blue. Each check compares every pixel with an ES 2.0
//    reference at a known lambda (affine coordinates, so lambda is constant)
//    just above 0, just below 0.5 and just above 0.5, in 2D and cube maps,
//    fragment and vertex shaders. The controls are the same shaders without
//    the switch-over (WebGL 2's c = 0).

const SW_N = 32, SW_SIZE = 16, SW_LEVELS = 6;
const swTexel = (level: number, x: number, y: number) =>
  level === 0 ? ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0]) : level === 1 ? [255, 0, 0] : [0, 0, 255];
const clampIndex = (i: number, n: number) => Math.min(n - 1, Math.max(0, i));
function swNearest(level: number, s: number, t: number): number[] {
  const n = SW_N >> level;
  return swTexel(level, clampIndex(Math.floor(s * n), n), clampIndex(Math.floor(t * n), n));
}
function swLinear(s: number, t: number): number[] {
  const u = s * SW_N - 0.5, v = t * SW_N - 0.5, i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j;
  const at = (x: number, y: number) => swTexel(0, clampIndex(x, SW_N), clampIndex(y, SW_N));
  return [0, 1, 2].map(c => (1 - a) * (1 - b) * at(i, j)[c] + a * (1 - b) * at(i + 1, j)[c] + (1 - a) * b * at(i, j + 1)[c] + a * b * at(i + 1, j + 1)[c]);
}
/** ES 2.0 sections 3.7.7-3.7.9 with switch-over point `c`. */
function swReference(lambda: number, min: number, s: number, t: number, c: number): number[] {
  if (lambda <= c) return swLinear(s, t);
  const q = SW_LEVELS - 1;
  if (min === gl.NEAREST_MIPMAP_NEAREST) return swNearest(lambda <= 0.5 ? 0 : Math.min(q, Math.ceil(lambda + 0.5) - 1), s, t);
  const d1 = Math.min(q, Math.floor(lambda)), d2 = Math.min(q, d1 + 1), f = lambda - Math.floor(lambda);
  const a = swNearest(d1, s, t), b = swNearest(d2, s, t);
  return [0, 1, 2].map(i => (1 - f) * a[i] + f * b[i]);
}

/** A 2D texture or a cube map's 2D array storage (all faces equal). */
function switchTexture(cube: boolean, min: number): WebGLTexture {
  if (cube) return cubeTexture(1, true, SW_N, SW_LEVELS, (_face, level, x, y) => swTexel(level, x, y), min, gl.LINEAR);
  const texture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (let level = 0; level < SW_LEVELS; level++) {
    const n = SW_N >> level, data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set([...swTexel(level, x, y), 255], (y * n + x) * 4);
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  for (const [pname, value] of [[gl.TEXTURE_MIN_FILTER, min], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, pname, value);
  gl.activeTexture(gl.TEXTURE0);
  return texture;
}

type SwitchCase = { name: string; cube: boolean; stage: "fragment" | "vertex"; vertex: string; fragment: string;
  /** Per pixel (or the one point): lambda, s, t. */
  sample: (px: number, py: number) => [number, number, number]; size: number; uniforms?: Record<string, number> };

function lodSwitchover(): void {
  const S0 = 0.05, T0 = 0.1;
  // Fragment: (s, t) = (S0, T0) + k * gl_FragCoord.xy / SW_SIZE, so
  // rho = SW_N * k / SW_SIZE and lambda = log2(2k) (+ bias).
  const kFor = (lambda: number) => 2 ** lambda / 2;
  const fragmentCase = (cube: boolean, lambda: number, form: "plain" | "bias" | "proj" | "parameter" | "array" | "array-loop" | "array-loop-parameter"): SwitchCase => {
    // Coordinates stay inside the face: s, t < T0 + k < 1.
    const bias = form === "bias" ? -0.3 : 0, k = kFor(lambda - bias);
    const st = `vec2(${S0.toFixed(4)}, ${T0.toFixed(4)}) + ${k.toFixed(6)} * gl_FragCoord.xy / ${SW_SIZE}.0`;
    const sampler = cube ? "samplerCube" : "sampler2D";
    const coord = cube ? "vec3(1.0, 1.0 - 2.0 * st.y, 1.0 - 2.0 * st.x)" : "st";
    const look = cube ? "textureCube" : "texture2D";
    const call = form === "array-loop-parameter" ? `lookUp(a[i], ${coord})` : form === "bias" ? `${look}(s, ${coord}, ${bias.toFixed(1)})`
      : form === "proj" ? "texture2DProj(s, vec4(2.0 * st, 0.0, 2.0))"
      : form === "parameter" ? `lookUp(s, ${coord})` : (form === "array" || form === "array-loop") ? `${look}(a[i], ${coord})` : `${look}(s, ${coord})`;
    // ESSL 3.00 indexes sampler arrays with constant expressions only.
    const decls = form.startsWith("array") ? `uniform ${sampler} a[2];\n${form === "array" ? "const int i = 1;\n" : ""}` : `uniform ${sampler} s;\n`;
    const helper = (form === "parameter" || form === "array-loop-parameter") ? `vec4 lookUp(${sampler} x, ${cube ? "vec3" : "vec2"} c) { return ${look}(x, c); }\n` : "";
    return { name: `${cube ? "cube" : "2d"}.fragment.${form}.lambda-${lambda}`, cube, stage: "fragment", size: SW_SIZE,
      vertex: QUAD_VERTEX, fragment: `precision highp float;\n${decls}${helper}void main() { vec2 st = ${st};\n${form.startsWith("array-loop") ? `for(int i=1;i<2;i++) { gl_FragColor = ${call}; }` : `gl_FragColor = ${call};`} }\n`,
      sample: (px, py) => [lambda, S0 + k * (px + 0.5) / SW_SIZE, T0 + k * (py + 0.5) / SW_SIZE] };
  };
  const vertexCase = (cube: boolean, lambda: number): SwitchCase => {
    const s = 0.37, t = 0.61;
    const coord = cube ? `vec3(1.0, ${(1 - 2 * t).toFixed(4)}, ${(1 - 2 * s).toFixed(4)})` : `vec2(${s}, ${t})`;
    const call = cube ? `textureCubeLod(s, ${coord}, lod)` : `texture2DLod(s, ${coord}, lod)`;
    return { name: `${cube ? "cube" : "2d"}.vertex.lambda-${lambda}`, cube, stage: "vertex", size: 1,
      vertex: `uniform ${cube ? "samplerCube" : "sampler2D"} s;\nuniform float lod;\nvarying mediump vec4 v;\n` +
        `void main() { v = ${call}; gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }\n`,
      fragment: "precision mediump float;\nvarying vec4 v;\nvoid main() { gl_FragColor = v; }\n",
      sample: () => [lambda, s, t], uniforms: { lod: lambda } };
  };
  const cases: SwitchCase[] = [];
  for (const cube of [false, true]) {
    for (const lambda of [0.1, 0.45, 0.6]) cases.push(fragmentCase(cube, lambda, "plain"), vertexCase(cube, lambda));
    cases.push(fragmentCase(cube, 0.45, "bias"), fragmentCase(cube, 0.3, "parameter"), fragmentCase(cube, 0.3, "array"), fragmentCase(cube, 0.3, "array-loop"), fragmentCase(cube, 0.3, "array-loop-parameter"));
  }
  cases.push(fragmentCase(false, 0.3, "proj"));

  for (const min of [gl.NEAREST_MIPMAP_NEAREST, gl.NEAREST_MIPMAP_LINEAR]) {
    const minName = min === gl.NEAREST_MIPMAP_NEAREST ? "nearest_mipmap_nearest" : "nearest_mipmap_linear";
    for (const c of cases) {
      const name = `lod-switch.${minName}.${c.name}`;
      const texture = switchTexture(c.cube, min);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(c.cube ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, texture); gl.activeTexture(gl.TEXTURE0);
      const set = new Set([c.fragment.includes("a[2]") ? "a[1]" : "s"]);
      const draw = (program: WebGLProgram) => {
        if (c.stage === "fragment") bigTarget(c.size); else target(false);
        gl.useProgram(program);
        for (const sampler of ["s", "a[0]", "a[1]"]) {
          const location = gl.getUniformLocation(program, sampler);
          if (location) gl.uniform1i(location, 1);
        }
        for (const [uniform, value] of Object.entries(c.uniforms ?? {})) {
          const location = gl.getUniformLocation(program, uniform);
          if (location) gl.uniform1f(location, value);
        }
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (c.stage === "fragment") drawQuad(program); else gl.drawArrays(gl.POINTS, 0, 1);
        return pixels(c.size, c.size);
      };
      const compare = (got: Uint8Array, cRule: number) => {
        let bad = 0, first = "";
        for (let py = 0; py < c.size; py++) for (let px = 0; px < c.size; px++) {
          const [lambda, s, t] = c.sample(px, py), want = swReference(lambda, min, s, t, cRule), at = (py * c.size + px) * 4;
          if (!rgbNear(got, at, want.map(Math.round), 4)) {
            bad++;
            if (!first) first = `(${px},${py}) got ${[...got.slice(at, at + 3)]} want ${want.map(Math.round)}`;
          }
        }
        return { bad, first };
      };
      // The variant: the host's translation with the switch-over.
      const variant = build(translateEssl100(c.vertex, false, set).text, translateEssl100(c.fragment, true, set).text);
      if (!variant.program) { record(name, false, `variant failed: ${variant.log}`); gl.deleteTexture(texture); continue; }
      const got = compare(draw(variant.program), 0.5);
      record(name, got.bad === 0, got.bad ? `${got.bad} pixels off the ES 2.0 (c = 0.5) result, first ${got.first}` :
        `${c.size * c.size} pixels at the ES 2.0 (c = 0.5) result`);
      gl.deleteProgram(variant.program);
      // Control inside (0, 0.5]: the host path without the switch-over
      // samples with c = 0 and misses the ES 2.0 result. (Its level of
      // detail is the engine's own approximation, so the c = 0 count is
      // informative only; SwiftShader's log2 is piecewise linear.)
      const guest = c.sample(0, 0)[0] <= 0.5 ? buildGuest(c.vertex, c.fragment, [["p", 0]]) : null;
      if (guest?.program) {
        const native = draw(guest.program), es2 = compare(native, 0.5), webgl = compare(native, 0);
        record(`${name}.native-control`, es2.bad > 0, `without the switch-over: ${es2.bad} pixels off ES 2.0, ${webgl.bad} off c = 0`);
        gl.deleteProgram(guest.program);
      } else if (guest) record(`${name}.native-control`, false, guest.log);
      gl.deleteTexture(texture);
    }
  }
}

// ---------------------------------------------------------------------------

(window as unknown as { runShaderRewriteChecks: () => unknown }).runShaderRewriteChecks = () => {
  if (!gl) return { renderer: "no WebGL 2", results: [{ name: "webgl2", ok: false, status: "fail", detail: "getContext('webgl2') failed" }] };
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const maxAttributes = Number(gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
  for (const check of [() => deqpAliasingCases(maxAttributes), () => aliasingSemantics(maxAttributes), reversedDepth, vertexDepthRangeTrigger, depthSampling, externalSampling, builtinLimits, essl3Translation, cubeSampling, samplerArraySelection, shadingLanguageVersion, lodSwitchover]) {
    if ((globalThis as { shaderCheckProgress?: boolean }).shaderCheckProgress) console.info(`shader-check-start: ${check.name}`);
    try { check(); } catch (error) { record(`exception.${check.name}`, false, String(error)); }
    const error = gl.getError();
    if (error) record(`gl-error.after.${check.name || "check"}`, false, `0x${error.toString(16)}`);
  }
  return { renderer, maxAttributes, results };
};
