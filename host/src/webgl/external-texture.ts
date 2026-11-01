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
 *   under conditional compilation, and `GL_OES_EGL_image_external` is
 *   defined as 1 like every supported extension's macro. Reflection reports
 *   SAMPLER_EXTERNAL_OES for those samplers (`guestUniformType`).
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

export const TEXTURE_EXTERNAL_OES = 0x8d65;
export const SAMPLER_EXTERNAL_OES = 0x8d66;
const TEX = 0x0de1, SAMPLER_2D = 0x8b5e;
const EXTENSION = "GL_OES_EGL_image_external";
const GUEST_TYPE = "samplerExternalOES";
const NATIVE_TYPE = "kandelo_samplerExternalOES";

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
  const edits: { at: number; end: number; text: string }[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.directive && t.text === "#") {
      const lineEnd = source.indexOf("\n", t.start) < 0 ? source.length : source.indexOf("\n", t.start);
      const directive: GlslToken[] = [];
      for (let j = i; j < list.length && list[j].start < lineEnd; j++) directive.push(list[j]);
      const [, keyword, name, colon, behavior] = directive.map(token => token.text);
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
  // Define the extension's macro after #version (and any leading
  // #extension lines), keeping the guest's line numbers.
  const at = headerEnd(source);
  const lead = at > 0 && source[at - 1] !== "\n" ? "\n" : "";
  const line = source.slice(0, at).split("\n").length + (lead ? 1 : 0);
  edits.push({ at, end: at, text: `${lead}#define ${EXTENSION} 1\n#line ${line}\n` });
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
  const paths: string[] = [];
  const expand = (prefix: string, type: string, members: Member[] | undefined, depth: number) => {
    if (external.has(type)) { paths.push(prefix); return; }
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
  return paths;
}

// --- shaders and programs ------------------------------------------------------

const compiledSamplers = new WeakMap<WebGLShader, readonly string[]>();
const programSamplers = new WeakMap<WebGLProgram, ReadonlySet<string>>();

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
  for (const shader of shaders) for (const path of compiledSamplers.get(shader) ?? []) paths.add(path);
  if (paths.size) programSamplers.set(program, paths);
}

/** A private executable that replaces `program` samples the same textures. */
export function copyExternalSamplers(from: WebGLProgram, to: WebGLProgram): void {
  const paths = programSamplers.get(from);
  if (paths) programSamplers.set(to, paths); else programSamplers.delete(to);
}

const pathOf = (name: string) => name.replace(/\[\d+\]/g, "");

/** The GLES type of an active uniform: SAMPLER_EXTERNAL_OES for a sampler
 * the guest declared samplerExternalOES. */
export function guestUniformType(program: WebGLProgram, name: string, type: number): number {
  return type === SAMPLER_2D && programSamplers.get(program)?.has(pathOf(name)) ? SAMPLER_EXTERNAL_OES : type;
}

type SamplerUnits = { link: number; writes: number; external: number[]; conflict: boolean };
const unitCaches = new WeakMap<WebGLProgram, SamplerUnits>();

/** The units the program's external samplers read, and whether one of them
 * is also read by a sampler2D. Native reads only after a link or a
 * Uniform1i(v) write. Null when a native query failed (recorded). */
function samplerUnits(b: GlBinding, program: WebGLProgram, paths: ReadonlySet<string>): SamplerUnits | null {
  const link = programLinkGeneration(b, program).value, writes = samplerWriteGeneration(program);
  const cached = unitCaches.get(program);
  if (cached && cached.link === link && cached.writes === writes) return cached;
  const gl = b.gl!, external = new Set<number>(), plain = new Set<number>();
  if (!checkedGlCall(b, () => {
    const count = Number(gl.getProgramParameter(program, 0x8b86));
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info || info.type !== SAMPLER_2D) continue;
      const array = info.name.endsWith("[0]"), base = array ? info.name.slice(0, -3) : info.name;
      const units = paths.has(pathOf(info.name)) ? external : plain;
      for (let element = 0; element < info.size; element++) {
        const location = gl.getUniformLocation(program, array ? `${base}[${element}]` : base);
        if (location) units.add(Number(gl.getUniform(program, location)));
      }
    }
  })) return null;
  const result = { link, writes, external: [...external], conflict: [...external].some(unit => plain.has(unit)) };
  unitCaches.set(program, result);
  return result;
}

/** ValidateProgram: a sampler2D and an external sampler on one unit. */
const validationFailures = new WeakSet<WebGLProgram>();
export function validateExternalSamplers(b: GlBinding, program: WebGLProgram): void {
  validationFailures.delete(program);
  const paths = programSamplers.get(program);
  if (!paths) return;
  const units = samplerUnits(b, program, paths);
  if (units?.conflict) validationFailures.add(program);
}
export function externalValidationFailed(program: WebGLProgram): boolean {
  return validationFailures.has(program);
}

export type ExternalDrawUnit = { unit: number; native: WebGLTexture | null };
const NO_UNITS: readonly ExternalDrawUnit[] = Object.freeze([]);

/** The external textures a draw of the installed executable samples, each
 * with the native texture to bind to its unit's TEXTURE_2D, after copying
 * any sibling view whose image was written (image-writes.ts). Null when the
 * draw is refused (error recorded). */
export function externalDrawUnits(b: GlBinding): readonly ExternalDrawUnit[] | null {
  const program = b.currentProgram;
  const paths = program ? programSamplers.get(program) : undefined;
  if (!program || !paths) return NO_UNITS;
  const units = samplerUnits(b, program, paths);
  if (!units) return null;
  if (units.conflict) { recordGlError(b, 0x502); return null; }
  const s = b.shadow, draw: ExternalDrawUnit[] = [];
  for (const unit of units.external) {
    const object = s.externalTextureUnits[unit] ?? s.defaultTextures.get(TEXTURE_EXTERNAL_OES) ?? null;
    if (object && !refreshTextureView(b, object)) return null;
    draw.push({ unit, native: object ? textureNative(b, object) : null });
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
