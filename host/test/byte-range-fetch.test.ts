import { describe, expect, it } from "vitest";

import {
  type ByteRange,
  byteRangeHeaderValue,
  fetchByteRange,
} from "../src/networking/byte-range-fetch";

const URL_UNDER_TEST = "https://archive.example/game.zip";
// A 64-byte "file" whose byte at offset N is N, so any wrong offset is visible.
const ENTITY = Uint8Array.from({ length: 64 }, (_, index) => index);

interface Observed {
  url: string;
  headers: Headers;
  signal: AbortSignal | undefined;
}

/** An origin that honors single byte ranges the way RFC 9110 describes. */
function rangeCapableOrigin(observed: Observed[] = []) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    observed.push({ url, headers, signal: init.signal ?? undefined });
    const value = headers.get("range")!;
    const suffix = /^bytes=-(\d+)$/.exec(value);
    const span = /^bytes=(\d+)-(\d*)$/.exec(value);
    let start: number;
    let end: number;
    if (suffix) {
      start = Math.max(0, ENTITY.length - Number(suffix[1]));
      end = ENTITY.length - 1;
    } else {
      start = Number(span![1]);
      end = span![2] === ""
        ? ENTITY.length - 1
        : Math.min(Number(span![2]), ENTITY.length - 1);
    }
    return new Response(ENTITY.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${ENTITY.length}` },
    });
  };
}

/** A relay that drops Range and answers with the whole entity. */
async function rangeStrippingRelay(): Promise<Response> {
  return new Response(ENTITY, { status: 200 });
}

function answering(status: number, contentRange: string | null, body = ENTITY) {
  return async () =>
    new Response(body, {
      status,
      headers: contentRange === null ? {} : { "Content-Range": contentRange },
    });
}

describe("byteRangeHeaderValue", () => {
  it.each<[ByteRange, string]>([
    [{ start: 0, end: 0 }, "bytes=0-0"],
    [{ start: 48, end: 63 }, "bytes=48-63"],
    [{ start: 10 }, "bytes=10-"],
    [{ suffixLength: 22 }, "bytes=-22"],
  ])("formats %j as %s", (range, expected) => {
    expect(byteRangeHeaderValue(range)).toBe(expected);
  });

  it.each<ByteRange>([
    { start: -1 },
    { start: 1.5 },
    { start: 9, end: 8 },
    { suffixLength: 0 },
    { start: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects %j before any request", (range) => {
    expect(() => byteRangeHeaderValue(range)).toThrow(RangeError);
  });
});

describe("fetchByteRange", () => {
  it("returns exactly the requested slice for a matching 206", async () => {
    const observed: Observed[] = [];
    const controller = new AbortController();
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { start: 48, end: 63 },
      {
        fetch: rangeCapableOrigin(observed),
        headers: { Accept: "application/zip" },
        ifRange: '"v1"',
        signal: controller.signal,
      },
    );

    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result).toMatchObject({ start: 48, end: 63, completeLength: 64 });
    expect(await result.bytes()).toEqual(ENTITY.slice(48, 64));
    expect(observed).toHaveLength(1);
    expect(observed[0]!.headers.get("range")).toBe("bytes=48-63");
    expect(observed[0]!.headers.get("if-range")).toBe('"v1"');
    expect(observed[0]!.headers.get("accept")).toBe("application/zip");
    expect(observed[0]!.signal).toBe(controller.signal);
  });

  it("accepts a suffix read ending at the representation end", async () => {
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { suffixLength: 22 },
      { fetch: rangeCapableOrigin() },
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.start).toBe(42);
    expect(await result.bytes()).toEqual(ENTITY.slice(42));
  });

  it("clamps a bounded read to a shorter representation", async () => {
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { start: 60, end: 1000 },
      { fetch: rangeCapableOrigin() },
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(await result.bytes()).toEqual(ENTITY.slice(60));
  });

  it("accepts a chunked answer to an open-ended read that starts in place", async () => {
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { start: 8 },
      { fetch: answering(206, "bytes 8-15/64", ENTITY.slice(8, 16)) },
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.end).toBe(15);
    expect(await result.bytes()).toEqual(ENTITY.slice(8, 16));
  });

  it("reports a 200 as the whole entity, never as the requested slice", async () => {
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { start: 48, end: 63 },
      { fetch: rangeStrippingRelay },
    );

    expect(result.kind).toBe("whole-entity");
    expect("bytes" in result).toBe(false);
    if (result.kind !== "whole-entity") return;
    // The body begins at offset 0. Taking its first 16 bytes as the slice
    // would return bytes 0-15 instead of 48-63.
    const body = new Uint8Array(await result.response.arrayBuffer());
    expect(body).toEqual(ENTITY);
    expect(body.subarray(0, 16)).not.toEqual(ENTITY.slice(48, 64));
  });

  it.each<[string, ByteRange, number, string | null, RegExp]>([
    ["a 416", { start: 64 }, 416, "bytes */64", /416/],
    ["a server error", { start: 0 }, 500, null, /500/],
    ["another 2xx", { start: 0 }, 203, null, /203/],
    ["a 206 without Content-Range", { start: 0, end: 3 }, 206, null, /no single-part/],
    ["a multipart 206", { start: 0, end: 3 }, 206, "bytes 0-3,8-11/64", /unusable/],
    ["a 206 at another offset", { start: 48, end: 63 }, 206, "bytes 0-15/64", /does not start at 48/],
    ["a short bounded 206", { start: 48, end: 63 }, 206, "bytes 48-55/64", /does not end at 63/],
    ["a 206 past the end", { start: 48, end: 70 }, 206, "bytes 48-70/64", /past the representation/],
    ["a suffix 206 not at the end", { suffixLength: 4 }, 206, "bytes 56-59/64", /final 4 bytes/],
    ["a suffix 206 of unknown length", { suffixLength: 4 }, 206, "bytes 60-63/*", /declare the length/],
  ])("fails on %s", async (_label, range, status, contentRange, reason) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchByteRange(URL_UNDER_TEST, range, {
      fetch: async () =>
        new Response(status === 416 ? null : body, {
          status,
          headers: contentRange === null ? {} : { "Content-Range": contentRange },
        }),
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.status).toBe(status);
    expect(result.reason).toMatch(reason);
    if (status !== 416) expect(cancelled).toBe(true);
  });

  it("rejects a 206 body whose length contradicts Content-Range", async () => {
    const result = await fetchByteRange(
      URL_UNDER_TEST,
      { start: 48, end: 63 },
      { fetch: answering(206, "bytes 48-63/64", ENTITY.slice(48, 56)) },
    );
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    await expect(result.bytes()).rejects.toThrow(/holds 8 bytes/);
  });

  it("refuses caller-owned Range and If-Range fields", async () => {
    for (const name of ["Range", "if-range"]) {
      await expect(fetchByteRange(URL_UNDER_TEST, { start: 0 }, {
        fetch: rangeCapableOrigin(),
        headers: { [name]: "bytes=0-0" },
      })).rejects.toThrow(/owns Range and If-Range/);
    }
  });

  it("propagates transport failures as rejections", async () => {
    await expect(fetchByteRange(URL_UNDER_TEST, { start: 0 }, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    })).rejects.toThrow("Failed to fetch");
  });
});
