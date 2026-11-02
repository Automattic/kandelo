/**
 * GLSL ES 1.00 shaders compiled as GLSL ES 3.00 on WebGL 2.
 *
 * Why. OpenGL ES 2.0 compiles the whole GLSL ES 1.00 language. WebGL holds
 * ESSL 1.00 shaders to the "minimum functionality" of GLSL ES 1.00
 * Appendix A instead: no while or do-while loops, for loops only with a
 * constant-bounded, constant-stepped index, and temporary arrays indexed only
 * by constants and loop indices. Real GLES 2 drivers accept more, and guest
 * software (and dEQP-GLES2, e.g. functional.shaders.indexing.tmp_array.* and
 * about 830 performance and stress shaders) relies on it. WebGL does not
 * apply Appendix A to ESSL 3.00, whose language is a superset of ESSL 1.00.
 * So a guest shader that WebGL rejects only for Appendix A is translated to
 * ESSL 3.00 with the same meaning and compiled again (`compileGuestShader`,
 * called by CompileShader in bridge.ts), once per CompileShader; no draw
 * pays for it.
 *
 * Which shaders. The engine's own ESSL 1.00 front end (ANGLE in Chromium,
 * Firefox and WebKit) stays the judge of ES 1.00 validity: CompileShader
 * first compiles the guest's 1.00 source. ANGLE runs its Appendix A pass
 * (ValidateLimitations) only after the shader parsed and type-checked
 * without error, and each of its messages is unique to that pass, so an
 * info log whose every error is one of LIMITATION_MESSAGES belongs to a shader
 * that is otherwise valid ES 1.00 (`onlyAppendixALimitations`). Every other
 * failure stays exactly what the guest sees, with the native log; a shader
 * that compiles as 1.00 is used as 1.00, at no extra cost. Why not translate
 * every shader and validate ES 1.00 here: everything ES 1.00 rejects but
 * ESSL 3.00 accepts (bitwise and modulo operators, switch, uint, array
 * constructors, .length(), in/out globals, ...) would then need a complete
 * ES 1.00 front end in the host to stay an error. A translated
 * shader therefore never needs to be checked for ES 1.00 validity here,
 * except for the one 1.00 rule ANGLE checks after Appendix A: a fragment
 * shader may not use both gl_FragColor and gl_FragData. ES forbids linking
 * shaders of different language versions, so LinkProgram also compiles a
 * 1.00 partner of a translated shader as 3.00 (program-objects.ts).
 *
 * The translation (`translateEssl100`) works on the shader's preprocessed
 * tokens (essl-preprocessor.ts), so macros and conditional compilation have
 * already been applied exactly as the 1.00 compiler applied them, and emits
 * one line per guest line (with #line), so info logs and __LINE__ keep the
 * guest's numbering. Each difference between the languages it handles:
 *
 * - `#version 300 es` first; `attribute` becomes `in`, a vertex `varying`
 *   `out` and a fragment `varying` `in`.
 * - gl_FragColor and gl_FragData become a declared mediump vec4 output (an
 *   array of 1 for gl_FragData: ES 2.0 has one draw buffer, so constant
 *   index 1 stays a compile error). Using both is the error ANGLE reports
 *   for 1.00.
 * - The 1.00 texture lookups become their 3.00 names (texture2D -> texture,
 *   texture2DProj -> textureProj, texture2DLod -> textureLod, ...), only
 *   where the 1.00 function exists in that stage.
 * - Identifiers that ESSL 3.00 reserves or names (keywords such as `sample`,
 *   `layout`, `uint`; built-in functions such as `texture`, `round`) but that
 *   are ordinary identifiers in 1.00 are renamed to `kandelo_essl1_<name>`;
 *   guest identifiers beginning with `kandelo_essl` are escaped the same way,
 *   so the renaming is injective. Uniform and attribute names are
 *   API-visible: `nativeInterfaceName`/`guestInterfaceName` translate them
 *   for every reflection and location query of a translated program.
 * - ESSL 1.00 lets a shader overload a built-in function; ESSL 3.00 forbids
 *   declaring any function with a built-in's name. Such a name is renamed at
 *   every call and declaration, and private forwarders with the 1.00
 *   built-in signatures call the built-in. Calls inside constant expressions
 *   keep the built-in's name: there they can only have meant the built-in.
 * - ANGLE accepts non-constant global initializers in WebGL ESSL 1.00 (a
 *   compatibility warning) but not in 3.00. They run, in order, at the start
 *   of a new main() that then calls the guest's.
 * - ESSL 3.00 fragment inputs cannot be invariant, and `#pragma STDGL
 *   invariant(all)` is vertex-only. The fragment qualifiers are removed, and
 *   an invariant varying is renamed in both stages, so a vertex/fragment
 *   invariance mismatch that ES 1.00 makes a link error still fails to link
 *   (a statically used fragment input then has no vertex output).
 * - GL_OES_standard_derivatives: see `standardDerivativesShaderSource`.
 *
 * Known differences that remain (truthful gaps, see docs/architecture.md):
 * a fragment shader's `invariant gl_FragCoord` no longer requires the vertex
 * shader's gl_Position to be invariant; a dynamically indexed gl_FragData is
 * still rejected (ESSL 3.00 requires constant output indices); and a guest
 * ESSL 3.00 shader (which the host compiles as written) links with a
 * translated partner.
 */
