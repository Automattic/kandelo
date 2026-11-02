/**
 * GL_OES_EGL_image_external on WebGL 2.
 *
 * An external texture (TEXTURE_EXTERNAL_OES) is a texture object that can
 * only be given an EGLImage, is sampled through `samplerExternalOES`, and has
 * its own binding point on every texture unit. WebGL 2 has no such target,
 * so:
 *
 * - The object is an ordinary native 2D texture (an EGLImage sibling view,
 *   image-storage.ts) that is never bound natively by the guest's binding
 *   commands. Each unit's external binding lives in the shadow
 *   (`externalTextureUnits`), separate from its TEXTURE_2D binding, as the
 *   extension requires.
 * - A shader's `samplerExternalOES` becomes `sampler2D` when its source is
 *   given to WebGL (`externalShaderSource`, once per ShaderSource; no draw
 *   pays for it). The type token is renamed to a private macro that the
 *   shader's own `#extension GL_OES_EGL_image_external` directive defines,
 *   so the type exists exactly where the extension is enabled, including
 *   under conditional compilation. The extension's macro must read as 1,
 *   like every supported extension's macro, but GLSL ES 1.00 section 3.4
 *   reserves `GL_` macro names and every engine rejects defining one
 *   (Chromium: "predefined macro redefined"; Firefox, WebKit: "macro name
 *   is reserved"). So the guest's uses of `GL_OES_EGL_image_external`
 *   (`#ifdef`, `#if defined`, expressions) are renamed to a private macro
 *   defined as 1. A guest `#define` or `#undef` of that name is left as
 *   written, so the engine rejects it, as an ES compiler must. Reflection
 *   reports SAMPLER_EXTERNAL_OES for those samplers (`guestUniformType`).
 * - A draw whose program samples external textures binds each such unit's
 *   external texture to that unit's native TEXTURE_2D for the draw and
 *   restores the unit's guest TEXTURE_2D binding afterwards (draw-state.ts).
 *   Programs without external samplers pay one WeakMap lookup per draw. A
 *   sampler2D and a samplerExternalOES on the same unit are two sampler
 *   types on one unit, which ES 2.0 section 2.10.4 makes INVALID_OPERATION
 *   at draw (and a ValidateProgram failure); WebGL sees two sampler2Ds, so
 *   the host checks that itself.
 *
 * An external texture samples one RGBA image (a YUV image is converted when
 * its bytes change, cpu-image-storage.ts), so REQUIRED_TEXTURE_IMAGE_UNITS_OES
 * is 1 and no unit or uniform is reserved from the advertised limits.
 */
import type { GlBinding } from "./registry.js";
import { glslTokens, type GlslToken } from "./attribute-aliasing.js";
import { headerEnd } from "./reversed-depth.js";
import { checkedGlCall, programLinkGeneration, recordGlError } from "./program-objects.js";
import { samplerWriteGeneration } from "./depth-sampling.js";
import { refreshTextureView, textureNative } from "./image-storage.js";
import { nativeTextureBinding } from "./texture-bindings.js";
import { rethrowNativeGlFault } from "./native-recovery.js";
import { programGuestName, shaderSamplesCube } from "./essl3-translation.js";
import { cubeSamplingTexture, TEXTURE_2D_ARRAY } from "./cube-storage.js";

export const TEXTURE_EXTERNAL_OES = 0x8d65;
export const SAMPLER_EXTERNAL_OES = 0x8d66;
const TEX = 0x0de1, CUBE = 0x8513, SAMPLER_2D = 0x8b5e, SAMPLER_CUBE = 0x8b60, SAMPLER_2D_ARRAY = 0x8dc1;
const EXTENSION = "GL_OES_EGL_image_external";
const GUEST_TYPE = "samplerExternalOES";
const NATIVE_TYPE = "kandelo_samplerExternalOES";
/** The private name of the extension's macro (see the file comment). */
const NATIVE_MACRO = "kandelo_GL_OES_EGL_image_external";

