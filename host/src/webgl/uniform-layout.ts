import type {PreparedUniformValues} from "./prepared-uniform-values.js";
/**
 * Uniform locations: per-program, dense, numbered the way Linux GLES drivers
 * number them (maintainer decision D-41).
 *
 * Why. ES 2.0 section 2.10.4 lets an implementation return any integer from
 * GetUniformLocation, and makes a location that does not belong to the
 * current program INVALID_OPERATION. Mesa and native ANGLE number each
 * program's uniforms densely from 0, so two programs with the same uniform
 * declarations get the same numbers. Ported software relies on that, mostly
 * by accident: dEQP-GLES2 performance.shader.operator sets the second
 * program's loop count with the first program's location
 * (es2pShaderOperatorTests.cpp, `prepareWorkload(0, ...)` while program 1
 * is current). With locations unique across programs that call was
 * INVALID_OPERATION and the case could not measure; on a Linux driver it
 * works. Kandelo therefore numbers locations as those drivers do. This is
 * the driver-observable behavior, and stays spec-legal: a location only
 * means something relative to a program.
 *
 * The numbering (one `GlUniformLayout` per native executable):
 *
 * - Active uniforms in the order GetActiveUniform enumerates them (the
 *   native reflection order; object-query.ts reports the same list).
 *   Native reflection already flattens structures: each basic-typed member
 *   path (`s.a`, `s[1].b[0]`) is its own active uniform, as in Mesa.
 * - Each active uniform takes the next free location; an array of N takes N
 *   consecutive locations, one per element, so `a` and `a[0]` name the
 *   first and `a[i]` names `location(a) + i`. This is Mesa's remap table
 *   (`UniformRemapTable`, MAX2(1, array_elements) entries per uniform).
 * - `gl_`-prefixed built-ins (for example `gl_DepthRange.near`) take no
 *   location: GetUniformLocation must return -1 for them, so a slot would be
 *   unreachable.
 * - Host-private uniforms never take a location: emulations put them only
 *   in private variant executables (blend-constant.ts, vertex-depth-range.ts,
 *   reversed-depth.ts; their rows are already subtracted from the advertised
 *   limits, decision D-22), never in the guest's executable, so the list
 *   numbered here is exactly the guest's GetActiveUniform list. Variants
 *   (reversed depth, depth sampling, attribute aliasing) copy or bind
 *   uniforms by native name and so share the guest program's numbering.
 * - A translated program (essl3-translation.ts) is numbered by its guest
 *   names; lookups map back to the native names only to reach WebGL.
 *
 * Relinking. ES 2.0 lets a successful relink change every location. A
 * relink whose active uniform set (guest name, type and size of every
 * uniform) is identical keeps the previous numbering, as drivers do in
 * practice because they number the same declarations the same way. The
 * previous link's layout, if any location of it was ever observed, is the
 * template; otherwise the new link is numbered afresh, which no guest can
 * distinguish.
 *
 * Resolution. GetUniformLocation and GetUniform* resolve against the named
 * program's latest successful link; Uniform* resolves against the context's
 * installed executable (which a failed relink leaves installed). A location
 * valid in another program is therefore accepted when, and only when, the
 * current program has a uniform at that index, and the ordinary signature
 * rules then apply (INVALID_OPERATION on a type mismatch).
 *
 * Cost. A layout is built once per native executable on its first use: one
 * ACTIVE_UNIFORMS read, one GetActiveUniform per uniform and one native
 * location per element, in a single checked call. Uniform* then costs an
 * O(1) map read, a generation compare and two array reads; draws pay
 * nothing.
 *
 * Boundary. WebGL limits location lookup strings (256 characters in WebGL
 * 1.0, "Maximum Uniform and Attribute Location Lengths"). An element whose
 * native name is longer is resolved only when used, so the engine's own
 * limit error stays the visible boundary, as for attributes.
 */
import { checkedGlCall, programLinkGeneration } from "./program-objects.js";
import { programGuestName } from "./essl3-translation.js";
import { guestUniformType } from "./external-texture.js";
import type { GlBinding } from "./registry.js";

/** Longest name the engine is asked for while building a layout. */
const WEBGL_LOOKUP_LENGTH = 256;

/** One active uniform. An array is one entry with `size` locations. */
export type GlUniformEntry = Readonly<{
  /** The guest's name, without the final array selector. */
  name: string;
  /** The native reflection name, without the final array selector. */
  native: string;
  /** Native (setter signature) type; external samplers are SAMPLER_2D. */
  type: number;
  /** The type GetActiveUniform reports. */
  guestType: number;
  size: number;
  array: boolean;
  /** First location; element i is location + i. */
  location: number;
}>;

/** Immutable numbering for one native link generation of one executable. */
export class GlUniformLayout {
  ownedValues:PreparedUniformValues|null=null;
  constructor(
    readonly executable: WebGLProgram,
    private readonly link: { value: number },
    private readonly generation: number,
    readonly entries: readonly GlUniformEntry[],
    /** slots[location] is the entry holding that location. */
    readonly slots: readonly GlUniformEntry[],
    private readonly names: ReadonlyMap<string, GlUniformEntry>,
    /** Native location per slot; undefined until resolved (long names). */
    private readonly natives: (WebGLUniformLocation | null | undefined)[],
  ) {}