import { preprocessEssl100, type EsslToken } from "./essl-preprocessor.js";

/** Renamed guest identifiers; never produced for host-private names. */
export const ESSL1_PREFIX = "kandelo_essl1_";
/** Host-private names the translation adds. */
const PRIVATE = "kandelo_essl3_";

/** ESSL 3.00 keywords and reserved words (ANGLE's lexer, glslang.l) and
 * ESSL 3.00 built-in function names that are ordinary identifiers in ESSL
 * 1.00. Over-inclusion is harmless: a renamed identifier means the same. */
const RESERVED_IN_300 = new Set([
  "case", "centroid", "smooth", "flat", "uint", "layout", "switch", "default", "packed",
  "mat2x2", "mat3x3", "mat4x4", "mat2x3", "mat3x2", "mat2x4", "mat4x2", "mat3x4", "mat4x3",
  "uvec2", "uvec3", "uvec4", "sampler3D", "sampler2DShadow", "sampler2DArray", "isampler2D", "isampler3D",
  "isamplerCube", "isampler2DArray", "usampler2D", "usampler3D", "usamplerCube", "usampler2DArray",
  "samplerCubeShadow", "sampler2DArrayShadow", "noperspective", "patch", "sample", "buffer", "shared",
  "sampler2DMS", "isampler2DMS", "usampler2DMS", "sampler2DMSArray", "isampler2DMSArray", "usampler2DMSArray",
  "samplerCubeArray", "samplerBuffer", "samplerCubeArrayShadow", "isamplerCubeArray", "isamplerBuffer",
  "usamplerCubeArray", "usamplerBuffer", "image2D", "iimage2D", "uimage2D", "image2DArray", "iimage2DArray",
  "uimage2DArray", "image3D", "uimage3D", "iimage3D", "iimageCube", "uimageCube", "imageCube", "imageCubeArray",
  "iimageCubeArray", "uimageCubeArray", "imageBuffer", "iimageBuffer", "uimageBuffer", "readonly", "writeonly",
  "coherent", "restrict", "atomic_uint", "precise", "resource", "subroutine", "common", "partition", "active",
  "filter", "image1D", "iimage1D", "uimage1D", "image1DArray", "iimage1DArray", "uimage1DArray", "sampler1DArray",
  "sampler1DArrayShadow", "isampler1D", "isampler1DArray", "usampler1D", "usampler1DArray", "isampler2DRect",
  "usampler2DRect", "yuvCscStandardEXT", "itu_601", "itu_601_full_range", "itu_709", "pixelLocalANGLE",
  "ipixelLocalANGLE", "upixelLocalANGLE",
  // ESSL 3.00 built-in functions without an ESSL 1.00 namesake.
  "texture", "textureProj", "textureLod", "textureProjLod", "textureOffset", "textureProjOffset",
  "textureLodOffset", "textureProjLodOffset", "texelFetch", "texelFetchOffset", "textureGrad",
  "textureGradOffset", "textureProjGrad", "textureProjGradOffset", "textureSize", "sinh", "cosh", "tanh",
  "asinh", "acosh", "atanh", "trunc", "round", "roundEven", "modf", "isnan", "isinf", "floatBitsToInt",
  "floatBitsToUint", "intBitsToFloat", "uintBitsToFloat", "packSnorm2x16", "unpackSnorm2x16",
  "packUnorm2x16", "unpackUnorm2x16", "packHalf2x16", "unpackHalf2x16", "outerProduct", "transpose",
  "determinant", "inverse", "dFdx", "dFdy", "fwidth",
]);

const renamed = (name: string) => RESERVED_IN_300.has(name) || name.startsWith("kandelo_essl");

/** The native (translated) name of a guest uniform or attribute path such as
 * `light.sample[2]`. */
export function nativeInterfaceName(guest: string): string {
  return guest.replace(/[A-Za-z_][A-Za-z0-9_]*/g, segment => renamed(segment) ? ESSL1_PREFIX + segment : segment);
}

/** The guest's name of a native reflection name of a translated program. */
export function guestInterfaceName(native: string): string {
  return native.replace(/[A-Za-z_][A-Za-z0-9_]*/g,
    segment => segment.startsWith(ESSL1_PREFIX) ? segment.slice(ESSL1_PREFIX.length) : segment);
}

/**
 * Every error ANGLE's ValidateLimitations pass reports (Appendix A loop and
 * index restrictions). "Index expression can only contain const or loop
 * symbols" is the older wording of "Index expression must be constant"
 * that Chromium's and WebKit's ANGLE still use.
 */
const LIMITATION_MESSAGES = [
  "This type of loop is not allowed", "Missing init declaration", "Invalid init declaration",
  "Invalid type for loop index", "Loop index cannot be initialized with non-constant expression",
  "Missing condition", "Invalid condition", "Expected loop index", "Invalid relational operator",
  "Loop index cannot be compared with non-constant expression", "Missing expression", "Invalid expression",
  "Invalid built-in call", "Invalid operator", "Loop index cannot be modified by non-constant expression",
  "Loop index cannot be statically assigned to within the body of the loop",
  "Index expression must be constant", "Index expression can only contain const or loop symbols",
];