// --- shader source -----------------------------------------------------------

export type ExternalShaderSource = {
  /** The source WebGL compiles. */
  text: string;
  /** Uniform paths of external samplers (array indices removed). */
  samplers: string[];
};

/** The WebGL source of a guest shader. ESSL 3.00 sources and sources that
 * never mention the extension compile unchanged: the extension's macro and
 * type are then unobservable. */
export function externalShaderSource(source: string): ExternalShaderSource {
  if (/^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m.test(source)
      || (!source.includes(EXTENSION) && !source.includes(GUEST_TYPE)))
    return { text: source, samplers: [] };
  const list = glslTokens(source, true);
  const edits: Edit[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  // Tokens of the extension's name that are not uses of its macro.
  const keep = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.text === EXTENSION && !keep.has(i)) edits.push({ at: t.start, end: t.end, text: NATIVE_MACRO });
    if (t.directive && t.text === "#") {
      const lineEnd = source.indexOf("\n", t.start) < 0 ? source.length : source.indexOf("\n", t.start);
      const directive: GlslToken[] = [];
      for (let j = i; j < list.length && list[j].start < lineEnd; j++) directive.push(list[j]);
      const [, keyword, name, colon, behavior] = directive.map(token => token.text);
      // #extension names the extension, not its macro; #define and #undef
      // of the reserved name stay for the engine to reject.
      if (keyword === "extension") directive.forEach((_, k) => keep.add(i + k));
      if ((keyword === "define" || keyword === "undef") && name === EXTENSION) keep.add(i + 2);
      if (keyword === "extension" && colon === ":" && directive.length === 5) {
        const define = behavior === "enable" || behavior === "require" || behavior === "warn"
          ? `#define ${NATIVE_TYPE} sampler2D` : behavior === "disable" ? `#undef ${NATIVE_TYPE}` : null;
        if (define && name === EXTENSION) {
          // WebGL does not know this extension: the directive becomes the
          // definition of the type it enables, on the same line.
          edits.push({ at: t.start, end: directive[4].end, text: define });
        } else if (define && name === "all" && behavior !== "enable" && behavior !== "require") {
          // `all` also governs WebGL's own extensions: keep it, and apply
          // it to this one on an added line, restoring the numbering.
          edits.push({ at: lineEnd, end: lineEnd, text: `\n${define}\n#line ${lineOf(t.start) + 1}` });
        }
      }
    }
    if (t.text === GUEST_TYPE) edits.push({ at: t.start, end: t.end, text: NATIVE_TYPE });
  }
  // Define the extension's (private) macro after #version (and any
  // leading #extension lines), keeping the guest's line numbers.
  const at = headerEnd(source);
  const lead = at > 0 && source[at - 1] !== "\n" ? "\n" : "";
  const line = source.slice(0, at).split("\n").length + (lead ? 1 : 0);
  edits.push({ at, end: at, text: `${lead}#define ${NATIVE_MACRO} 1\n#line ${line}\n` });
  edits.push(...samplerFlowEdits(list));
  edits.sort((a, b) => a.at - b.at || a.end - b.end);
  let text = "", from = 0;
  for (const edit of edits) { text += source.slice(from, edit.at) + edit.text; from = edit.end; }
  text += source.slice(from);
  return { text, samplers: externalSamplerPaths(list) };
}

type Member = { name: string; type: string };

/** The uniform paths whose type is samplerExternalOES (directly, through an
 * object-like macro, or as a member of a uniform struct), without array
 * indices, as glGetActiveUniform names them once indices are removed. */
function externalSamplerPaths(list: GlslToken[]): string[] {
  const { kinds } = samplerDeclarations(list);
  return [...kinds].filter(([, kind]) => kind === "e").map(([path]) => path);
}

/** A sampler's type: samplerExternalOES ("e"), sampler2D ("2"),
 * samplerCube ("c"), or no sampler ("n"). */
type SamplerKind = "e" | "2" | "c" | "n";

