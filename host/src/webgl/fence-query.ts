import type { GlBinding } from "./registry.js";
import type { GlFenceCandidate } from "./fences.js";
import { QOP_CREATE_FENCE, QOP_FENCE_STATUS, QOP_RELEASE_FENCE } from "./ops.js";

export const FENCE_REPLY_BYTES = 16;
const REPLY_MAGIC = 0x47514c33;
export function isFenceQuery(op: number): boolean {
  return op === QOP_CREATE_FENCE || op === QOP_FENCE_STATUS || op === QOP_RELEASE_FENCE;
}
export function validFenceQuery(input: Uint8Array, outLength: number): boolean {
  try {
    return input.byteLength === 4 && outLength === FENCE_REPLY_BYTES
      && new DataView(input.buffer,input.byteOffset,4).getUint32(0,true) !== 0;
  } catch { return false; }
}
export type PreparedFenceQuery = { rc: number; candidate: GlFenceCandidate | null };

/** Kernel and main-forward callers publish a creation only after accepting
 * its bounded output. No callback or borrowed input survives this turn. */
export function prepareFenceQuery(b: GlBinding, op: number, input: Uint8Array, out: Uint8Array,
  captureErrors: (gl: WebGL2RenderingContext) => void,
  selectCurrent: () => void): PreparedFenceQuery {
  // All reply metadata exists before any native object can be created.
  const result: PreparedFenceQuery = { rc: -22, candidate: null };
  if (!isFenceQuery(op) || !validFenceQuery(input,out.byteLength)) return result;
  const token = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true);
  if (!token) return result;
  const reply = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let status = 0, signaled = 0;
  try {
    // Polling may refer to a creatorless native context while a peer owns
    // its current GL flags. Do not switch current ownership just to poll.
    const contexts = b.fences.contexts();
    if (b.gl) contexts.add(b.gl);
    for (const gl of contexts) captureErrors(gl);
    if (op === QOP_CREATE_FENCE) {
      if (!b.gl || b.contextId === null) { result.rc = -1; return result; }
      // Retrying an acknowledged request returns its existing identity;
      // it must not insert a second native fence into the command stream.
      if (!b.fences.has(token)) {
        selectCurrent();
        result.candidate = b.fences.prepare(b, token);
        if (!result.candidate) status = 1;
      }
    } else if (op === QOP_FENCE_STATUS) {
      if (!b.fences.has(token)) status = 2;
      else {
        const lease = b.fences.acquire(token);
        if (!lease) { result.rc = -5; return result; }
        try {
          const value = lease.poll(null);
          if (value === null) { result.rc = -5; return result; }
          signaled = value ? 1 : 0;
        } finally { lease.release(); }
      }
    } else if (!b.fences.abandon(token)) { result.rc = -22; return result; }
    reply.setUint32(0, status, true);
    reply.setUint32(4, token, true);
    reply.setUint32(8, signaled, true);
    reply.setUint32(12, REPLY_MAGIC, true);
    result.rc = FENCE_REPLY_BYTES;
    return result;
  } catch {
    result.candidate?.cancel();
    result.candidate = null;
    result.rc = -5;
    return result;
  }
}
