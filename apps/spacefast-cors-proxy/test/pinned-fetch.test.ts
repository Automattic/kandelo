import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import { createPinnedFetch, resolvePublicAddresses, type Socket, type Connect } from "../src/pinned-fetch.ts";
import { createCorsProxy } from "../src/proxy.ts";

const enc = new TextEncoder();
const init = (): RequestInit & { duplex: "half" } => ({ method: "GET", duplex: "half", signal: new AbortController().signal });
const publicDns: typeof fetch = async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] });
function fixture(wire = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
  opts: { rejectOpen?: boolean; rejectTls?: boolean; rejectClose?: boolean; rejectWrite?: boolean;
    stream?: ReadableStream<Uint8Array> } = {}) {
  const calls: unknown[] = [];
  const writes: Uint8Array[] = [];
  let closed = 0;
  const failedOpen = () => Promise.reject(new Error("connection refused"));
  const stream = opts.stream ?? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(wire)); c.close(); } });
  const socket: Socket = {
    readable: stream,
    writable: new WritableStream({ write(chunk) {
      if (opts.rejectWrite) throw new Error("write failed");
      writes.push(chunk);
    } }),
    opened: opts.rejectOpen ? failedOpen() : Promise.resolve({}),
    closed: Promise.resolve(),
    async close() { closed++; if (opts.rejectClose) throw new Error("close failed"); },
    startTls(options) {
      calls.push(options);
      if (opts.rejectTls) return { ...socket, opened: failedOpen() };
      return socket;
    },
  };
  const connect: Connect = (...args) => { calls.push(args); return socket; };
  const fetch = createPinnedFetch({ connect, dnsFetch: publicDns });
  return { fetch, connect, calls, writes, socket, get closed() { return closed; } };
}

test("DNS uses only the fixed HTTPS resolver and requests both address families", async () => {
  const queries: string[] = [];
  const dns: typeof fetch = async (url, options) => {
    queries.push(String(url)); assert.equal(options!.redirect, "manual");
    assert.equal(new Headers(options!.headers).get("accept"), "application/dns-json");
    return Response.json({ Status: 0, Answer: String(url).endsWith("type=A")
      ? [{ type: 5, data: "alias.example" }, { type: 1, data: "8.8.8.8" }, { type: 1, data: "8.8.8.8" }]
      : [{ type: 28, data: "2001:4860:4860::8888" }] });
  };
  assert.deepEqual(await resolvePublicAddresses("public.example", dns, new AbortController().signal), ["8.8.8.8", "[2001:4860:4860::8888]"]);
  assert.deepEqual(queries, ["https://1.1.1.1/dns-query?name=public.example&type=A", "https://1.1.1.1/dns-query?name=public.example&type=AAAA"]);
});

test("literal addresses bypass DNS but never bypass the public-address check", async () => {
  const forbiddenDns: typeof fetch = async () => { throw new Error("must not lookup"); };
  for (const host of ["8.8.8.8", "[2001:4860:4860::8888]"]) {
    assert.deepEqual(await resolvePublicAddresses(host, forbiddenDns, new AbortController().signal), [host]);
  }
  for (const host of ["127.0.0.1", "[::1]"]) await assert.rejects(resolvePublicAddresses(host, forbiddenDns, new AbortController().signal), /Forbidden/);
});

test("DNS redirects are rejected without following their destination", async () => {
  const urls: string[] = [];
  const dns: typeof fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/dns" } });
  };
  await assert.rejects(resolvePublicAddresses("public.example", dns, new AbortController().signal), /DNS lookup failed/);
  assert.ok(urls.every(url => url.startsWith("https://1.1.1.1/dns-query?")));
});

test("mixed public/private DNS answers fail before any socket can open", async () => {
  for (const answer of [
    [{ type: 1, data: "8.8.8.8" }, { type: 1, data: "127.0.0.1" }],
    [{ type: 1, data: "169.254.169.254" }],
    [{ type: 28, data: "::ffff:8.8.8.8" }],
    [{ type: 28, data: "fd00::1" }],
  ]) {
    let connected = false;
    const fetch = createPinnedFetch({ dnsFetch: async () => Response.json({ Status: 0, Answer: answer }),
      connect: () => { connected = true; throw new Error("must not connect"); } });
    await assert.rejects(fetch("https://public.example", init()), /Forbidden/);
    assert.equal(connected, false);
  }
});