/** The global sampler uniforms by path (array indices removed), and the
 * type names (macros included) that name samplerExternalOES. */
function samplerDeclarations(list: GlslToken[]): { kinds: Map<string, SamplerKind>; external: Set<string> } {
  const external = new Set([GUEST_TYPE]);
  const structs = new Map<string, Member[]>();
  const word = (i: number) => /^[A-Za-z_]\w*$/.test(list[i]?.text ?? "");
  const precision = (i: number) => ["lowp", "mediump", "highp"].includes(list[i]?.text);
  // Skip a balanced [...] at i, returning the index after it.
  const skipArray = (i: number) => {
    while (list[i]?.text === "[") { let depth = 0; do { if (list[i].text === "[") depth++; else if (list[i].text === "]") depth--; i++; } while (i < list.length && depth > 0); }
    return i;
  };
  // `type name[...] {, name[...]} ;` declarators from i; returns the names
  // and the index after the semicolon.
  const declarators = (i: number): [string[], number] => {
    const names: string[] = [];
    while (i < list.length && list[i].text !== ";") {
      if (word(i)) { names.push(list[i].text); i = skipArray(i + 1); }
      else i++;
    }
    return [names, i + 1];
  };
  // A struct body at `open` ("{"); registers a named struct. Returns its
  // members and the index after "}".
  const structBody = (open: number, name: string | null): [Member[], number] => {
    const members: Member[] = [];
    let i = open + 1;
    while (i < list.length && list[i].text !== "}") {
      if (list[i].directive) { i++; continue; }
      if (precision(i)) i++;
      let type = list[i]?.text ?? "";
      if (type === "struct") {
        const inner = word(i + 1) && list[i + 2]?.text === "{" ? list[i + 1].text : null;
        const [, after] = structBody(inner ? i + 2 : i + 1, inner);
        type = inner ?? "";
        i = after;
      } else i++;
      const [names, next] = declarators(i);
      for (const member of names) members.push({ name: member, type });
      i = next;
    }
    if (name) structs.set(name, members);
    return [members, i + 1];
  };
  const kinds = new Map<string, SamplerKind>();
  const expand = (prefix: string, type: string, members: Member[] | undefined, depth: number) => {
    if (external.has(type)) { kinds.set(prefix, "e"); return; }
    if (type === "sampler2D" || type === "samplerCube") { kinds.set(prefix, type === "sampler2D" ? "2" : "c"); return; }
    if (depth > 16) return;
    for (const member of members ?? structs.get(type) ?? [])
      expand(`${prefix}.${member.name}`, member.type, undefined, depth + 1);
  };
  for (let i = 0, braces = 0; i < list.length; i++) {
    const t = list[i];
    if (t.directive) {
      // `#define NAME samplerExternalOES` names the type too.
      if (t.text === "#" && list[i + 1]?.text === "define" && word(i + 2) && list[i + 3]?.text === GUEST_TYPE
          && (i + 4 >= list.length || list[i + 4].text === "#" || !list[i + 4].directive))
        external.add(list[i + 2].text);
      continue;
    }
    if (t.text === "{") { braces++; continue; }
    if (t.text === "}") { braces--; continue; }
    if (braces !== 0) continue;
    if (t.text === "struct" && word(i + 1) && list[i + 2]?.text === "{") {
      const [, after] = structBody(i + 2, list[i + 1].text);
      i = after - 1;
    } else if (t.text === "uniform") {
      let j = i + 1;
      if (precision(j)) j++;
      let type = list[j]?.text ?? "", members: Member[] | undefined;
      if (type === "struct") {
        const name = word(j + 1) && list[j + 2]?.text === "{" ? list[j + 1].text : null;
        [members, j] = structBody(name ? j + 2 : j + 1, name);
        type = name ?? "";
      } else j++;
      const [names, after] = declarators(j);
      for (const name of names) expand(name, type, members, 0);
      i = after - 1;
    }
  }
  return { kinds, external };
}

