/**
 * Attribute aliasing (ES 2.0 section 2.10.4) on WebGL 2.
 *
 * ES 2.0 lets BindAttribLocation give several attributes overlapping generic
 * attribute locations ("aliasing"); the program links, and behavior is
 * defined as long as no path through the shader consumes more than one
 * attribute of an aliased set. WebGL forbids it: linkProgram fails when two
 * active attributes alias (WebGL 1.0 "Attribute Aliasing"; WebGL 2 inherits
 * it), so such programs reported LINK_STATUS false.
 *
 * Exact emulation. A generic attribute is one vec4 per location: a float or
 * vecN attribute reads its first N components and a matN attribute reads its
 * columns from N consecutive locations (ES 2.0 sections 2.7 and 2.10.4).
 * When a link fails and the guest's bindings overlap between declared
 * attributes, the host links a private executable whose vertex shader
 * declares one `highp vec4 kandelo_alias_<L>` per aliased location, bound
 * there. Each aliased attribute becomes an ordinary global of its original
 * name, type and precision, assigned from those vec4s before the guest's main
 * runs, so every read sees exactly the value the generic attribute supplies.
 * Non-aliased attributes and every binding for them are unchanged.
 *
 * The private executable becomes the logical program's native object, so
 * LINK_STATUS, uniforms, validation and draws use it. Attribute reflection is
 * answered from the guest's declarations: GetActiveAttrib/ACTIVE_ATTRIBUTES
 * list the original names and types, GetAttribLocation returns their bound
 * locations, and the kandelo_alias_* names are hidden. An aliased attribute
 * is reported active when the vertex source references it outside its
 * declaration; per-attribute activity cannot be observed natively because
 * aliased attributes share their location, and section 2.10.4 lets an
 * implementation treat an attribute it cannot rule out as active.
 * Attachments stay logical (the native object holds the private vertex
 * shader), so every relink starts from the guest's attached shaders again.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";
import { compiledShaderSource, recordLinkedSources, renameIdentifiers } from "./reversed-depth.js";

const VERTEX_SHADER = 0x8b31, FRAGMENT_SHADER = 0x8b30;
const ALIAS_PREFIX = "kandelo_alias_";
const MAIN = "kandelo_attribute_alias_main";
const TYPES = new Map<string, { type: number; slots: number; width: string }>([
  ["float", { type: 0x1406, slots: 1, width: ".x" }], ["vec2", { type: 0x8b50, slots: 1, width: ".xy" }],
  ["vec3", { type: 0x8b51, slots: 1, width: ".xyz" }], ["vec4", { type: 0x8b52, slots: 1, width: "" }],
  ["mat2", { type: 0x8b5a, slots: 2, width: ".xy" }], ["mat3", { type: 0x8b5b, slots: 3, width: ".xyz" }],
  ["mat4", { type: 0x8b5c, slots: 4, width: "" }],
]);

export type GlReflectedAttribute = { name: string; size: number; type: number };
type AliasLayout = { attributes: GlReflectedAttribute[]; locations: Map<string, number> };
const layouts = new WeakMap<WebGLProgram, AliasLayout>();

/** Present only for private aliasing executables. */
export function attributeAliasLayout(program: WebGLProgram | null | undefined): AliasLayout | undefined {
  return program ? layouts.get(program) : undefined;
}

/** GetAttribLocation for an aliasing executable; undefined means "ask WebGL". */
export function aliasedAttributeLocation(program: WebGLProgram, name: string): number | undefined {
  const layout = layouts.get(program);
  if (!layout) return undefined;
  if (name.startsWith(ALIAS_PREFIX)) return -1;
  return layout.locations.get(name);
}

export type GlslToken = { text: string; start: number; end: number; directive: boolean };
/** GLSL ES tokens outside comments; `directives` keeps preprocessor lines
 * (marked), otherwise they are skipped. */
export function glslTokens(source: string, directives: boolean): GlslToken[] {
  const out: GlslToken[] = [];
  const n = source.length;
  let i = 0, lineStart = true, directive = false;
  const ident = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = source[i];
    if (c === "\n") { lineStart = true; directive = false; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "#" && lineStart) {
      if (!directives) { while (i < n && source[i] !== "\n") i++; continue; }
      directive = true;
    }
    lineStart = false;
    const start = i;
    if (ident(c)) { while (i < n && (ident(source[i]) || (/[0-9]/.test(source[start]) && source[i] === "."))) i++; }
    else i++;
    out.push({ text: source.slice(start, i), start, end: i, directive });
  }
  return out;
}

