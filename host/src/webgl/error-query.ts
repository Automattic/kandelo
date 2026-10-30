import { GL_CLIENT_ERROR_MASK, mergeClientGlErrors, type GlErrorState } from "./errors.js";

const shift = Array.prototype.shift;
/** A prepared result retains the actual old context's narrow error queue,
 * never its binding or memory. Its ticket excludes another same-owner read. */
export class GlErrorQueryCandidate {
  private mode: "commit" | "cancel" | null = null;
  private accepted = false;
  private result = 0;
  constructor(private queue: number[] | null) {}
  get value(): number { return this.result; }
  owns(queue:number[]): boolean { return this.mode===null && this.queue===queue; }
  capture(): void { this.result = this.queue?.[0] ?? 0; }
  publish(): boolean {
    if (this.mode) return this.mode === "commit" && this.accepted;
    this.mode = "commit";
    if (this.value === 0) this.accepted = true;
    else if (this.queue?.[0] === this.value) {
      Reflect.apply(shift,this.queue,[]); this.accepted = true;
    }
    this.queue = null;
    return this.accepted;
  }
  cancel(): void { if (!this.mode) { this.mode = "cancel"; this.queue = null; } }
}

/** Caller first captures native flags into this exact logical owner while
 * preserving any selected physical peer. No native selector is stored here. */
export function prepareGlErrorQuery(owner: GlErrorState, input: Uint8Array): GlErrorQueryCandidate | null {
  if (input.byteLength !== 0 && input.byteLength !== 4) return null;
  const mask = input.byteLength ? new DataView(input.buffer,input.byteOffset,4).getUint32(0,true) : 0;
  if (mask & ~GL_CLIENT_ERROR_MASK) return null;
  // Allocate the result owner before merging flags. A failed allocation cannot
  // leave unsent C flags ambiguously published into the native logical queue.
  const candidate = new GlErrorQueryCandidate(owner.errors);
  mergeClientGlErrors(owner,mask);
  candidate.capture();
  return candidate;
}