/** True when a failed ESSL 1.00 compile's info log reports errors and every
 * one is an Appendix A limitation: the shader is otherwise valid ES 1.00. */
export function onlyAppendixALimitations(log: string): boolean {
  const errors = log.split("\n").filter(line => /^\s*ERROR:/.test(line));
  return errors.length > 0 && errors.every(line =>
    LIMITATION_MESSAGES.some(message => line.endsWith(`: ${message}`) || line.includes(`: ${message} `)));
}

// --- compiling a guest shader ----------------------------------------------------

/** What a compiled guest shader object holds natively: its ES 1.00 source,
 * the ESSL 3.00 translation of it, or a source the guest wrote in another
 * language version (compiled as written). */
export type ShaderLanguage = "essl100" | "essl300" | "guest";

const COMPILE_STATUS = 0x8b81;
const GUEST_VERSION = /^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m;

/**
 * CompileShader of a guest source (after the ES 1.00 extension rewrites of
 * shader-source.ts): the ES 1.00 compile decides validity, and a shader it
 * rejects only for Appendix A, or that enables the derivatives, is compiled
 * again as its ESSL 3.00 translation. Null when the compile failed; the
 * shader object then holds the native failure and info log the guest sees.
 * Pure WebGL calls, shared with the real-compiler harness.
 */
export function compileGuestShader(gl: WebGL2RenderingContext, shader: WebGLShader, source: string,
    fragment: boolean): ShaderLanguage | null {
  if (GUEST_VERSION.test(source) && !/^\s*#\s*version\s+100\b/m.test(source)) {
    gl.shaderSource(shader, source); gl.compileShader(shader);
    return gl.getShaderParameter(shader, COMPILE_STATUS) ? "guest" : null;
  }
  const validation = derivativeValidationSource(source, fragment);
  gl.shaderSource(shader, validation ?? source); gl.compileShader(shader);
  const compiled = !!gl.getShaderParameter(shader, COMPILE_STATUS);
  if (!compiled && !onlyAppendixALimitations(gl.getShaderInfoLog(shader) ?? "")) return null;
  // Only a fragment shader's derivative declarations stand in for
  // built-ins; a vertex shader's validation source means what its source does.
  if (compiled && (validation === null || !fragment)) return "essl100";
  return compileEssl300(gl, shader, source, fragment) ? "essl300" : null;
}

/** Compile the ESSL 3.00 translation of an ES 1.00 source that the ES 1.00
 * compiler accepted (or rejected only for Appendix A). A translator fault
 * fails the compile with its message rather than leaving the shader object
 * in its ES 1.00 state. */
export function compileEssl300(gl: WebGL2RenderingContext, shader: WebGLShader, source: string, fragment: boolean): boolean {
  let text: string;
  try { text = translateEssl100(source, fragment).text; }
  catch (caught) {
    text = `#version 300 es\n#error Kandelo could not translate this ESSL 1.00 shader to ESSL 3.00: ${
      String(caught instanceof Error ? caught.message : caught).replace(/\s+/g, " ")}\n`;
  }
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  return !!gl.getShaderParameter(shader, COMPILE_STATUS);
}

// --- host state ---------------------------------------------------------------------

type CompiledShader = { language: ShaderLanguage; source: string; fragment: boolean };
const compiledShaders = new WeakMap<WebGLShader, CompiledShader>();

/** After every CompileShader: the language the shader object now holds and
 * the ES 1.00 source it was compiled from; null for a failed compile. */
export function recordShaderLanguage(shader: WebGLShader, language: ShaderLanguage | null, source: string, fragment: boolean): void {
  if (language) compiledShaders.set(shader, { language, source, fragment });
  else compiledShaders.delete(shader);
}

export function shaderLanguage(shader: WebGLShader): ShaderLanguage | undefined {
  return compiledShaders.get(shader)?.language;
}

/**
 * Before LinkProgram. ES forbids linking shaders written in different
 * language versions, so a shader compiled as ES 1.00 that is linked with a
 * translated one is compiled again as its own ESSL 3.00 translation (it is
 * valid ES 1.00, so its translation compiles). GLES links the compiled
 * state, which for that shader is unchanged in meaning; only its info log
 * now comes from the 3.00 compile. Should that compile fail anyway (a
 * translator defect), its ES 1.00 compile is restored and the native link
 * reports the version mismatch. A shader the guest wrote in ESSL 3.00 is
 * never recompiled. True when the program links translated shaders, whose
 * interface names the reflection queries translate.
 */
export function prepareLinkLanguages(gl: WebGL2RenderingContext, shaders: readonly WebGLShader[]): boolean {
  const entries = shaders.map(shader => compiledShaders.get(shader));
  if (!entries.some(entry => entry?.language === "essl300")) return false;
  for (const [i, entry] of entries.entries()) {
    if (entry?.language !== "essl100") continue;
    if (compileEssl300(gl, shaders[i], entry.source, entry.fragment)) { entry.language = "essl300"; continue; }
    gl.shaderSource(shaders[i], entry.source);
    gl.compileShader(shaders[i]);
  }
  return true;
}

