const IntrinsicUint8Array = Uint8Array;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(IntrinsicUint8Array.prototype), "buffer",
)!.get!;

interface SecureRandomSource {
  getRandomValues(bytes: Uint8Array<ArrayBuffer>): unknown;
}

/** Independent host bytes: the provider never receives lent kernel memory. */
export function createSecureRandomBytes(
  byteLength: number,
  provider: SecureRandomSource | undefined = globalThis.crypto,
): Uint8Array<ArrayBuffer> {
  const bytes = new IntrinsicUint8Array(byteLength);
  if (byteLength === 0) return bytes;
  const fill = provider?.getRandomValues;
  if (typeof fill !== "function") {
    const error = new Error("No cryptographically secure host random source");
    Object.assign(error, { code: "ENOSYS" });
    throw error;
  }
  const backing = Reflect.apply(typedArrayBuffer, bytes, []);
  // Web Crypto limits each invocation to 65,536 bytes. Large urandom reads
  // still reach this owner as one request, independently of getrandom's
  // syscall marshalling limit. Never replace a missing/failed CSPRNG with PRNG.
  for (let offset = 0; offset < byteLength; offset += 65_536) {
    const chunk = new IntrinsicUint8Array(
      backing, offset, Math.min(65_536, byteLength - offset),
    );
    Reflect.apply(fill, provider, [chunk]);
  }
  return bytes;
}