type Declaration = { start: number; end: number; precision: string; type: string; names: string[] };
/** `attribute [precision] type name {, name} ;` at global scope. */
function attributeDeclarations(source: string): Declaration[] | null {
  const list = glslTokens(source, false), declarations: Declaration[] = [];
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i].text;
    if (t === "{") depth++;
    else if (t === "}") depth--;
    if (t !== "attribute" || depth !== 0) continue;
    let j = i + 1, precision = "";
    if (["lowp", "mediump", "highp"].includes(list[j]?.text)) precision = list[j++].text;
    const type = list[j++]?.text;
    if (!type || !TYPES.has(type)) return null;
    const names: string[] = [];
    for (;;) {
      const name = list[j++]?.text;
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) return null;
      names.push(name);
      const next = list[j++]?.text;
      if (next === ";") break;
      if (next !== ",") return null; // arrays and initializers are not ES 1.00 attributes
    }
    declarations.push({ start: list[i].start, end: list[j - 1].end, precision, type, names });
    i = j - 1;
  }
  return declarations;
}

export type GlAliasRewrite = {
  source: string;
  aliased: ReadonlySet<string>;
  slots: readonly number[];
  used: ReadonlySet<string>;
  declarations: readonly Declaration[];
  declared: ReadonlyMap<string, { type: string; precision: string; location: number }>;
};

/** The private vertex shader for a GLSL ES 1.00 source whose bindings alias,
 * or null when no declared, bound attributes overlap (or the declarations
 * are outside the supported grammar). Pure: used by the link path and by
 * the real-compiler check in tests/graphics/shader-rewrite-check. */
export function aliasedVertexShaderSource(vertex: string, bindings: ReadonlyMap<string, number>): GlAliasRewrite | null {
  const declarations = attributeDeclarations(vertex);
  if (!declarations) return null;

  // Locations covered by each declared, bound attribute.
  const declared = new Map<string, { type: string; precision: string; location: number }>();
  for (const d of declarations) for (const n of d.names)
    if (bindings.has(n)) declared.set(n, { type: d.type, precision: d.precision, location: bindings.get(n)! });
  const owners = new Map<number, string[]>();
  for (const [n, a] of declared) for (let i = 0; i < TYPES.get(a.type)!.slots; i++) {
    const list = owners.get(a.location + i) ?? [];
    list.push(n); owners.set(a.location + i, list);
  }
  const aliased = new Set<string>(), slots = new Set<number>();
  for (const names of owners.values()) if (names.length > 1) for (const n of names) aliased.add(n);
  for (const n of aliased) {
    const a = declared.get(n)!;
    for (let i = 0; i < TYPES.get(a.type)!.slots; i++) slots.add(a.location + i);
  }
  if (!aliased.size) return null;

  // Static use outside the declarations, including macro bodies.
  const used = new Set<string>();
  for (const t of glslTokens(vertex, true)) {
    if (aliased.has(t.text) && !declarations.some(d => t.start >= d.start && t.end <= d.end)) used.add(t.text);
  }

  // Rewrite back to front so earlier offsets stay valid; keep line numbers.
  let rewritten = vertex;
  for (const d of [...declarations].reverse()) {
    const own = d.names.filter(n => aliased.has(n)), rest = d.names.filter(n => !aliased.has(n));
    if (!own.length) continue;
    const qualifier = d.precision ? `${d.precision} ` : "";
    const lines = "\n".repeat(rewritten.slice(d.start, d.end).split("\n").length - 1);
    rewritten = rewritten.slice(0, d.start) +
      (rest.length ? `attribute ${qualifier}${d.type} ${rest.join(", ")}; ` : "") +
      `${qualifier}${d.type} ${own.join(", ")};${lines}` + rewritten.slice(d.end);
  }
  rewritten = renameIdentifiers(rewritten, new Map([["main", MAIN]])).text;
  const assignments = [...aliased].map(n => {
    const a = declared.get(n)!, info = TYPES.get(a.type)!;
    const column = (i: number) => `${ALIAS_PREFIX}${a.location + i}${info.width}`;
    return info.slots === 1 ? `${n} = ${column(0)};`
      : `${n} = ${a.type}(${Array.from({ length: info.slots }, (_, i) => column(i)).join(", ")});`;
  });
  rewritten += `\n${[...slots].sort((x, y) => x - y).map(l => `attribute highp vec4 ${ALIAS_PREFIX}${l};`).join("\n")}\n` +
    `void main() { ${assignments.join(" ")} ${MAIN}(); }\n`;

  return { source: rewritten, aliased, slots: [...slots].sort((x, y) => x - y), used, declarations, declared };
}