const translatedPrograms = new WeakSet<WebGLProgram>();
/** After every native link attempt, and for each private executable built
 * from a program's sources (attribute-aliasing.ts). */
export function recordProgramLanguage(program: WebGLProgram, translated: boolean): void {
  if (translated) translatedPrograms.add(program); else translatedPrograms.delete(program);
}
export function isTranslatedProgram(program: WebGLProgram | null | undefined): boolean {
  return !!program && translatedPrograms.has(program);
}
/** A uniform or attribute name as the guest knows it. */
export function programGuestName(program: WebGLProgram, native: string): string {
  return translatedPrograms.has(program) ? guestInterfaceName(native) : native;
}
/** The name WebGL knows for a guest's uniform or attribute name. */
export function programNativeName(program: WebGLProgram, guest: string): string {
  return translatedPrograms.has(program) ? nativeInterfaceName(guest) : guest;
}

// --- GL_OES_standard_derivatives ---------------------------------------------

const DERIVATIVES = "GL_OES_standard_derivatives";
const DERIVATIVE_FUNCTIONS = ["dFdx", "dFdy", "fwidth"];
/** A guest's dFdx/dFdy/fwidth token, and the function it names where the
 * extension is enabled. */
const derivativeName = (f: string) => `kandelo_oes_${f}`;
const derivativeBuiltin = (f: string) => `kandelo_oes_${f}_builtin`;
const DERIVATIVE_MACRO = "kandelo_GL_OES_standard_derivatives";
const GEN_TYPES = ["float", "vec2", "vec3", "vec4"];

/**
 * GL_OES_standard_derivatives on WebGL 2. Kandelo advertises the extension
 * because WebGL 2 has the derivatives, but WebGL 2 offers them only to ESSL
 * 3.00 shaders: it enables no ESSL 1.00 extension, so `#extension
 * GL_OES_standard_derivatives : require` failed and dFdx was undeclared.
 * Applied to every guest ESSL 1.00 source once per ShaderSource:
 *
 * - The extension's macro reads 1. `GL_` macro names are reserved (and
 *   engines reject defining one), so uses of the name are renamed to a
 *   private macro defined as 1, as for GL_OES_EGL_image_external
 *   (external-texture.ts). A guest #define or #undef of it stays, for the
 *   engine to reject.
 * - Each dFdx, dFdy and fwidth token becomes `kandelo_oes_<f>`, a macro
 *   that names the guest's own identifier until an #extension directive
 *   enables the extension: the directive becomes (on its own line) the
 *   redefinitions that make those names the built-ins (enable, require,
 *   warn) or the guest's identifiers again (disable). So the functions exist
 *   exactly where the extension is enabled, including under conditional
 *   compilation, and elsewhere the names are ordinary identifiers, as in
 *   ES 1.00.
 * - For the ESSL 1.00 compile that judges validity, the built-ins are
 *   declared as functions with the extension's genType signatures
 *   (`derivativeValidationSource`), so calls type-check exactly as against
 *   the real built-ins; a shader that enables the extension is then
 *   compiled as ESSL 3.00, where `translateEssl100` defines them as calls of
 *   the core dFdx, dFdy and fwidth. The functions exist only in fragment
 *   shaders, as the extension specifies.
 */
export function standardDerivativesShaderSource(source: string): string {
  if (!source.includes(DERIVATIVES) && !DERIVATIVE_FUNCTIONS.some(f => source.includes(f))) return source;
  if (/^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m.test(source)) return source;
  const lines = source.split("\n");
  const out: string[] = [];
  let changed = false;
  // Tokens of the extension's macro and functions outside comments.
  let inComment = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const directive = !inComment ? /^\s*#\s*(\w+)/.exec(line)?.[1] : undefined;
    if (directive === "extension") {
      const match = /^\s*#\s*extension\s+(\w+)\s*:\s*(\w+)\s*(\/\/.*|\/\*.*\*\/\s*)?$/.exec(line);
      const behavior = match?.[2];
      const define = behavior === "enable" || behavior === "require" || behavior === "warn";
      const directives = DERIVATIVE_FUNCTIONS.map(f =>
        `#undef ${derivativeName(f)}\n#define ${derivativeName(f)} ${define ? derivativeBuiltin(f) : f}`);
      if (match && match[1] === DERIVATIVES && (define || behavior === "disable")) {
        // The directives replace the directive's line; restore the numbering.
        out.push(`${directives.join("\n")}\n#line ${index + 2}`);
        changed = true; continue;
      }
      if (match && match[1] === "all" && (behavior === "warn" || behavior === "disable")) {
        // `all` also governs WebGL's own extensions: keep it as written.
        out.push(`${line}\n${directives.join("\n")}\n#line ${index + 2}`);
        changed = true; continue;
      }
      out.push(line); continue;
    }
    const keepName = directive === "define" || directive === "undef";
    let text = "";
    for (let i = 0; i < line.length;) {
      if (inComment) {
        const end = line.indexOf("*/", i);
        if (end < 0) { text += line.slice(i); i = line.length; break; }
        text += line.slice(i, end + 2); i = end + 2; inComment = false; continue;
      }
      if (line.startsWith("//", i)) { text += line.slice(i); break; }
      if (line.startsWith("/*", i)) { inComment = true; text += "/*"; i += 2; continue; }
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))?.[0];
      if (!word) { const number = /^[0-9.][A-Za-z0-9_.]*/.exec(line.slice(i))?.[0] ?? line[i]; text += number; i += number.length; continue; }
      // The macro name after #define/#undef stays for the engine to reject.
      const definedName = keepName && word === DERIVATIVES && /^\s*#\s*(define|undef)\s*$/.test(text);
      if (word === DERIVATIVES && !definedName) { text += DERIVATIVE_MACRO; changed = true; }
      else if (DERIVATIVE_FUNCTIONS.includes(word)) { text += derivativeName(word); changed = true; }
      else text += word;
      i += word.length;
    }
    out.push(text);
  }
  if (!changed) return source;
  const text = out.join("\n");
  // Where the extension is not enabled the names are the guest's own (an
  // undeclared dFdx is reported as dFdx).
  return insertAfterHeader(text, [`#define ${DERIVATIVE_MACRO} 1`,
    ...DERIVATIVE_FUNCTIONS.map(f => `#define ${derivativeName(f)} ${f}`)].join("\n"));
}

