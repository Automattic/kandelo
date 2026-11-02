import { GL_CLIENT_ERROR_MASK, type GlErrorState } from "./errors.js";
import { GL_QUERY_REPLY_MAGIC } from "../generated/abi.js";
import {
  GL_ERROR_DRAIN_CAPACITY, GL_ERROR_DRAIN_REPLY_BYTES, GL_ERROR_DRAIN_REQUEST, GL_ERROR_DRAIN_REQUEST_BYTES,
} from "./ops.js";

export type GlErrorQuery = { mask: number; drain: boolean };

/** QOP_GET_ERROR input. The optional fallback mask uses the same five ES2
 * flags as command trailers. Empty or 4-byte input pops one flag (legacy);
 * the 8-byte [mask, GL_ERROR_DRAIN_REQUEST] form drains every flag. */
export function readGlErrorQuery(input: Uint8Array): GlErrorQuery | null {
  const length = input.byteLength;
  if (length !== 0 && length !== 4 && length !== GL_ERROR_DRAIN_REQUEST_BYTES) return null;
  const view = new DataView(input.buffer, input.byteOffset, length);
  const mask = length ? view.getUint32(0, true) : 0;
  if (mask & ~GL_CLIENT_ERROR_MASK) return null;
  if (length !== GL_ERROR_DRAIN_REQUEST_BYTES) return { mask, drain: false };
  return view.getUint32(4, true) === GL_ERROR_DRAIN_REQUEST ? { mask, drain: true } : null;
}

/** The drain form exists so a guest can answer glGetError without a round
 * trip (ES 2.0 section 2.5: each recorded flag is reported once, in any
 * order). A reply with retained=0 transfers custody of the complete error
 * state; the guest then reports those flags itself until it sends this
 * context more work. Moving flags out in recording order keeps the order
 * the legacy one-at-a-time pop would have produced. The owner array is
 * mutated in place because the muxer may alias it as its error owner. */
export function drainGlErrors(owner: GlErrorState, out: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset, GL_ERROR_DRAIN_REPLY_BYTES);
  const moved = owner.errors.splice(0, GL_ERROR_DRAIN_CAPACITY);
  out.fill(0, 0, GL_ERROR_DRAIN_REPLY_BYTES);
  view.setUint32(0, moved.length, true);
  view.setUint32(4, owner.errors.length ? 1 : 0, true);
  moved.forEach((error, index) => view.setUint32(8 + 4 * index, error, true));
  view.setUint32(GL_ERROR_DRAIN_REPLY_BYTES - 4, GL_QUERY_REPLY_MAGIC, true);
  return GL_ERROR_DRAIN_REPLY_BYTES;
}