/** The ES lookups a samplerExternalOES may be given (the extension's
 * table): texture2D(s, vec2) and texture2DProj(s, vec3 or vec4), without a
 * bias. Every other built-in lookup on an external sampler is a compile
 * error, as is passing one where another sampler type is declared. */
const LOOKUPS = new Set(["texture2D", "texture2DProj", "texture2DLod", "texture2DProjLod", "textureCube",
  "textureCubeLod", "texture2DLodEXT", "texture2DProjLodEXT", "textureCubeLodEXT", "texture2DGradEXT",
  "texture2DProjGradEXT", "textureCubeGradEXT", "shadow2DEXT", "shadow2DProjEXT", "texture2DRect",
  "texture2DRectProj", "texture3D", "texture3DProj", "texture3DLod", "texture3DProjLod"]);

type Edit = { at: number; end: number; text: string };

/**
 * Sampler flow through a shader, after samplerExternalOES became sampler2D:
 *
 * - A built-in lookup the extension does not define for an external
 *   sampler (a Lod/Grad/Proj-Lod/Cube/3D/shadow lookup, or texture2D with
 *   a bias) is renamed to an undeclared function named for the misuse, so
 *   the compile fails with that name in its info log, as a conforming
 *   compiler rejects the call.
 * - An argument of one sampler type given to a parameter of another is a
 *   compile error the same way (WebGL sees two sampler2Ds).
 * - Overloads that differ only between samplerExternalOES and sampler2D
 *   would become one signature twice: each such overload is renamed by its
 *   sampler parameter types, and each call to the one its arguments select.
 *
 * Sampler expressions are resolved like the depth-sampling rewrite does: a
 * global sampler uniform (or array element, or struct member path) or a
 * sampler parameter of the enclosing function. Expressions it cannot
 * resolve are left to the native compiler.
 */