/** Text after the leading #version/#extension/#pragma lines, with #line
 * restoring the guest's numbering. */
function insertAfterHeader(source: string, lines: string): string {
  let i = 0, end = 0;
  const n = source.length;
  for (;;) {
    while (i < n) {
      if (source[i] === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; }
      else if (source[i] === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; }
      else if (/\s/.test(source[i])) i++;
      else break;
    }
    if (source[i] !== "#") break;
    const directive = /^#\s*([A-Za-z_]+)/.exec(source.slice(i, i + 64))?.[1];
    if (directive !== "version" && directive !== "extension" && directive !== "pragma") break;
    while (i < n && source[i] !== "\n") i++;
    if (i < n) i++;
    end = i;
  }
  const lead = end > 0 && source[end - 1] !== "\n" ? "\n" : "";
  const line = source.slice(0, end).split("\n").length + (lead ? 1 : 0);
  return `${source.slice(0, end)}${lead}${lines}\n#line ${line}\n${source.slice(end)}`;
}

/** The source the ESSL 1.00 validity compile sees: the derivative
 * built-ins declared with their signatures in a fragment shader that names
 * them (see `standardDerivativesShaderSource`). Null when the shader needs no
 * declarations, so its 1.00 source is compiled as is. */
export function derivativeValidationSource(source: string, fragment: boolean): string | null {
  if (!DERIVATIVE_FUNCTIONS.some(f => source.includes(derivativeBuiltin(f)))) return null;
  // A vertex shader has no derivatives: its uses are reported as dFdx etc.
  if (!fragment) return insertAfterHeader(source, DERIVATIVE_FUNCTIONS.map(f => `#define ${derivativeBuiltin(f)} ${f}`).join("\n"));
  const stubs = DERIVATIVE_FUNCTIONS.flatMap(f => GEN_TYPES.map(type =>
    `highp ${type} ${derivativeBuiltin(f)}(highp ${type} p) { return p; }`));
  return insertAfterHeader(source, stubs.join("\n"));
}

// --- ES 1.00 built-in functions a guest may overload -------------------------

