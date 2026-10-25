import { SessionHttpClient } from "../src/networking/session-http";
import type { NetworkIO } from "../src/types";
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

describe("session HTTP ownership and backpressure", () => {
  function network(response: string) {
    let position = 0;
    const writes: number[] = [], closed: number[] = [];
    let received = "";
    const io: NetworkIO = {
      connect: () => {}, connectStatus: () => 0,
      send: (_handle, bytes) => { writes.push(Math.min(3, bytes.length)); received += new TextDecoder().decode(bytes.subarray(0, 3)); return Math.min(3, bytes.length); },
      recv: () => { if (!received.includes("\r\n\r\n")) throw Object.assign(new Error("EAGAIN"), { errno: 11 });
        if (position++) return new Uint8Array(0); return new TextEncoder().encode(response); },
      close: handle => { closed.push(handle); }, getaddrinfo: () => new Uint8Array([10, 89, 0, 1]),
    };
    return { io, writes, closed };
  }
  it("closes the exact connection after short writes and a decoded response", async () => {
    const { io, writes, closed } = network("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const response = await new SessionHttpClient().fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: { Host: "host" }, body: null });
    expect(new TextDecoder().decode(response.body)).toBe("ok");
    expect(writes.length).toBeGreaterThan(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeGreaterThan(0xffffffff);
  });
  it("closes the connection when a response exceeds its byte ceiling", async () => {
    const { io, closed } = network("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    await expect(new SessionHttpClient().fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: { Host: "host" }, body: null }, { maxResponseBytes: 10 })).rejects.toThrow(/bound/);
    expect(closed).toHaveLength(1);
  });
  it("cancels a stalled request and releases its timer and handle on leave", async () => {
    const { io, closed } = network("");
    io.connectStatus = () => -11;
    const client = new SessionHttpClient();
    const result = client.fetch(io, new Uint8Array([10, 89, 0, 1]), 8080,
      { method: "GET", url: "/", headers: {}, body: null });
    const rejected = expect(result).rejects.toThrow(/session ended/);
    client.close(); await rejected;
    expect(closed).toHaveLength(1);
  });
});