test("DNS failures, invalid answers and address-family confusion fail closed", async () => {
  for (const value of [{ Status: 3 }, { Status: 0 }, { Status: 0, Answer: [] },
    { Status: 0, Answer: {} }, { Status: 0, Answer: [{ type: 5, data: "alias.example" }] },
    { Status: 0, Answer: [{ type: 1, data: 1 }] }, { Status: 0, Answer: [{ type: 1, data: "host.example" }] },
    { Status: 0, Answer: [{ type: 1, data: "8.8.8.8/path" }] },
    { Status: 0, Answer: [{ type: 1, data: "8.8.8.8?query" }] },
    { Status: 0, Answer: [{ type: 1, data: "8.8.8.8#fragment" }] },
    { Status: 0, Answer: [{ type: 1, data: "u@8.8.8.8" }] },
    { Status: 0, Answer: [{ type: 28, data: "8.8.8.8" }] },
    { Status: 0, Answer: [{ type: 1, data: "2001:4860::1" }] }]) {
    await assert.rejects(resolvePublicAddresses("public.example", async () => Response.json(value), new AbortController().signal));
  }
  for (const response of [new Response("error", { status: 503 }), new Response(null, { status: 503 }),
    new Response("not JSON"), new Response("x".repeat(65537))]) {
    const bytes = await response.arrayBuffer();
    await assert.rejects(resolvePublicAddresses("public.example", async () => new Response(response.status === 503 && bytes.byteLength === 0 ? null : bytes.slice(0), { status: response.status }), new AbortController().signal));
  }
  await assert.rejects(resolvePublicAddresses("public.example", async () => { throw new Error("DNS unavailable"); }, new AbortController().signal), /DNS unavailable/);
});

test("HTTP connects to the validated numeric IP with the original Host and path", async () => {
  const f = fixture();
  const response = await f.fetch("http://public.example:8080/path?one=1", { ...init(), headers: { "X-Custom": "data" } });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(f.calls, [[{ hostname: "8.8.8.8", port: 8080 }, { secureTransport: "off", allowHalfOpen: true }]]);
  const wire = Buffer.concat(f.writes).toString();
  assert.match(wire, /^GET \/path\?one=1 HTTP\/1.1\r\n/);
  assert.match(wire, /host: public.example:8080\r\n/);
  assert.match(wire, /x-custom: data\r\n/);
  assert.equal(f.closed, 1);
});

test("TLS connects to a pinned IP but verifies the original hostname, including IPv6", async () => {
  for (const [url, ip, hostname, port] of [
    ["https://public.example/path", "8.8.8.8", "public.example", 443],
    ["https://[2001:4860:4860::8888]:8443/path", "2001:4860:4860::8888", "2001:4860:4860::8888", 8443],
  ] as const) {
    const f = fixture();
    assert.equal(await (await f.fetch(url, init())).text(), "ok");
    assert.deepEqual(f.calls[0], [{ hostname: ip, port }, { secureTransport: "starttls", allowHalfOpen: true }]);
    assert.deepEqual(f.calls[1], { expectedServerHostname: hostname });
  }
});

test("DNS rebinding after lookup cannot replace the socket destination", async () => {
  let queries = 0;
  const f = fixture();
  const fetch = createPinnedFetch({ dnsFetch: async () => {
    queries++; return Response.json({ Status: 0, Answer: [{ type: 1, data: queries <= 2 ? "8.8.8.8" : "127.0.0.1" }] });
  }, connect: f.connect });
  assert.equal(await (await fetch("http://attacker.example", init())).text(), "ok");
  assert.equal(queries, 2);
  assert.equal((f.calls[0] as [{ hostname: string }])[0].hostname, "8.8.8.8");
  // No extra lookup at connection time or through hostname fetch exists.
});