/** Link a private executable for a program whose native link failed, if (and
 * only if) the guest's bindings alias between declared attributes. Returns
 * the linked executable, or null with no native objects left behind (the
 * guest then observes the original native link failure). */
export function linkAliasedExecutable(b: GlBinding, name: number, attached: readonly WebGLShader[]): WebGLProgram | null {
  const gl = b.gl!;
  let vertexShader: WebGLShader | undefined, fragmentShader: WebGLShader | undefined;
  if (!checkedGlCall(b, () => {
    for (const shader of attached) {
      const type = Number(gl.getShaderParameter(shader, 0x8b4f));
      if (type === VERTEX_SHADER) vertexShader = shader;
      else if (type === FRAGMENT_SHADER) fragmentShader = shader;
    }
  }) || !vertexShader || !fragmentShader) return null;
  const vertex = compiledShaderSource(vertexShader), fragment = compiledShaderSource(fragmentShader);
  // ES 3.00 shaders forbid aliasing; only GLSL ES 1.00 permits it.
  if (vertex === undefined || fragment === undefined || /^\s*#\s*version\s+[1-9][0-9][0-9]\s+es/m.test(vertex)) return null;
  const bindings = b.programAttributeBindings.get(name) ?? new Map<string, number>();
  const rewrite = aliasedVertexShaderSource(vertex, bindings);
  if (!rewrite) return null;
  const { source: rewritten, aliased, slots, used, declarations, declared } = rewrite;

  let shader: WebGLShader | null = null, program: WebGLProgram | null = null, linked = false;
  try {
    if (!checkedGlCall(b, () => { shader = gl.createShader(VERTEX_SHADER); program = gl.createProgram(); }) || !shader || !program) return null;
    const s = shader as WebGLShader, p = program as WebGLProgram;
    if (!checkedGlCall(b, () => {
      gl.shaderSource(s, rewritten);
      gl.compileShader(s);
      gl.attachShader(p, s);
      gl.attachShader(p, fragmentShader!);
      for (const [attribute, index] of bindings) if (!aliased.has(attribute)) gl.bindAttribLocation(p, index, attribute);
      for (const l of slots) gl.bindAttribLocation(p, l, `${ALIAS_PREFIX}${l}`);
      gl.linkProgram(p);
      linked = !!gl.getProgramParameter(p, 0x8b82);
    }) || !linked) { linked = false; return null; }

    const attributes: GlReflectedAttribute[] = [];
    if (!checkedGlCall(b, () => {
      const count = Number(gl.getProgramParameter(p, 0x8b89));
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveAttrib(p, i);
        if (info && !info.name.startsWith(ALIAS_PREFIX)) attributes.push({ name: info.name, size: info.size, type: info.type });
      }
    })) { linked = false; return null; }
    const locations = new Map<string, number>();
    for (const d of declarations) for (const n of d.names) {
      if (!aliased.has(n)) continue;
      locations.set(n, used.has(n) ? declared.get(n)!.location : -1);
      if (used.has(n)) attributes.push({ name: n, size: 1, type: TYPES.get(d.type)!.type });
    }
    layouts.set(p, { attributes, locations });
    recordLinkedSources(p, rewritten, fragment);
    return p;
  } finally {
    // The private vertex shader lives while attached to the executable.
    checkedGlCall(b, () => {
      if (shader) gl.deleteShader(shader);
      if (program && !linked) gl.deleteProgram(program);
    });
  }
}
