import { describe, expect, it } from "vitest";

import {
  identityEncodedContentLength,
  readExactSizedBody,
} from "../src/sized-download";

const encoder = new TextEncoder();

/** A streaming Response whose body arrives in the given chunks. */
function chunkedResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers, status: 200 });
}

describe("readExactSizedBody", () => {
  it("returns the concatenated body when its length matches exactly", async () => {
    const chunks = [encoder.encode("hello "), encoder.encode("world")];

    const bytes = await readExactSizedBody(chunkedResponse(chunks), 11, "image");

    expect(new TextDecoder().decode(bytes)).toBe("hello world");
  });

  it("never allocates the result in shared memory", async () => {
    const bytes = await readExactSizedBody(
      chunkedResponse([encoder.encode("abcd")]),
      4,
      "image",
    );

    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(bytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
  });

  it("reports cumulative progress against the expected total per chunk", async () => {
    const seen: Array<{ loadedBytes: number; totalBytes: number }> = [];

    await readExactSizedBody(
      chunkedResponse([
        encoder.encode("aaa"),
        encoder.encode("bb"),
        encoder.encode("c"),
      ]),
      6,
      "image",
      (loadedBytes, totalBytes) => seen.push({ loadedBytes, totalBytes }),
    );

    expect(seen).toEqual([
      { loadedBytes: 3, totalBytes: 6 },
      { loadedBytes: 5, totalBytes: 6 },
      { loadedBytes: 6, totalBytes: 6 },
    ]);
  });

  it("rejects a body longer than the expected size without buffering the overrun", async () => {
    await expect(
      readExactSizedBody(
        chunkedResponse([encoder.encode("abc"), encoder.encode("defgh")]),
        4,
        "image",
      ),
    ).rejects.toThrow(/exceeds/i);
  });

  it("rejects a body shorter than the expected size", async () => {
    await expect(
      readExactSizedBody(chunkedResponse([encoder.encode("ab")]), 4, "image"),
    ).rejects.toThrow(/received length/i);
  });

  it("rejects a response with no body", async () => {
    await expect(
      readExactSizedBody(new Response(null, { status: 204 }), 4, "image"),
    ).rejects.toThrow(/no response body/i);
  });
});

describe("identityEncodedContentLength", () => {
  it("reads the length of an identity-encoded response", () => {
    expect(
      identityEncodedContentLength(
        new Response(null, { headers: { "content-length": "2048" } }),
      ),
    ).toBe(2048);
  });

  it("ignores the length of a compressed response", () => {
    // WHY: content-length describes the compressed transfer, while the reader
    // observes decoded bytes. Using it would overrun the bar past 100%.
    expect(
      identityEncodedContentLength(
        new Response(null, {
          headers: { "content-encoding": "gzip", "content-length": "2048" },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when no length is advertised", () => {
    expect(identityEncodedContentLength(new Response(null))).toBeUndefined();
  });

  it("returns undefined for a malformed length", () => {
    expect(
      identityEncodedContentLength(
        new Response(null, { headers: { "content-length": "not-a-number" } }),
      ),
    ).toBeUndefined();
  });
});