test("POST uses chunked framing, ignores caller framing, and preserves binary data", async () => {
  const f = fixture();
  const body = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new Uint8Array(0)); c.enqueue(new Uint8Array([0, 255, 13, 10])); c.close();
  } });
  const response = await f.fetch("http://public.example", { ...init(), method: "POST", body,
    headers: { "Content-Length": "100", "Transfer-Encoding": "evil" } });
  assert.equal(await response.text(), "ok");
  const wire = Buffer.concat(f.writes);
  assert.match(wire.toString(), /transfer-encoding: chunked\r\n/);
  assert.ok(wire.includes(Buffer.from([52, 13, 10, 0, 255, 13, 10, 13, 10, 48, 13, 10, 13, 10])));
  assert.doesNotMatch(wire.toString(), /content-length/);
  const empty = fixture();
  await (await empty.fetch("http://public.example", { ...init(), method: "POST" })).text();
  assert.match(Buffer.concat(empty.writes).toString(), /content-length: 0\r\n/);
});

test("HTTP body framing: chunk extensions, trailers, Content-Length and close-delimited bodies", async () => {
  for (const wire of [
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 9999\r\n\r\n2;extension=yes\r\nok\r\n0\r\nX-Trailer: ignored\r\n\r\n",
    "HTTP/1.0 200\r\n\r\nok",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokignored",
  ]) {
    const f = fixture(wire); const response = await f.fetch("http://public.example", init());
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("x-trailer"), null); assert.equal(f.closed, 1);
  }
  const empty = fixture("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  assert.equal(await (await empty.fetch("http://public.example", init())).text(), "");
});

test("split status/header/chunk delimiters are parsed without dropping bytes", async () => {
  const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n";
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === wire.length) c.close(); else c.enqueue(enc.encode(wire[offset++]));
  } });
  const f = fixture("", { stream });
  assert.equal(await (await f.fetch("http://public.example", init())).text(), "ok");
});

test("interim responses are skipped and bodyless status/HEAD responses close sockets", async () => {
  const f = fixture("HTTP/1.1 100 Continue\r\nX-Interim: ignored\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: ignored\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Final: yes\r\n\r\nok");
  const response = await f.fetch("http://public.example", init());
  assert.equal(await response.text(), "ok"); assert.equal(response.headers.get("x-interim"), null);
  assert.equal(response.headers.get("link"), null); assert.equal(response.headers.get("x-final"), "yes");
  for (const status of [204, 205, 304]) {
    const f = fixture(`HTTP/1.1 ${status} Done\r\n\r\n`);
    assert.equal(await (await f.fetch("http://public.example", init())).text(), "");
    assert.equal(f.closed, 1);
  }
  const head = fixture("HTTP/1.1 200 OK\r\nContent-Length: 4294967296\r\n\r\n");
  const result = await head.fetch("http://public.example", { ...init(), method: "HEAD" });
  assert.equal(result.headers.get("content-length"), "4294967296"); assert.equal(await result.text(), "");
});

test("malformed status/header/framing and upgrades fail before response", async () => {
  for (const wire of ["HTTP/1.1 101 Switching Protocols\r\n\r\n", "not HTTP\r\n\r\n", "HTTP/2 200 OK\r\n\r\n",
    "HTTP/1.1 200 OK\r\nBad Header: value\r\n\r\n", "HTTP/1.1 200 OK\r\nmissing-colon\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 9007199254740992\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", "HTTP/1.1 200 OK\r\n",
    "HTTP/1.1 100 Continue\r\n\r\n".repeat(9),
    "x".repeat(65537), "x".repeat(65537) + "\r\n",
    "HTTP/1.1 200 OK\r\n" + "x: y\r\n".repeat(12000) + "\r\n",
  ]) {
    const f = fixture(wire);
    await assert.rejects(f.fetch("http://public.example", init()), Error, wire.slice(0, 50));
    assert.equal(f.closed, 1);
  }
});