function samplerFlowEdits(list: GlslToken[]): Edit[] {
  const { kinds, external } = samplerDeclarations(list);
  const code = list.filter(token => !token.directive);
  const word = (i: number) => /^[A-Za-z_]\w*$/.test(code[i]?.text ?? "");
  const matching = (open: number) => {
    const pair = code[open].text === "(" ? ")" : "]";
    for (let depth = 0, i = open; i < code.length; i++) {
      if (code[i].text === code[open].text) depth++;
      else if (code[i].text === pair && --depth === 0) return i;
    }
    return -1;
  };
  const split = (open: number, close: number): [number, number][] => {
    const out: [number, number][] = [];
    let start = open + 1, depth = 0;
    for (let i = open + 1; i < close; i++) {
      const t = code[i].text;
      if (t === "(" || t === "[") depth++;
      else if (t === ")" || t === "]") depth--;
      else if (t === "," && depth === 0) { out.push([start, i]); start = i + 1; }
    }
    if (close > open + 1) out.push([start, close]);
    return out;
  };
  const typeKind = (start: number, end: number): SamplerKind => {
    for (let i = start; i < end; i++) {
      const t = code[i].text;
      if (external.has(t)) return "e";
      if (t === "sampler2D") return "2";
      if (t === "samplerCube") return "c";
    }
    return "n";
  };
  // Function declarations and definitions at global scope.
  type Declaration = { name: number; close: number; body: [number, number] | null;
    params: { kind: SamplerKind; name?: string }[] };
  const functions: Declaration[] = [];
  for (let i = 0, braces = 0; i < code.length; i++) {
    const t = code[i].text;
    if (t === "{") braces++;
    else if (t === "}") braces--;
    if (braces !== 0 || !word(i) || code[i + 1]?.text !== "(" || !word(i - 1) || code[i - 1].text === "return") continue;
    const close = matching(i + 1), after = code[close + 1]?.text;
    if (close < 0 || (after !== "{" && after !== ";")) continue;
    const params = split(i + 1, close).filter(([a, b]) => !(b - a === 1 && code[a].text === "void")).map(([a, b]) => {
      let last = b - 1;
      if (code[last]?.text === "]") { while (last > a && code[last].text !== "[") last--; last--; }
      return { kind: typeKind(a, b), name: last > a && word(last) ? code[last].text : undefined };
    });
    functions.push({ name: i, close, params, body: after === "{" ? [close + 1, matching2(close + 1)] : null });
  }
  function matching2(open: number) {
    for (let depth = 0, i = open; i < code.length; i++) {
      if (code[i].text === "{") depth++;
      else if (code[i].text === "}" && --depth === 0) return i;
    }
    return code.length;
  }
  const declared = new Set(functions.map(f => f.name));
  const byName = new Map<string, Declaration[]>();
  for (const f of functions) byName.set(code[f.name].text, [...byName.get(code[f.name].text) ?? [], f]);
  const signature = (f: Declaration) => f.params.map(p => p.kind === "n" ? "n" : p.kind).join("");
  // Overload sets whose members differ only in sampler types once
  // samplerExternalOES compiles as sampler2D are renamed per signature.
  const renamed = new Set<string>();
  for (const [name, overloads] of byName) {
    const external = overloads.some(f => f.params.some(p => p.kind === "e"));
    const shapes = new Set(overloads.map(f => `${f.params.length}:${signature(f)}`));
    const counts = new Set(overloads.map(f => f.params.length));
    if (external && shapes.size > counts.size) renamed.add(name);
  }
  const overloadName = (f: Declaration) => `${code[f.name].text}_kandelo_${signature(f)}`;
  const edits: Edit[] = [];
  const rename = (i: number, text: string) => edits.push({ at: code[i].start, end: code[i].end, text });
  for (const f of functions) if (renamed.has(code[f.name].text)) rename(f.name, overloadName(f));
  /** The sampler type of the expression in [start, end) inside `scope`. */
  const expressionKind = (start: number, end: number, scope: Declaration | undefined): SamplerKind => {
    while (code[start]?.text === "(" && matching(start) === end - 1) { start++; end--; }
    if (!word(start)) return "n";
    if (end - start === 1) {
      const param = scope?.params.find(p => p.name === code[start].text);
      if (param) return param.kind;
    }
    const path: string[] = [];
    for (let i = start; i < end; i++) {
      const t = code[i].text;
      if (t === "[") { i = matching(i); if (i < 0) return "n"; continue; }
      if (t === ".") continue;
      if (!word(i)) return "n";
      path.push(t);
    }
    return kinds.get(path.join(".")) ?? "n";
  };
  for (let i = 0; i < code.length; i++) {
    const t = code[i].text;
    if (code[i + 1]?.text !== "(" || declared.has(i)) continue;
    const lookup = LOOKUPS.has(t), user = byName.get(t);
    if (!lookup && !user) continue;
    const close = matching(i + 1);
    if (close < 0) continue;
    const scope = functions.find(f => f.body && i > f.body[0] && i < f.body[1]);
    const args = split(i + 1, close), argKinds = args.map(([a, b]) => expressionKind(a, b, scope));
    if (lookup) {
      const allowed = (t === "texture2D" || t === "texture2DProj") && args.length === 2;
      const what = t === "texture2D" || t === "texture2DProj" ? `${t}_with_bias` : t;
      if (argKinds[0] === "e" && !allowed) rename(i, `samplerExternalOES_cannot_use_${what}`);
      continue;
    }
    // A user function: the overload whose sampler parameters match.
    const candidates = user!.filter(f => f.params.length === args.length);
    // An argument fits a parameter of its own sampler type; a parameter or
    // argument that is no (resolved) sampler is the native compiler's to check.
    const fits = (f: Declaration) => f.params.every((p, k) =>
      p.kind === "n" || argKinds[k] === "n" || argKinds[k] === p.kind);
    const chosen = candidates.filter(fits);
    // No overload fits because an external sampler meets another sampler type.
    const mismatch = candidates.length > 0 && !chosen.length && candidates.every(f => f.params.some((p, k) =>
      p.kind !== "n" && argKinds[k] !== "n" && p.kind !== argKinds[k] && (p.kind === "e" || argKinds[k] === "e")));
    if (mismatch) rename(i, `samplerExternalOES_argument_mismatch_${t}`);
    else if (renamed.has(t) && chosen.length) {
      const names = new Set(chosen.map(overloadName));
      if (names.size === 1) rename(i, [...names][0]);
    }
  }
  return edits;
}

