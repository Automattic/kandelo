const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ReadFetchBodyOptions {
  label: string;
  /** Expected logical bytes after Fetch has decoded any Content-Encoding. */
  expectedBytes?: number;
  /** Expected SHA-256 of the decoded Fetch body, written as lowercase hex. */
  expectedSha256?: string;
  onProgress?: (loadedBytes: number) => void;
}

/** The largest single lazy file/archive supported by the 1 GiB image VFS. */
export const MAX_LAZY_CONTENT_BYTES = 1024 * 1024 * 1024;

export function assertValidLazyContentSize(label: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} must declare a non-negative safe-integer size`);
  }
  if (size > MAX_LAZY_CONTENT_BYTES) {
    throw new Error(
      `${label} exceeds the ${MAX_LAZY_CONTENT_BYTES}-byte lazy content limit`,
    );
  }
}

export function assertExpectedByteLength(
  label: string,
  expectedBytes: number,
  receivedBytes: number,
): void {
  assertValidLazyContentSize(label, expectedBytes);
  if (receivedBytes !== expectedBytes) {
    throw new Error(
      `lazy content size mismatch for ${label}: ` +
      `expected ${expectedBytes} bytes, received ${receivedBytes}`,
    );
  }
}

export function assertValidLazySha256(label: string, sha256: string): void {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`${label} must declare a lowercase hexadecimal SHA-256`);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto deliberately excludes SharedArrayBuffer-backed views from
  // BufferSource. Reuse ordinary ArrayBuffer bytes, but copy a shared view.
  let digestInput: Uint8Array<ArrayBuffer>;
  if (bytes.buffer instanceof ArrayBuffer) {
    digestInput = new Uint8Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
  } else {
    digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", digestInput),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertExpectedSha256(
  label: string,
  expectedSha256: string,
  bytes: Uint8Array,
): Promise<void> {
  assertValidLazySha256(label, expectedSha256);
  const receivedSha256 = await sha256Hex(bytes);
  if (receivedSha256 !== expectedSha256) {
    throw new Error(
      `lazy content SHA-256 mismatch for ${label}: ` +
      `expected ${expectedSha256}, received ${receivedSha256}`,
    );
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readFetchBody(
  response: Response,
  options: ReadFetchBodyOptions,
): Promise<Uint8Array> {
  if (options.expectedBytes !== undefined) {
    assertValidLazyContentSize(options.label, options.expectedBytes);
  }
  if (options.expectedSha256 !== undefined) {
    assertValidLazySha256(options.label, options.expectedSha256);
  }
  const verify = async (data: Uint8Array): Promise<Uint8Array> => {
    if (options.expectedBytes !== undefined) {
      assertExpectedByteLength(
        options.label,
        options.expectedBytes,
        data.byteLength,
      );
    }
    if (options.expectedSha256 !== undefined) {
      await assertExpectedSha256(options.label, options.expectedSha256, data);
    }
    return data;
  };

  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    options.onProgress?.(data.byteLength);
    if (data.byteLength > MAX_LAZY_CONTENT_BYTES) {
      throw new Error(
        `lazy content for ${options.label} exceeds the ` +
        `${MAX_LAZY_CONTENT_BYTES}-byte limit`,
      );
    }
    return verify(data);
  }

  const reader = response.body.getReader();
  const output = options.expectedBytes === undefined
    ? undefined
    : new Uint8Array(options.expectedBytes);
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const offset = loadedBytes;
      loadedBytes += value.byteLength;
      options.onProgress?.(loadedBytes);
      if (loadedBytes > (options.expectedBytes ?? MAX_LAZY_CONTENT_BYTES)) {
        try { await reader.cancel(); } catch { /* preserve the integrity error */ }
        if (options.expectedBytes !== undefined) {
          assertExpectedByteLength(options.label, options.expectedBytes, loadedBytes);
        }
        throw new Error(
          `lazy content for ${options.label} exceeds the ` +
          `${MAX_LAZY_CONTENT_BYTES}-byte limit`,
        );
      }
      if (output) {
        output.set(value, offset);
      } else {
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return verify(output ?? concatChunks(chunks, loadedBytes));
}
