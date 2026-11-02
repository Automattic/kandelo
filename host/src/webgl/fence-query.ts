import type { GlBinding } from "./registry.js";
import type { GlFenceCandidate, GlFenceLease } from "./fences.js";
import { QOP_CREATE_FENCE, QOP_FENCE_STATUS, QOP_RELEASE_FENCE } from "./ops.js";
import { rethrowNativeGlFault } from "./native-recovery.js";

export const FENCE_REPLY_BYTES = 16;
const REPLY_MAGIC = 0x47514c33;
export function isFenceQuery(op: number): boolean {
  return op === QOP_CREATE_FENCE || op === QOP_FENCE_STATUS || op === QOP_RELEASE_FENCE;
}
export function validFenceQuery(input: Uint8Array, outLength: number): boolean {
  try {
    return input.byteLength === 4 && outLength === FENCE_REPLY_BYTES
      && new DataView(input.buffer,input.byteOffset,4).getUint32(0,true) !== 0;
  } catch (caught) { rethrowNativeGlFault(caught); return false; }
}
export type PreparedFenceQuery = { rc: number; candidate: GlFenceCandidate | null };

/** The kernel publishes a creation only after accepting
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
    // Creation touches only b.gl, after selecting b: the switch captures an
    // outgoing peer's flags and creation captures b's own, so capturing
    // first would be a second round trip that can find nothing.
    if (op !== QOP_CREATE_FENCE) {
      const contexts = b.fences.contexts();
      if (b.gl) contexts.add(b.gl);
      for (const gl of contexts) captureErrors(gl);
    }
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
  } catch (caught) {
    result.candidate?.cancel();
    result.candidate = null; rethrowNativeGlFault(caught);
    result.rc = -5;
    return result;
  }
}

export const SERVER_WAIT_REPLY_BYTES = 16;
/** Reply word 2 of a server wait: the destination may proceed immediately. */
export const SERVER_WAIT_ORDERED = 0;
/** Reply word 2: the fence lives on another physical context, so the caller
 * must observe the signal before issuing its later destination commands. */
export const SERVER_WAIT_CLIENT_SIGNAL = 1;

/** eglWaitSync on the synchronous kernel-worker host.
 *
 * Every accepted submission is executed before host_gl_submit returns, and a
 * fence is created only while its session has no queued work, so the fence
 * already follows all of the source's earlier commands in host order. When
 * source and destination share one physical WebGL context, the native
 * waitSync is the exact server-side barrier. Separate physical contexts have
 * no shared native command stream; there the caller must wait for the signal
 * itself before it issues later commands, which is the observable contract
 * of a server wait without inventing a queue the host cannot drive.
 *
 * in: [source session id, fence token] (the kernel replaced the guest fd);
 * out: [status, token, SERVER_WAIT_*, magic]. Status 2 = unknown fence. */
export function runServerWait(destination: GlBinding, source: GlBinding | undefined,
  input: Uint8Array, out: Uint8Array,
  captureErrors: (gl: WebGL2RenderingContext) => void,
  selectCurrent: () => void,
  exported?: GlFenceLease | null): number {
  if (input.byteLength !== 8 || out.byteLength !== SERVER_WAIT_REPLY_BYTES) return -22;
  const view = new DataView(input.buffer, input.byteOffset, 8);
  const token = view.getUint32(4, true);
  if (!token) return -22;
  const gl = destination.gl;
  if (!gl || destination.contextId === null) return -1;
  if (view.getUint32(0, true) === 0) {
    // Session 0: an imported sync_file whose one pending fence is a GL fence
    // this host retained for the kernel under export id `token`. The kernel
    // forwards only live exports, so a missing one is a host fault (-EIO).
    // The guest named the file by fd with token 0, which the reply echoes.
    if (!exported) return -5;
    let disposition = SERVER_WAIT_CLIENT_SIGNAL;
    if (exported.context === gl) {
      captureErrors(gl);
      selectCurrent();
      if (exported.enqueueNativeWait(gl, null) !== true) return -5;
      disposition = SERVER_WAIT_ORDERED;
    }
    const reply = new DataView(out.buffer, out.byteOffset, out.byteLength);
    reply.setUint32(0, 0, true);
    reply.setUint32(4, 0, true);
    reply.setUint32(8, disposition, true);
    reply.setUint32(12, REPLY_MAGIC, true);
    return SERVER_WAIT_REPLY_BYTES;
  }
  let status = 0, disposition = SERVER_WAIT_ORDERED;
  if (!source || !source.fences.has(token)) status = 2;
  else {
    const lease = source.fences.acquire(token);
    if (!lease) return -5;
    try {
      if (lease.context === gl) {
        // Pending flags belong to the outgoing owner; move them there before
        // the destination becomes current and the barrier is issued.
        captureErrors(gl);
        selectCurrent();
        if (lease.enqueueNativeWait(gl, null) !== true) return -5;
      } else disposition = SERVER_WAIT_CLIENT_SIGNAL;
    } finally { lease.release(); }
  }
  const reply = new DataView(out.buffer, out.byteOffset, out.byteLength);
  reply.setUint32(0, status, true);
  reply.setUint32(4, token, true);
  reply.setUint32(8, disposition, true);
  reply.setUint32(12, REPLY_MAGIC, true);
  return SERVER_WAIT_REPLY_BYTES;
}

/** Reply word 2 of an export: the fence is on the shared native context, so
 * every later consumer is already ordered behind it (decision D-17). */
export const EXPORT_FENCE_ORDERED = 0;
/** Reply word 2: the fence is on a separate native context; the host retains
 * it under the export id and observes its native status for the kernel. */
export const EXPORT_FENCE_RETAINED = 1;

/** DRM_IOCTL_WPK_EXPORT_FENCE (eglDupNativeFenceFDANDROID).
 *
 * in: [fence token, kernel export id]; out: [status, token, disposition,
 * magic]. Status 2 = unknown fence. A fence on `sharedContext` needs no
 * retention: submission order already completes it for every consumer. A
 * fence elsewhere is retained (an independent native pin, surviving the EGL
 * sync's destruction) until the kernel releases the export. */
export function runExportFence(b: GlBinding, input: Uint8Array, out: Uint8Array,
  sharedContext: WebGL2RenderingContext | null,
  captureErrors: (gl: WebGL2RenderingContext) => void,
  retain: (exportId: number, lease: GlFenceLease) => boolean): number {
  if (input.byteLength !== 8 || out.byteLength !== FENCE_REPLY_BYTES) return -22;
  const view = new DataView(input.buffer, input.byteOffset, 8);
  const token = view.getUint32(0, true), exportId = view.getUint32(4, true);
  if (!token || !exportId) return -22;
  let status = 0, disposition = EXPORT_FENCE_ORDERED;
  if (!b.fences.has(token)) status = 2;
  else {
    const lease = b.fences.acquire(token);
    if (!lease) return -5;
    if (sharedContext !== null && lease.context === sharedContext) {
      captureErrors(lease.context);
      lease.release();
    } else if (retain(exportId, lease)) disposition = EXPORT_FENCE_RETAINED;
    else { captureErrors(lease.context); lease.release(); return -5; }
  }
  const reply = new DataView(out.buffer, out.byteOffset, out.byteLength);
  reply.setUint32(0, status, true);
  reply.setUint32(4, token, true);
  reply.setUint32(8, disposition, true);
  reply.setUint32(12, REPLY_MAGIC, true);
  return FENCE_REPLY_BYTES;
}