// --- shaders and programs ------------------------------------------------------

const compiledSamplers = new WeakMap<WebGLShader, readonly string[]>();
/** A linked program's samplers a draw must bind for itself: external
 * sampler paths, and whether it samples cube maps through the ESSL 3.00
 * per-face lookups (essl3-translation.ts, cube-storage.ts). Absent for
 * every other program, whose draws pay this one lookup. */
type ProgramSamplers = { paths: ReadonlySet<string>; cube: boolean };
const programSamplers = new WeakMap<WebGLProgram, ProgramSamplers>();

/** GLES links the shaders' compiled state, not their current sources. */
export function recordCompiledExternalSamplers(shader: WebGLShader, samplers: readonly string[] | undefined): void {
  if (samplers?.length) compiledSamplers.set(shader, samplers);
  else compiledSamplers.delete(shader);
}

/** After every native link attempt of `program` from `shaders`. */
export function recordLinkedExternalSamplers(program: WebGLProgram, linked: boolean, shaders: Iterable<WebGLShader>): void {
  programSamplers.delete(program);
  if (!linked) return;
  const paths = new Set<string>();
  let cube = false;
  for (const shader of shaders) {
    for (const path of compiledSamplers.get(shader) ?? []) paths.add(path);
    cube ||= shaderSamplesCube(shader);
  }
  if (paths.size || cube) programSamplers.set(program, { paths, cube });
}

/** A private executable that replaces `program` samples the same textures. */
export function copyExternalSamplers(from: WebGLProgram, to: WebGLProgram): void {
  const paths = programSamplers.get(from);
  if (paths) programSamplers.set(to, paths); else programSamplers.delete(to);
}

const pathOf = (name: string) => name.replace(/\[\d+\]/g, "");

/** The GLES type of an active uniform: SAMPLER_EXTERNAL_OES for a sampler
 * the guest declared samplerExternalOES, and SAMPLER_CUBE for a samplerCube
 * that the translation samples as sampler2DArray (ES 2.0 has no 2D array
 * textures, so no other uniform of a translated program has that type). */
export function guestUniformType(program: WebGLProgram, name: string, type: number): number {
  if (type === SAMPLER_2D_ARRAY && programSamplers.get(program)?.cube) return SAMPLER_CUBE;
  return type === SAMPLER_2D && programSamplers.get(program)?.paths.has(pathOf(name)) ? SAMPLER_EXTERNAL_OES : type;
}

type SamplerUnits = { link: number; writes: number; external: number[]; cube: number[]; conflict: boolean };
const unitCaches = new WeakMap<WebGLProgram, SamplerUnits>();

/** The units the program's external samplers read, and whether one of them
 * is also read by a sampler2D. Native reads only after a link or a
 * Uniform1i(v) write. Null when a native query failed (recorded). */
function samplerUnits(b: GlBinding, program: WebGLProgram, paths: ReadonlySet<string>): SamplerUnits | null {
  const link = programLinkGeneration(b, program).value, writes = samplerWriteGeneration(program);
  const cached = unitCaches.get(program);
  if (cached && cached.link === link && cached.writes === writes) return cached;
  const gl = b.gl!, external = new Set<number>(), plain = new Set<number>(), cube = new Set<number>();
  if (!checkedGlCall(b, () => {
    const count = Number(gl.getProgramParameter(program, 0x8b86));
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info || (info.type !== SAMPLER_2D && info.type !== SAMPLER_2D_ARRAY)) continue;
      const array = info.name.endsWith("[0]"), base = array ? info.name.slice(0, -3) : info.name;
      const units = info.type === SAMPLER_2D_ARRAY ? cube
        : paths.has(pathOf(programGuestName(program, info.name))) ? external : plain;
      for (let element = 0; element < info.size; element++) {
        const location = gl.getUniformLocation(program, array ? `${base}[${element}]` : base);
        if (location) units.add(Number(gl.getUniform(program, location)));
      }
    }
  })) return null;
  const result = { link, writes, external: [...external], cube: [...cube], conflict: [...external].some(unit => plain.has(unit)) };
  unitCaches.set(program, result);
  return result;
}

