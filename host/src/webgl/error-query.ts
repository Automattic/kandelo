import { GL_CLIENT_ERROR_MASK } from "./errors.js";

/** The optional fallback mask uses the same five ES2 flags as command trailers. */
export function readGlErrorQueryMask(input: Uint8Array): number | null {
  if (input.byteLength !== 0 && input.byteLength !== 4) return null;
  const mask = input.byteLength ? new DataView(input.buffer,input.byteOffset,4).getUint32(0,true) : 0;
  return mask & ~GL_CLIENT_ERROR_MASK ? null : mask;
}
