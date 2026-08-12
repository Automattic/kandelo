import { describe, expect, it } from "vitest";

import {
  BoundedHttpResponseChunks,
  parseRawHttpResponse,
} from "../src/networking/in-kernel-http";

describe("in-kernel HTTP response bounds", () => {
  it("rejects a response before retaining bytes beyond the caller ceiling", () => {
    const chunks = new BoundedHttpResponseChunks(5);
    chunks.push(new Uint8Array([1, 2, 3]));
    expect(() => chunks.push(new Uint8Array([4, 5, 6]))).toThrow(
      /response exceeds its 5-byte bound/,
    );
    expect([...chunks.concat()]).toEqual([1, 2, 3]);
  });

  it("rejects unframed and malformed HTTP responses", () => {
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("expected body without HTTP framing"),
    )).toThrow(/header terminator/);
    expect(() => parseRawHttpResponse(
      new TextEncoder().encode("not-http 200 maybe\r\nContent-Length: 0\r\n\r\n"),
    )).toThrow(/status line/);
  });

  it("rejects incomplete content-length and chunked response framing", () => {
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabc",
    ))).toThrow(/Content-Length/);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "5\r\nabc\r\n0\r\n\r\n",
    ))).toThrow(/chunk/i);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "3\r\nabc\r\n",
    ))).toThrow(/chunk.*truncated/i);
  });

  it("accepts exactly framed content-length and chunked bodies", () => {
    const fixed = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
    ));
    expect(new TextDecoder().decode(fixed.body)).toBe("abc");

    const chunked = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "3\r\nabc\r\n0\r\nX-Trace: ok\r\n\r\n",
    ));
    expect(new TextDecoder().decode(chunked.body)).toBe("abc");
  });

  it("accepts optional header whitespace and bodyless response metadata", () => {
    const head = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length:9\r\nX-Shape:value\r\n\r\n",
    ), "HEAD");
    expect(head.headers["X-Shape"]).toBe("value");
    expect(head.body).toHaveLength(0);

    const notModified = parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 304 Not Modified\r\nContent-Length: 9\r\n\r\n",
    ));
    expect(notModified.body).toHaveLength(0);

    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n",
    ))).toThrow(/Content-Length/);
    expect(() => parseRawHttpResponse(new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc",
    ), "HEAD")).toThrow(/must not contain a body/);
  });
});
