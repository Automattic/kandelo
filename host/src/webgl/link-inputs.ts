/**
 * What each program was last linked from, for the checkpoint.
 *
 * A checkpoint rebuilds a linked program by attaching the shaders it holds
 * now and linking again (`rebuild.ts`). That reproduces the executable only
 * while those are still the link's inputs. A guest that detaches or deletes
 * its shaders after the link, which is the common pattern, or that sets new
 * source or new attribute bindings, holds an executable no relink of its
 * current attachments gives back, so the capture refuses it instead.
 */
import type { GlBinding } from "./registry.js";

type LinkInputs = {
  readonly shaders: ReadonlyMap<number, Uint8Array | undefined>;
  readonly bindings: string;
};

const linked = new WeakMap<GlBinding["objects"], Map<number, LinkInputs>>();

function currentInputs(b: GlBinding, program: number): LinkInputs {
  const shaders = new Map<number, Uint8Array | undefined>();
  for (const name of b.programShaders.get(program) ?? []) {
    const shader = b.shaders.get(name);
    shaders.set(name, shader && b.shaderSources.get(shader));
  }
  const bindings = JSON.stringify([...(b.programAttributeBindings.get(program) ?? [])].sort());
  return { shaders, bindings };
}

/** Called on every link attempt of `program`. */
export function recordLinkInputs(b: GlBinding, program: number): void {
  let programs = linked.get(b.objects);
  if (!programs) linked.set(b.objects, programs = new Map());
  programs.set(program, currentInputs(b, program));
}

/** True when a relink of `program`'s current attachments would not use what
 * its last link used. */
export function linkInputsChanged(b: GlBinding, program: number): boolean {
  const recorded = linked.get(b.objects)?.get(program);
  if (!recorded) return false;
  const current = currentInputs(b, program);
  if (current.bindings !== recorded.bindings) return true;
  if (current.shaders.size !== recorded.shaders.size) return true;
  for (const [name, source] of recorded.shaders) {
    if (!current.shaders.has(name) || current.shaders.get(name) !== source) return true;
  }
  return false;
}
