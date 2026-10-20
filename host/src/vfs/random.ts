import type { RandomProvider } from "./types";

/** How many bytes one `crypto.getRandomValues` call may fill. */
const CRYPTO_CHUNK_BYTES = 65536;

/**
 * The host's own randomness, for a machine that is not being replicated.
 *
 * One class serves both hosts: `crypto.getRandomValues` is global in the
 * browser and in every supported Node.js. The chunk loop covers a draw larger
 * than the single-call quota, and the `Math.random` fallback keeps a runtime
 * without WebCrypto functional rather than secure.
 */
export class HostRandomProvider implements RandomProvider {
  getRandomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
      for (let at = 0; at < length; at += CRYPTO_CHUNK_BYTES) {
        globalThis.crypto.getRandomValues(
          bytes.subarray(at, Math.min(at + CRYPTO_CHUNK_BYTES, length)),
        );
      }
      return bytes;
    }
    for (let i = 0; i < length; i++) bytes[i] = (Math.random() * 256) | 0;
    return bytes;
  }
}