/** ValidateProgram: a sampler2D and an external sampler on one unit. */
const validationFailures = new WeakSet<WebGLProgram>();
export function validateExternalSamplers(b: GlBinding, program: WebGLProgram): void {
  validationFailures.delete(program);
  const paths = programSamplers.get(program)?.paths;
  if (!paths?.size) return;
  const units = samplerUnits(b, program, paths);
  if (units?.conflict) validationFailures.add(program);
}
export function externalValidationFailed(program: WebGLProgram): boolean {
  return validationFailures.has(program);
}

/** A texture a draw binds for itself: `native` on the unit's `target`
 * (TEXTURE_2D for an external texture, TEXTURE_2D_ARRAY for a cube map),
 * whose guest binding `guest` the draw restores. */
export type ExternalDrawUnit = { unit: number; target: number; native: WebGLTexture | null; guest: WebGLTexture | null };
const NO_UNITS: readonly ExternalDrawUnit[] = Object.freeze([]);

/** The textures a draw of the installed executable binds for itself. An
 * external texture's native texture goes to its unit's TEXTURE_2D, after
 * copying any sibling view whose image was written (image-writes.ts). A
 * cube map sampled through the per-face lookups needs its sampled storage
 * on its unit's TEXTURE_2D_ARRAY (cube-storage.ts); that is listed only
 * where it differs from the unit's guest binding (an incomplete cube, which
 * samples no texture, or images in other storage), so a complete cube costs
 * a cached comparison. Null when the draw is refused (error recorded). */
export function externalDrawUnits(b: GlBinding): readonly ExternalDrawUnit[] | null {
  const program = b.currentProgram;
  const record = program ? programSamplers.get(program) : undefined;
  if (!program || !record) return NO_UNITS;
  const units = samplerUnits(b, program, record.paths);
  if (!units) return null;
  if (units.conflict) { recordGlError(b, 0x502); return null; }
  const s = b.shadow, draw: ExternalDrawUnit[] = [];
  for (const unit of units.external) {
    const object = s.externalTextureUnits[unit] ?? s.defaultTextures.get(TEXTURE_EXTERNAL_OES) ?? null;
    if (object && !refreshTextureView(b, object)) return null;
    draw.push({ unit, target: TEX, native: object ? textureNative(b, object) : null, guest: guestTextureBinding(b, unit) });
  }
  for (const unit of units.cube) {
    const object = s.cubeTextureUnits[unit] ?? s.defaultTextures.get(CUBE) ?? null;
    const native = cubeSamplingTexture(object), guest = nativeTextureBinding(s, CUBE, unit, b.textureViews);
    if (native !== guest) draw.push({ unit, target: TEXTURE_2D_ARRAY, native, guest });
  }
  return draw;
}

/** The guest TEXTURE_2D binding a draw's external units restore. */
export function guestTextureBinding(b: GlBinding, unit: number): WebGLTexture | null {
  return nativeTextureBinding(b.shadow, TEX, unit, b.textureViews);
}

// --- objects, bindings and parameters ----------------------------------------------

const externalTextures = new WeakSet<WebGLTexture>();
export function isExternalTexture(object: WebGLTexture | null | undefined): boolean {
  return !!object && externalTextures.has(object);
}

/** Run `work` with `native` bound to the active unit's TEXTURE_2D, then
 * restore that unit's guest binding. */