  /** False once the executable was relinked in place. */
  get current(): boolean { return this.link.value === this.generation; }

  /** The location of a syntactically valid guest name whose array indices
   * have no leading zeros, or -1. Only the final selector indexes the
   * remaining array; earlier ones are part of the member's path. */
  locate(text: string): number {
    const exact = this.names.get(text);
    if (exact) return exact.location;
    const selector = /^(.*)\[(\d+)\]$/.exec(text);
    if (!selector) return -1;
    const entry = this.names.get(selector[1]), element = Number(selector[2]);
    return entry && entry.array && element < entry.size ? entry.location + element : -1;
  }

  /** The entry of a guest name without its final array selector. */
  entry(name: string): GlUniformEntry | undefined { return this.names.get(name); }

  /** The native location already resolved for a slot, without native calls. */
  resolvedNative(location: number): WebGLUniformLocation | null | undefined {
    return this.natives[location];
  }

  /** The native location of a slot: null when the engine has none, false
   * when it refused the lookup (its error is recorded). Only a name past the
   * lookup limit reaches the engine here, once. */
  native(b: GlBinding, location: number): WebGLUniformLocation | null | false {
    const known = this.natives[location];
    if (known !== undefined) return known;
    const entry = this.slots[location];
    if (!entry) return null;
    const name = entry.array ? `${entry.native}[${location - entry.location}]` : entry.native;
    let found: WebGLUniformLocation | null = null;
    if (!checkedGlCall(b, () => { found = b.gl!.getUniformLocation(this.executable, name); })) return false;
    if (found) this.natives[location] = found;
    return found;
  }
}

const layouts = new WeakMap<WebGLProgram, GlUniformLayout>();
/** The layout of the link a new native executable replaced (relink template). */
const predecessors = new WeakMap<WebGLProgram, GlUniformLayout>();

/** Record a link attempt of a guest program: `next` now holds the program's
 * latest link (`previous` itself when relinked in place). The previous
 * numbering is carried through failed attempts to the next successful one. */
export function noteProgramRelinked(previous: WebGLProgram, next: WebGLProgram): void {
  if (previous === next) return; // its stale layout is the template
  const prior = layouts.get(previous) ?? predecessors.get(previous);
  if (prior) predecessors.set(next, prior); else predecessors.delete(next);
}

/** The numbering of an executable's current link, built on first use.
 * Null when native reflection failed; the error is recorded. */
export function uniformLayout(b: GlBinding, executable: WebGLProgram): GlUniformLayout | null {
  const known = layouts.get(executable);
  if (known && known.current) return known;
  return buildUniformLayout(b, executable, known ?? predecessors.get(executable));
}

type Reflected = { name: string; native: string; type: number; guestType: number; size: number; array: boolean };

function sameActiveSet(reflected: readonly Reflected[], template: GlUniformLayout): boolean {
  if (reflected.length !== template.entries.length) return false;
  for (const uniform of reflected) {
    const old = template.entry(uniform.name);
    if (!old || old.type !== uniform.type || old.guestType !== uniform.guestType
        || old.size !== uniform.size || old.array !== uniform.array) return false;
  }
  return true;
}

function buildUniformLayout(b: GlBinding, executable: WebGLProgram,
    template: GlUniformLayout | undefined): GlUniformLayout | null {
  const gl = b.gl;
  if (!gl) return null;
  const link = programLinkGeneration(b, executable), generation = link.value;
  const entries: GlUniformEntry[] = [], slots: GlUniformEntry[] = [];
  const names = new Map<string, GlUniformEntry>();
  const natives: (WebGLUniformLocation | null | undefined)[] = [];
  if (!checkedGlCall(b, () => {
    const count = Number(gl.getProgramParameter(executable, 0x8b86)) || 0;
    let reflected: Reflected[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
      const info = gl.getActiveUniform(executable, index);
      if (!info) continue;
      const array = info.name.endsWith("[0]");
      const native = array ? info.name.slice(0, -3) : info.name;
      const name = programGuestName(executable, native);
      if (name.startsWith("gl_") || seen.has(name)) continue;
      seen.add(name);
      reflected.push({ name, native, type: info.type, size: info.size,
        guestType: guestUniformType(executable, name, info.type), array });
    }
    if (template && sameActiveSet(reflected, template)) {
      const order = new Map(template.entries.map(entry => [entry.name, entry.location]));
      reflected = reflected.sort((x, y) => order.get(x.name)! - order.get(y.name)!);
    }
    for (const uniform of reflected) {
      const entry: GlUniformEntry = Object.freeze({ ...uniform, location: slots.length });
      entries.push(entry); names.set(entry.name, entry);
      for (let element = 0; element < entry.size; element++) {
        const native = entry.array ? `${entry.native}[${element}]` : entry.native;
        slots.push(entry);
        natives.push(native.length <= WEBGL_LOOKUP_LENGTH ? gl.getUniformLocation(executable, native) : undefined);
      }
    }
  })) return null;
  const layout = new GlUniformLayout(executable, link, generation, entries, slots, names, natives);
  layouts.set(executable, layout);
  predecessors.delete(executable);
  return layout;
}
