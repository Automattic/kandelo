export interface ReadFetchBodyOptions {
  label: string;
  /** Expected logical bytes after Fetch has decoded any Content-Encoding. */
  expectedBytes?: number;
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
      `lazy file size mismatch for ${label}: ` +
      `expected ${expectedBytes} bytes, received ${receivedBytes}`,
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
  const verifySize = (receivedBytes: number): void => {
    if (options.expectedBytes !== undefined) {
      assertExpectedByteLength(options.label, options.expectedBytes, receivedBytes);
    }
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
    verifySize(data.byteLength);
    return data;
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
          verifySize(loadedBytes);
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

  verifySize(loadedBytes);
  return output ?? concatChunks(chunks, loadedBytes);
}