type Signature = { ret: string; params: string[]; call?: string };
const g = (f: (type: string) => Signature) => GEN_TYPES.map(f);
const unaryGen = (name: string) => g(t => ({ ret: t, params: [t] }));
const vectors = (prefix: string) => [2, 3, 4].map(n => `${prefix}${n}`);
/** ES 1.00 section 8 signatures, by stage availability. */
function builtinSignatures(name: string, fragment: boolean): Signature[] | null {
  switch (name) {
    case "radians": case "degrees": case "sin": case "cos": case "tan": case "asin": case "acos":
    case "exp": case "log": case "exp2": case "log2": case "sqrt": case "inversesqrt":
    case "abs": case "sign": case "floor": case "ceil": case "fract": case "normalize":
      return unaryGen(name);
    case "atan": return [...unaryGen(name), ...g(t => ({ ret: t, params: [t, t] }))];
    case "pow": case "step": case "reflect":
      return [...g(t => ({ ret: t, params: [t, t] })),
        ...(name === "step" ? g(t => ({ ret: t, params: ["float", t] })).slice(1) : [])];
    case "mod": case "min": case "max":
      return [...g(t => ({ ret: t, params: [t, t] })), ...g(t => ({ ret: t, params: [t, "float"] })).slice(1)];
    case "clamp":
      return [...g(t => ({ ret: t, params: [t, t, t] })), ...g(t => ({ ret: t, params: [t, "float", "float"] })).slice(1)];
    case "mix":
      return [...g(t => ({ ret: t, params: [t, t, t] })), ...g(t => ({ ret: t, params: [t, t, "float"] })).slice(1)];
    case "smoothstep":
      return [...g(t => ({ ret: t, params: [t, t, t] })), ...g(t => ({ ret: t, params: ["float", "float", t] })).slice(1)];
    case "length": return g(t => ({ ret: "float", params: [t] }));
    case "distance": case "dot": return g(t => ({ ret: "float", params: [t, t] }));
    case "cross": return [{ ret: "vec3", params: ["vec3", "vec3"] }];
    case "faceforward": return g(t => ({ ret: t, params: [t, t, t] }));
    case "refract": return g(t => ({ ret: t, params: [t, t, "float"] }));
    case "matrixCompMult": return ["mat2", "mat3", "mat4"].map(t => ({ ret: t, params: [t, t] }));
    case "lessThan": case "lessThanEqual": case "greaterThan": case "greaterThanEqual":
      return [2, 3, 4].flatMap(n => [`vec${n}`, `ivec${n}`].map(t => ({ ret: `bvec${n}`, params: [t, t] })));
    case "equal": case "notEqual":
      return [2, 3, 4].flatMap(n => [`vec${n}`, `ivec${n}`, `bvec${n}`].map(t => ({ ret: `bvec${n}`, params: [t, t] })));
    case "any": case "all": return vectors("bvec").map(t => ({ ret: "bool", params: [t] }));
    case "not": return vectors("bvec").map(t => ({ ret: t, params: [t] }));
    case "texture2D": return [{ ret: "vec4", params: ["sampler2D", "vec2"], call: "texture" },
      ...(fragment ? [{ ret: "vec4", params: ["sampler2D", "vec2", "float"], call: "texture" }] : [])];
    case "texture2DProj": return ["vec3", "vec4"].flatMap(c => [{ ret: "vec4", params: ["sampler2D", c], call: "textureProj" },
      ...(fragment ? [{ ret: "vec4", params: ["sampler2D", c, "float"], call: "textureProj" }] : [])]);
    case "textureCube": return [{ ret: "vec4", params: ["samplerCube", "vec3"], call: "texture" },
      ...(fragment ? [{ ret: "vec4", params: ["samplerCube", "vec3", "float"], call: "texture" }] : [])];
    case "texture2DLod": return fragment ? null : [{ ret: "vec4", params: ["sampler2D", "vec2", "float"], call: "textureLod" }];
    case "texture2DProjLod": return fragment ? null : ["vec3", "vec4"].map(c => ({ ret: "vec4", params: ["sampler2D", c, "float"], call: "textureProjLod" }));
    case "textureCubeLod": return fragment ? null : [{ ret: "vec4", params: ["samplerCube", "vec3", "float"], call: "textureLod" }];
    default: return null;
  }
}

/** ES 1.00 texture lookups and their ESSL 3.00 names, by stage. */
const LOOKUPS_300: Record<string, string> = { texture2D: "texture", texture2DProj: "textureProj", textureCube: "texture",
  texture2DLod: "textureLod", texture2DProjLod: "textureProjLod", textureCubeLod: "textureLod" };
const VERTEX_ONLY_LOOKUPS = new Set(["texture2DLod", "texture2DProjLod", "textureCubeLod"]);

const precise = (type: string) => /^(float|vec\d|mat\d|ivec\d|int)$/.test(type) ? `highp ${type}` : type;

function forwarders(name: string, signatures: Signature[]): string {
  return signatures.map(s => {
    const params = s.params.map((type, i) => `${precise(type)} p${i}`).join(", ");
    const args = s.params.map((_, i) => `p${i}`).join(", ");
    return `${precise(s.ret)} ${ESSL1_PREFIX}${name}(${params}) { return ${s.call ?? name}(${args}); }`;
  }).join("\n");
}

// --- translation ----------------------------------------------------------------

const BASIC_TYPES = new Set(["void", "bool", "int", "float", "vec2", "vec3", "vec4", "bvec2", "bvec3", "bvec4",
  "ivec2", "ivec3", "ivec4", "mat2", "mat3", "mat4", "sampler2D", "samplerCube"]);
const PRECISIONS = new Set(["lowp", "mediump", "highp"]);
const DECLARATION_QUALIFIERS = new Set(["const", "uniform", "attribute", "varying", "precision", "invariant", "struct"]);

export type Essl3Translation = { text: string; error?: undefined } | { text: string; error: string };

/**
 * The ESSL 3.00 source with the meaning of an ESSL 1.00 source that the
 * native ESSL 1.00 compiler accepted, or rejected only for Appendix A
 * limitations (see the file comment). `error` is set, and `text` is a
 * source that fails with that message, when the shader breaks the one ES
 * 1.00 rule that ANGLE checks after Appendix A.
 */