function withNativeTexture(b: GlBinding, native: WebGLTexture, work: () => void): boolean {
  const gl = b.gl!, unit = b.shadow.activeTexture;
  const bound = checkedGlCall(b, () => { gl.bindTexture(TEX, native); work(); });
  return checkedGlCall(b, () => gl.bindTexture(TEX, guestTextureBinding(b, unit))) && bound;
}

/** A new external texture: a native 2D texture with the external initial
 * state (MIN and MAG filters LINEAR, wrap modes CLAMP_TO_EDGE). */
function createExternalTexture(b: GlBinding): WebGLTexture | null {
  const gl = b.gl!;
  let texture: WebGLTexture | null = null;
  if (!checkedGlCall(b, () => { texture = gl.createTexture(); }) || !texture) {
    if (!texture) recordGlError(b, 0x505);
    return null;
  }
  const created = texture as WebGLTexture;
  if (!withNativeTexture(b, created, () => {
    gl.texParameteri(TEX, 0x2801, 0x2601);
    gl.texParameteri(TEX, 0x2802, 0x812f);
    gl.texParameteri(TEX, 0x2803, 0x812f);
  })) { gl.deleteTexture(created); return null; }
  externalTextures.add(created);
  return created;
}

/** The context's default external texture (name zero), made on first use. */
function defaultExternalTexture(b: GlBinding): WebGLTexture | null {
  const existing = b.shadow.defaultTextures.get(TEXTURE_EXTERNAL_OES);
  if (existing) return existing;
  const created = createExternalTexture(b);
  if (created) b.shadow.defaultTextures.set(TEXTURE_EXTERNAL_OES, created);
  return created;
}

/** BindTexture(TEXTURE_EXTERNAL_OES, name): the first bind makes the object
 * an external texture; it is never bound natively here. A 2D or cube
 * texture is INVALID_OPERATION (the C encoder checks the same first). */
export function bindExternalTexture(b: GlBinding, name: number): boolean {
  let texture = name ? b.textures.get(name) ?? null : null;
  if (texture && !externalTextures.has(texture)) { recordGlError(b, 0x502); return false; }
  if (name && !texture) {
    texture = createExternalTexture(b);
    if (!texture) return false;
    try { b.textures.set(name, texture); }
    catch (caught) { b.gl!.deleteTexture(texture); rethrowNativeGlFault(caught); recordGlError(b, 0x505); return false; }
  }
  const units = b.shadow.externalTextureUnits, unit = b.shadow.activeTexture;
  while (units.length <= unit) units.push(null);
  units[unit] = texture;
  return true;
}

/** The external texture TexParameter and GetTexParameter address. */
function boundExternal(b: GlBinding): WebGLTexture | null {
  return b.shadow.externalTextureUnits[b.shadow.activeTexture] ?? defaultExternalTexture(b);
}

/** TexParameter(TEXTURE_EXTERNAL_OES): MIN_FILTER takes NEAREST or LINEAR
 * only, the wrap modes CLAMP_TO_EDGE only; anything else is INVALID_ENUM. */
export function externalTexParameter(b: GlBinding, pname: number, value: number): boolean {
  const filters = [0x2600, 0x2601];
  const valid = pname === 0x2801 || pname === 0x2800 ? filters.includes(value)
    : pname === 0x2802 || pname === 0x2803 ? value === 0x812f : false;
  if (!valid) { recordGlError(b, 0x500); return false; }
  const object = boundExternal(b);
  return !!object && withNativeTexture(b, textureNative(b, object), () => b.gl!.texParameteri(TEX, pname, value));
}

/** GetTexParameter(TEXTURE_EXTERNAL_OES, pname) for the GLES parameters. */
export function externalTexParameterValue(b: GlBinding, pname: number): number | null {
  const object = boundExternal(b);
  let value = 0;
  if (!object || !withNativeTexture(b, textureNative(b, object), () => {
    value = Number(b.gl!.getTexParameter(TEX, pname));
  })) return null;
  return value;
}