test("truncated and malformed chunk bodies error instead of returning successful partial data", async () => {
  for (const body of ["2\r\no", "z\r\n", "20000000000000\r\n", "2\r\nokBAD\r\n", "0\r\nInvalid trailer\r\n\r\n"]) {
    const f = fixture(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`);
    const response = await f.fetch("http://public.example", init());
    await assert.rejects(response.text()); assert.equal(f.closed, 1);
  }
  const f = fixture("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok");
  await assert.rejects((await f.fetch("http://public.example", init())).text(), /Incomplete/);
});

test("compressed payloads stay byte-exact, including unsupported codecs", async () => {
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]] as const) {
    const bytes = compress(Buffer.from("encoded response"));
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(enc.encode(`HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${bytes.length}\r\n\r\n`));
      c.enqueue(bytes); c.close();
    } });
    const f = fixture("", { stream });
    const response = await f.fetch("http://public.example", init());
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get("content-encoding"), encoding);
  }
  const range = fixture("HTTP/1.1 206 Partial Content\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nok");
  const partial = await range.fetch("http://public.example", init());
  assert.equal(partial.headers.get("content-encoding"), "gzip"); assert.equal(await partial.text(), "ok");
  const unknown = fixture("HTTP/1.1 200 OK\r\nContent-Encoding: br\r\n\r\nencoded");
  const br = await unknown.fetch("http://public.example", init());
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.equal(await br.text(), "encoded");
  const identity = fixture("HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\n\r\nok");
  assert.equal(await (await identity.fetch("http://public.example", init())).text(), "ok");
});

test("connection, TLS, write and close errors fail closed without a hostname-fetch fallback", async () => {
  for (const opts of [{ rejectOpen: true }, { rejectTls: true }, { rejectWrite: true }]) {
    const f = fixture(undefined, opts);
    await assert.rejects(f.fetch("https://public.example", init())); assert.equal(f.closed, 1);
  }
  const f = fixture(undefined, { rejectClose: true });
  assert.equal(await (await f.fetch("http://public.example", init())).text(), "ok");
});

test("cancel/abort close the exact socket, including abort after DNS but before connect", async () => {
  const f = fixture(); const controller = new AbortController();
  const response = await f.fetch("http://public.example", { ...init(), signal: controller.signal });
  controller.abort(); await response.body!.cancel(); assert.equal(f.closed, 1);
  const already = new AbortController(); already.abort();
  const rejected = fixture();
  await assert.rejects(rejected.fetch("http://8.8.8.8", { ...init(), signal: already.signal }), /aborted/);
  assert.equal(rejected.closed, 1);
  const cancelled = fixture();
  await (await cancelled.fetch("http://public.example", init())).body!.cancel();
  assert.equal(cancelled.closed, 1);
});

test("response cancellation also cancels a still-pending client upload", async () => {
  for (const rejectCancel of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() {
      cancelled = true;
      if (rejectCancel) throw new Error("upload cancellation failed");
    } });
    const f = fixture();
    const response = await f.fetch("http://public.example", { ...init(), method: "POST", body });
    await response.body!.cancel();
    assert.equal(cancelled, true);
    assert.equal(f.closed, 1);
  }
});

test("upload failures propagate both before headers and during body/HEAD completion", async () => {
  for (const method of ["POST", "HEAD"]) {
    const f = fixture();
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("upload failed"); } });
    try {
      const response = await f.fetch("http://public.example", { ...init(), method, body });
      await assert.rejects(response.text(), /upload failed/);
    } catch (error) { assert.match((error as Error).message, /upload failed/); }
    assert.equal(f.closed, 1);
  }
});

test("upload errors arriving while response completion waits remain failures", async () => {
  for (const headers of ["Content-Length: 0\r\n", ""]) {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const f = fixture(`HTTP/1.1 200 OK\r\n${headers}\r\n`);
    const response = await f.fetch("http://public.example", { ...init(), method: "POST", body });
    const completion = response.text();
    source.error(new Error("late upload failure"));
    await assert.rejects(completion, /late upload failure/);
    assert.equal(f.closed, 1);
  }
});

test("proxy redirects do not automatically connect to a second host", async () => {
  const f = fixture("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n");
  const proxy = createCorsProxy({ disableRateLimit: true, fetch: f.fetch });
  const response = await proxy(new Request("https://proxy.example/?http://public.example"));
  assert.equal(response.status, 502); assert.equal(await response.text(), "Bad Gateway");
  assert.equal(f.calls.length, 1); assert.equal(f.closed, 1);
});