export function translateEssl100(source: string, fragment: boolean): Essl3Translation {
  const { tokens, directives } = preprocessEssl100(source);
  const n = tokens.length;
  const text = tokens.map(t => t.text);
  const id = (i: number) => tokens[i]?.kind === "id";
  const at = (i: number) => tokens[i]?.text;
  const afterDot = (i: number) => at(i - 1) === ".";

  // Brace depth before each token, struct names, and struct body ranges.
  const depth = new Int32Array(n + 1);
  const structs = new Set<string>();
  const inStruct = new Uint8Array(n);
  for (let i = 0, d = 0, structOpen = -1; i < n; i++) {
    depth[i] = d;
    if (at(i) === "struct" && id(i + 1) && at(i + 2) === "{") structs.add(at(i + 1)!);
    if (at(i) === "{") {
      if (at(i - 1) === "struct" || (at(i - 2) === "struct" && id(i - 1))) structOpen = d;
      d++;
    } else if (at(i) === "}") { d--; if (d === structOpen) structOpen = -1; }
    if (structOpen >= 0 && d > structOpen) inStruct[i] = 1;
  }
  const typeToken = (i: number) => BASIC_TYPES.has(at(i) ?? "") || structs.has(at(i) ?? "");

  // Function names the shader declares (global scope, outside initializers).
  const declared = new Set<string>();
  for (let i = 0, paren = 0, init = false; i < n; i++) {
    const t = at(i)!;
    if (depth[i] !== 0) continue;
    if (t === "(") paren++;
    else if (t === ")") paren--;
    else if (paren === 0 && t === "=") init = true;
    else if (paren === 0 && (t === ";" || t === ",")) init = false;
    if (paren === 0 && !init && id(i) && at(i + 1) === "(" && (id(i - 1) || typeToken(i - 1)) && !DECLARATION_QUALIFIERS.has(at(i - 1)!))
      declared.add(t);
  }
  const overloaded = new Map<string, Signature[]>();
  for (const name of declared) {
    const signatures = builtinSignatures(name, fragment);
    if (signatures) overloaded.set(name, signatures);
  }

  // Constant-expression contexts: const initializers and declared array sizes.
  const constant = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (at(i) === "const") {
      let nest = 0, init = false;
      for (let j = i + 1; j < n; j++) {
        const t = at(j)!;
        if (t === "(" || t === "[") nest++;
        else if (t === ")" || t === "]") { if (nest === 0) break; nest--; }
        if (nest === 0 && t === ";") break;
        if (nest === 0 && t === "=") { init = true; continue; }
        if (nest === 0 && t === ",") { init = false; continue; }
        if (init) constant[j] = 1;
      }
    }
    if (at(i) === "[" && id(i - 1) && (typeToken(i - 2) || PRECISIONS.has(at(i - 2) ?? ""))) {
      for (let j = i + 1, nest = 0; j < n; j++) {
        if (at(j) === "[") nest++;
        else if (at(j) === "]") { if (nest === 0) break; nest--; }
        constant[j] = 1;
      }
    }
  }

  // Varyings and their invariance (ES 1.00 section 4.6.4).
  const varyings = new Set<string>(), invariant = new Set<string>();
  const dropped = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (depth[i] !== 0) continue;
    if (at(i) === "varying" || (at(i) === "invariant" && at(i + 1) === "varying")) {
      const isInvariant = at(i) === "invariant";
      let j = i + (isInvariant ? 2 : 1);
      for (; j < n && at(j) !== ";"; j++)
        if (id(j) && (at(j + 1) === "," || at(j + 1) === ";" || at(j + 1) === "[") && !typeToken(j) && !PRECISIONS.has(at(j)!)) {
          varyings.add(at(j)!); if (isInvariant) invariant.add(at(j)!);
        }
      if (isInvariant && fragment) dropped[i] = 1;
      i = j;
    } else if (at(i) === "invariant" && id(i + 1)) {
      // `invariant name, ...;` redeclares outputs (vertex) or inputs (fragment).
      let j = i + 1;
      for (; j < n && at(j) !== ";"; j++) if (id(j)) invariant.add(at(j)!);
      if (fragment) for (let k = i; k <= j; k++) dropped[k] = 1;
      i = j;
    }
  }
  const pragmas = directives.filter(d => d.kind === "pragma");
  const invariantAll = (d: { tokens: string[] }) => d.tokens.join("") === "STDGLinvariant(all)";
  if (!fragment && pragmas.some(invariantAll)) for (const name of varyings) invariant.add(name);
  for (const name of [...invariant]) if (!varyings.has(name)) invariant.delete(name);

  // Fragment outputs.
  const usesColor = fragment && text.includes("gl_FragColor"), usesData = fragment && text.includes("gl_FragData");
  if (usesColor && usesData) {
    const first = tokens.find(t => t.text === "gl_FragColor" || t.text === "gl_FragData")!;
    const message = "cannot use both gl_FragData and gl_FragColor";
    return { text: `#version 300 es\n#line ${first.line}\n#error ${message}\n`, error: message };
  }

  // Global initializers that are not constant expressions run in main().
  const constGlobals = new Set<string>();
  const deferred: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < n;) {
    if (depth[i] !== 0) { i++; continue; }
    // One global statement or function definition.
    let j = i, nest = 0, body = false;
    for (; j < n; j++) {
      const t = at(j)!;
      if (t === "(" || t === "[") nest++;
      else if (t === ")" || t === "]") nest--;
      else if (t === "{") {
        if (at(j - 1) === ")") { body = true; break; }
        let d = 0; for (; j < n; j++) { if (at(j) === "{") d++; else if (at(j) === "}" && --d === 0) break; }
      } else if (t === ";" && nest === 0) break;
    }
    if (body) { while (j < n && !(at(j) === "}" && depth[j] === 1)) j++; i = j + 1; continue; }
    let s = i;
    while (PRECISIONS.has(at(s) ?? "")) s++;
    const qualifier = at(s)!;
    if (qualifier === "const") {
      for (let k = s; k < j; k++) if (id(k) && at(k + 1) === "=") constGlobals.add(at(k)!);
    } else if (!DECLARATION_QUALIFIERS.has(qualifier)) {
      for (let k = s, nesting = 0; k < j; k++) {
        const t = at(k)!;
        if (t === "(" || t === "[") nesting++;
        else if (t === ")" || t === "]") nesting--;
        if (t !== "=" || nesting !== 0 || !id(k - 1)) continue;
        let e = k + 1;
        for (let m = 0; e < j; e++) {
          if (at(e) === "(" || at(e) === "[") m++;
          else if (at(e) === ")" || at(e) === "]") m--;
          else if (at(e) === "," && m === 0) break;
        }
        const nonConstant = tokens.slice(k + 1, e).some((t, offset) => t.kind === "id" && !afterDot(k + 1 + offset)
          && at(k + 2 + offset) !== "(" && !constGlobals.has(t.text) && t.text !== "true" && t.text !== "false");
        if (nonConstant) { deferred.push({ name: at(k - 1)!, from: k, to: e }); for (let m = k; m < e; m++) dropped[m] = 1; }
        k = e - 1;
      }
    }
    i = j + 1;
  }

  // Token rewrites.
  const out = text.slice();
  for (let i = 0; i < n; i++) {
    if (!id(i)) continue;
    const t = text[i], call = at(i + 1) === "(";
    if (t === "attribute") out[i] = "in";
    else if (t === "varying") out[i] = fragment ? "in" : "out";
    else if (t === "gl_FragColor") out[i] = `${PRIVATE}FragColor`;
    else if (t === "gl_FragData") out[i] = `${PRIVATE}FragData`;
    else if (invariant.has(t) && !afterDot(i) && !inStruct[i]) out[i] = `${PRIVATE}invariant_${t}`;
    else if (renamed(t)) out[i] = ESSL1_PREFIX + t;
    else if (call && overloaded.has(t) && !constant[i]) out[i] = ESSL1_PREFIX + t;
    else if (call && !overloaded.has(t) && t in LOOKUPS_300 && (!fragment || !VERTEX_ONLY_LOOKUPS.has(t)) && !declared.has(t))
      out[i] = LOOKUPS_300[t];
    else if (t === "main" && deferred.length && !afterDot(i)) out[i] = `${PRIVATE}main`;
  }

  // Header: version, outputs, forwarders.
  const header = ["#version 300 es"];
  if (!fragment && pragmas.some(invariantAll)) header.push("#pragma STDGL invariant(all)");
  if (usesColor) header.push(`layout(location = 0) out mediump vec4 ${PRIVATE}FragColor;`);
  if (usesData) header.push(`layout(location = 0) out mediump vec4 ${PRIVATE}FragData[1];`);
  for (const [name, signatures] of overloaded) header.push(forwarders(name, signatures));
  if (fragment) for (const f of DERIVATIVE_FUNCTIONS) if (text.includes(derivativeBuiltin(f)))
    header.push(GEN_TYPES.map(type => `highp ${type} ${derivativeBuiltin(f)}(highp ${type} p) { return ${f}(p); }`).join("\n"));

  // Code, one output line per guest line.
  let body = "", line = -1, file = 0, fresh = true;
  const moveTo = (to: number, toFile: number) => {
    if (line >= 0 && toFile === file && to >= line && to - line <= 16) body += "\n".repeat(to - line);
    else body += `${line >= 0 ? "\n" : ""}#line ${to}${toFile ? ` ${toFile}` : ""}\n`;
    if (to !== line || toFile !== file) fresh = true;
    line = to; file = toFile;
  };
  let next = 0;
  const emitDirective = (d: typeof directives[number]) => {
    if (d.kind !== "pragma" || invariantAll(d)) return;
    moveTo(d.line, d.file);
    if (!fresh) { body += "\n"; line++; moveTo(d.line, d.file); }
    body += `#pragma ${d.tokens.join(" ")}`; fresh = false;
  };
  for (let i = 0; i < n; i++) {
    while (next < directives.length && directives[next].at <= i) emitDirective(directives[next++]);
    if (dropped[i]) continue;
    const t: EsslToken = tokens[i];
    if (t.line !== line || t.file !== file) moveTo(t.line, t.file);
    body += (fresh ? "" : " ") + out[i]; fresh = false;
  }
  while (next < directives.length) emitDirective(directives[next++]);
  if (deferred.length) {
    const assignments = deferred.map(d => `${out[d.from - 1]} = ${out.slice(d.from + 1, d.to).join(" ")};`).join(" ");
    body += `\nvoid main() { ${assignments} ${PRIVATE}main(); }`;
  }
  return { text: `${header.join("\n")}\n${body}\n` };
}
