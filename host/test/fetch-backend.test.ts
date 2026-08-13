import { afterEach, describe, it, expect, vi } from "vitest";
import { FetchNetworkBackend, EagainError } from "../src/networking/fetch-backend";
import { TlsNetworkBackend, type TlsMitmConnection } from "../src/networking/tls-network-backend";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MSG_PEEK = 0x0002;
const NativeHeaders = globalThis.Headers;

class RecordingHeaders extends NativeHeaders {
  readonly appendCalls: Array<[string, string]> = [];

  override append(name: string, value: string): void {
    this.appendCalls.push([name, value]);
    super.append(name, value);
  }
}

function installRecordingHeaders(): void {
  vi.stubGlobal("Headers", RecordingHeaders);
}

function expectAppendCalls(
  headers: Headers,
  expected: Array<[string, string]>,
): void {
  expect(headers).toBeInstanceOf(RecordingHeaders);
  expect((headers as RecordingHeaders).appendCalls).toEqual(expected);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sendGet(
  backend: Pick<TlsNetworkBackend, "send">,
  handle: number,
  path: string,
  host = "example.com",
) {
  backend.send(
    handle,
    encoder.encode(
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      "Connection: keep-alive\r\n" +
      "\r\n",
    ),
    0,
  );
}

async function recvWhenReady(
  backend: Pick<TlsNetworkBackend, "recv">,
  handle: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      return backend.recv(handle, 4096, 0);
    } catch (err) {
      if (err instanceof EagainError) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      throw err;
    }
  }
  throw new Error("timed out waiting for response");
}

/**
 * Loopback stand-in for the TLS 1.2 server engine. The real engine encrypts the
 * server's plaintext response asynchronously before it surfaces on
 * clientEnd.downstream; forwarding each record a macrotask late reproduces that
 * ordering — the window in which the EOF race surfaced.
 */
class LoopbackMitmTls implements TlsMitmConnection {
  clientEnd = {
    upstream: new TransformStream<Uint8Array, Uint8Array>(),
    downstream: new TransformStream<Uint8Array, Uint8Array>(),
  };
  serverEnd = {
    upstream: new TransformStream<Uint8Array, Uint8Array>(),
    downstream: new TransformStream<Uint8Array, Uint8Array>(),
  };

  constructor() {
    const encrypted = this.clientEnd.downstream.writable.getWriter();
    this.serverEnd.downstream.readable
      .pipeTo(
        new WritableStream({
          async write(chunk) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await encrypted.write(chunk);
          },
          async close() {
            await encrypted.close();
          },
        }),
      )
      .catch(() => {});
  }

  async TLSHandshake(): Promise<void> {}
  async close(): Promise<void> {}
}

async function waitForReadable(
  backend: Pick<TlsNetworkBackend, "poll">,
  handle: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((backend.poll(handle, 0x0001) & 0x0001) !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for readable poll");
}

describe("FetchNetworkBackend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getaddrinfo", () => {
    it("returns a 4-byte address for DNS names that can be deferred to fetch", () => {
      const backend = new FetchNetworkBackend();
      const addr = backend.getaddrinfo("example.com");
      expect(addr.length).toBe(4);
      expect(addr[0]).toBe(10); // 10.x.x.x range
    });

    it("returns deterministic results for same hostname", () => {
      const backend = new FetchNetworkBackend();
      const addr1 = backend.getaddrinfo("example.com");
      const addr2 = backend.getaddrinfo("example.com");
      expect(addr1).toEqual(addr2);
    });

    it("returns numeric IPv4 literals without synthesizing a DNS address", () => {
      const backend = new FetchNetworkBackend();
      expect(Array.from(backend.getaddrinfo("2130706433"))).toEqual([127, 0, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.1"))).toEqual([127, 0, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.1.1"))).toEqual([127, 1, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.0.0.1"))).toEqual([127, 0, 0, 1]);
    });

    it("rejects malformed numeric IPv4 literals", () => {
      const backend = new FetchNetworkBackend();
      expect(() => backend.getaddrinfo("4294967296")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("1..2")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("9999.9999.9999.9999")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("1.2.3.256")).toThrow("ENOENT");
    });

    it("rejects syntactically invalid DNS names", () => {
      const backend = new FetchNetworkBackend();
      expect(backend.getaddrinfo("example.com.")).toHaveLength(4);
      expect(() => backend.getaddrinfo(".toto.toto.toto")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo(`www.${"x".repeat(100)}.com`)).toThrow("ENOENT");
    });

    it("rejects the reserved invalid zone without rejecting unqualified names", () => {
      const backend = new FetchNetworkBackend();
      expect(backend.getaddrinfo("dummy-host-name").length).toBe(4);
      expect(() => backend.getaddrinfo("totes.invalid")).toThrow("ENOENT");
    });

    it("allows explicitly aliased unqualified names", () => {
      const backend = new FetchNetworkBackend({
        hostAliases: { registry: "registry.npmjs.org" },
      });
      expect(backend.getaddrinfo("registry").length).toBe(4);
    });
  });

  describe("connect", () => {
    it("succeeds for port 80", () => {
      const backend = new FetchNetworkBackend();
      expect(() => {
        backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      }).not.toThrow();
    });

    it("succeeds for port 443 (uses https:// scheme for fetch)", () => {
      const backend = new FetchNetworkBackend();
      expect(() => {
        backend.connect(1, new Uint8Array([93, 184, 216, 34]), 443);
      }).not.toThrow();
    });
  });

  describe("close", () => {
    it("cleans up connection state", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      backend.close(1);
      expect(() => backend.recv(1, 100, 0)).toThrow();
    });
  });

  describe("recv without send", () => {
    it("throws EAGAIN when no fetch has completed", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      expect(() => backend.recv(1, 100, 0)).toThrow(EagainError);
    });
  });

  describe("poll", () => {
    it("reports writable readiness without echoing requested error bits", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      expect(backend.poll(1, 0x0004 | 0x0008)).toBe(0x0004);
    });
  });

  it("honors MSG_PEEK without consuming buffered response bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hello")));
    const backend = new FetchNetworkBackend();
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);
    backend.send(
      1,
      encoder.encode("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"),
      0,
    );

    const first = decoder.decode(await recvWhenReady(backend, 1));
    expect(first).toContain("hello");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("world")));
    backend.send(
      1,
      encoder.encode("GET /2 HTTP/1.1\r\nHost: example.com\r\n\r\n"),
      0,
    );
    await waitForReadable(backend, 1);
    const peeked = decoder.decode(backend.recv(1, 4, MSG_PEEK));
    const consumed = decoder.decode(backend.recv(1, 4, 0));
    expect(peeked).toBe(consumed);
  });

  describe("hostAliases", () => {
    it("rewrites the fetch target while preserving the request port", () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));
      const backend = new FetchNetworkBackend({
        hostAliases: { "guest-host.test": "127.0.0.1" },
      });
      const addr = backend.getaddrinfo("guest-host.test");
      backend.connect(1, addr, 8080);

      const request = new TextEncoder().encode(
        "GET /repo/info/refs HTTP/1.1\r\nHost: guest-host.test:8080\r\n\r\n",
      );
      expect(backend.send(1, request, 0)).toBe(request.length);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/repo/info/refs",
        expect.any(Object),
      );
    });
  });

  it("keeps repeated guest fields for direct Fetch and uses the last Host occurrence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new FetchNetworkBackend();
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    backend.send(1, encoder.encode(
      "GET /ordered HTTP/1.1\r\n" +
      "hOsT: first.example\r\n" +
      "Host: example.com\r\n" +
      "X-Repeat: first\r\n" +
      "x-repeat: second\r\n\r\n",
    ), 0);
    await recvWhenReady(backend, 1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.com/ordered");
    expectAppendCalls(options.headers as Headers, [
      ["X-Repeat", "first"],
      ["x-repeat", "second"],
    ]);
  });

  it("projects only the fallback Fetch after a direct Fetch failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("CORS blocked"))
      .mockResolvedValueOnce(new Response("proxied"));
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new FetchNetworkBackend({
      corsProxy: {
        url: "https://proxy.example/?",
        allowedRequestHeaderNames: ["X-Repeat"],
        allowAnonymousGetHeaderOmission: true,
      },
    });
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    backend.send(1, encoder.encode(
      "GET /fallback HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "X-Repeat: first\r\n" +
      "x-repeat: second\r\n" +
      "X-Blocked: direct-only\r\n\r\n",
    ), 0);
    await recvWhenReady(backend, 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://example.com/fallback");
    expectAppendCalls((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers, [
      ["X-Repeat", "first"],
      ["x-repeat", "second"],
      ["X-Blocked", "direct-only"],
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://proxy.example/?http://example.com/fallback");
    expectAppendCalls((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers, [
      ["X-Repeat", "first"],
      ["x-repeat", "second"],
    ]);
  });
});

describe("TlsNetworkBackend HTTP proxy path", () => {
  describe("getaddrinfo", () => {
    it("returns numeric IPv4 literals without synthesizing a DNS address", () => {
      const backend = new TlsNetworkBackend();
      expect(Array.from(backend.getaddrinfo("2130706433"))).toEqual([127, 0, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.1"))).toEqual([127, 0, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.1.1"))).toEqual([127, 1, 0, 1]);
      expect(Array.from(backend.getaddrinfo("127.0.0.1"))).toEqual([127, 0, 0, 1]);
    });

    it("rejects malformed numeric IPv4 literals", () => {
      const backend = new TlsNetworkBackend();
      expect(() => backend.getaddrinfo("4294967296")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("1..2")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("9999.9999.9999.9999")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo("1.2.3.256")).toThrow("ENOENT");
    });

    it("rejects syntactically invalid DNS names", () => {
      const backend = new TlsNetworkBackend();
      expect(backend.getaddrinfo("example.com.")).toHaveLength(4);
      expect(() => backend.getaddrinfo(".toto.toto.toto")).toThrow("ENOENT");
      expect(() => backend.getaddrinfo(`www.${"x".repeat(100)}.com`)).toThrow("ENOENT");
    });

    it("rejects special-use invalid but permits potentially resolvable unqualified names", () => {
      const backend = new TlsNetworkBackend();
      expect(backend.getaddrinfo("dummy-host-name").length).toBe(4);
      expect(() => backend.getaddrinfo("totes.invalid")).toThrow("ENOENT");
    });

    it("allows explicitly aliased unqualified names", () => {
      const backend = new TlsNetworkBackend({
        dnsAliases: { registry: "https://registry.npmjs.org" },
      });
      expect(backend.getaddrinfo("registry").length).toBe(4);
    });
  });

  it("resets response state for keep-alive HTTP requests", async () => {
    let resolveSecond!: (response: Response) => void;
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("first"))
      .mockReturnValueOnce(secondResponse);
    vi.stubGlobal("fetch", fetchMock);

    const backend = new TlsNetworkBackend();
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    sendGet(backend, 1, "/first");
    const first = decoder.decode(await recvWhenReady(backend, 1));
    expect(first).toContain("first");
    expect(first.toLowerCase()).not.toContain("connection: close");

    sendGet(backend, 1, "/second");
    expect(() => backend.recv(1, 4096, 0)).toThrow(EagainError);

    resolveSecond(new Response("second"));
    expect(decoder.decode(await recvWhenReady(backend, 1))).toContain("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("emits headers for the decoded body actually returned to the guest", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("plain", {
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "connection": "close",
        "content-type": "text/plain",
      },
    })));

    const backend = new TlsNetworkBackend();
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    sendGet(backend, 1, "/encoded");
    const response = decoder.decode(await recvWhenReady(backend, 1));
    expect(response).toContain("plain");
    expect(response.toLowerCase()).toContain("content-length: 5");
    expect(response.toLowerCase()).not.toContain("content-length: 999");
    expect(response.toLowerCase()).not.toContain("content-encoding");
    expect(response.toLowerCase()).not.toContain("connection: close");
  });

  it("routes HTTP fetches through the configured CORS proxy", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("proxied")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const proxyPrefix = "https://kandelo.test/proxy?url=";
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: proxyPrefix,
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
      },
      dnsAliases: {},
    });
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    backend.send(
      1,
      encoder.encode("GET /resource HTTP/1.1\r\nHost: example.com\r\n\r\n"),
      0,
    );
    await recvWhenReady(backend, 1);

    expect(fetchMock).toHaveBeenCalledWith(
      `${proxyPrefix}${encodeURIComponent("http://example.com/resource")}`,
      expect.any(Object),
    );
  });

  it("appends repeated guest fields in order for direct plain HTTP Fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("direct"));
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TlsNetworkBackend();
    backend.connect(1, backend.getaddrinfo("example.com"), 80);

    backend.send(1, encoder.encode(
      "GET /direct HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "X-Repeat: first\r\n" +
      "x-repeat: second\r\n\r\n",
    ), 0);
    await recvWhenReady(backend, 1);

    expectAppendCalls((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers, [
      ["X-Repeat", "first"],
      ["x-repeat", "second"],
    ]);
  });

  it("honors MSG_PEEK without consuming HTTP response bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("peek-body")));
    const backend = new TlsNetworkBackend();
    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 80);

    sendGet(backend, 1, "/peek");
    await recvWhenReady(backend, 1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("second-body")));
    sendGet(backend, 1, "/peek2");
    await recvWhenReady(backend, 1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("third-body")));
    sendGet(backend, 1, "/peek3");
    const peeked = decoder.decode((await recvWhenReady({
      recv: (handle, maxLen) => backend.recv(handle, maxLen, MSG_PEEK),
    }, 1)).subarray(0, 8));
    const consumed = decoder.decode(backend.recv(1, 8, 0));
    expect(peeked).toBe(consumed);
  });

  it("uses configured proxy projection for plain HTTP and deduplicates omission diagnostics", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("proxied")),
    );
    const onCorsProxyDiagnostic = vi.fn();
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: "https://proxy.example/?",
        allowedRequestHeaderNames: ["X-Allowed"],
        allowAnonymousGetHeaderOmission: true,
      },
      onCorsProxyDiagnostic,
    });

    for (const handle of [1, 2]) {
      const addr = backend.getaddrinfo("example.com");
      backend.connect(handle, addr, 80);
      backend.send(handle, encoder.encode(
        "GET /proxy HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        "X-Allowed: one\r\n" +
        "x-allowed: two\r\n" +
        "X-Omit: ignored\r\n\r\n",
      ), 0);
      await recvWhenReady(backend, handle);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/?http://example.com/proxy");
    for (const call of fetchMock.mock.calls) {
      expectAppendCalls((call[1] as RequestInit).headers as Headers, [
        ["X-Allowed", "one"],
        ["x-allowed", "two"],
      ]);
    }
    expect(onCorsProxyDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite npm-looking JSON from an explicitly configured alias", async () => {
    const packument = '{"dist":{"tarball":"https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}}';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(packument, {
      headers: { "content-type": "application/json" },
    })));
    const backend = new TlsNetworkBackend({
      dnsAliases: { registry: "https://registry.npmjs.org" },
    });
    backend.connect(1, backend.getaddrinfo("registry"), 80);
    sendGet(backend, 1, "/pkg", "registry");

    expect(decoder.decode(await recvWhenReady(backend, 1))).toContain(packument);
  });

  it("routes an explicit alias without relying on an npm sentinel hostname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("alias"));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TlsNetworkBackend({
      dnsAliases: { registry: "https://registry.npmjs.org" },
    });
    backend.connect(1, backend.getaddrinfo("registry"), 80);
    sendGet(backend, 1, "/pkg", "registry");
    await recvWhenReady(backend, 1);

    expect(fetchMock.mock.calls[0][0]).toBe("https://registry.npmjs.org/pkg");
  });

  it("does not give an unconfigured proxy.local host an implicit registry alias", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("generic"));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TlsNetworkBackend({ dnsAliases: {} });
    backend.connect(1, backend.getaddrinfo("proxy.local"), 80);
    sendGet(backend, 1, "/generic", "proxy.local");
    await recvWhenReady(backend, 1);

    expect(fetchMock.mock.calls[0][0]).toBe("http://proxy.local/generic");
  });

  it("reports proxy rejection to plain HTTP guests without attempting Fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("must not run"));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: "https://proxy.example/?",
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: false,
      },
    });
    backend.connect(1, backend.getaddrinfo("example.com"), 80);
    backend.send(1, encoder.encode(
      "POST /reject HTTP/1.1\r\nHost: example.com\r\nX-Blocked: value\r\nContent-Length: 0\r\n\r\n",
    ), 0);

    await expect(recvWhenReady(backend, 1)).rejects.toThrow("cannot relay POST request");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TlsNetworkBackend TLS MITM path", () => {
  it("polls and peeks encrypted response bytes before reporting EOF", async () => {
    const body = "mitm-response-body";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, { headers: { "content-type": "text/plain" } }),
      ),
    );

    let tls!: LoopbackMitmTls;
    const backend = new TlsNetworkBackend({
      createTlsConnection: () => (tls = new LoopbackMitmTls()),
    });
    await backend.init();

    const addr = backend.getaddrinfo("example.com");
    backend.connect(1, addr, 443);

    // Stand in for the TLS engine handing the decrypted request to the backend.
    await tls.serverEnd.upstream.writable
      .getWriter()
      .write(encoder.encode("GET /readme HTTP/1.1\r\nHost: example.com\r\n\r\n"));

    await waitForReadable(backend, 1);
    const peeked = backend.recv(1, 8, MSG_PEEK);
    expect(backend.poll(1, 0x0001) & 0x0001).toBe(0x0001);
    const consumed = backend.recv(1, 8, 0);
    expect(peeked).toEqual(consumed);
    const response = decoder.decode(
      new Uint8Array([...consumed, ...await recvWhenReady(backend, 1)]),
    );
    expect(response).toContain("200");
    expect(response).toContain(body);
  });

  it("routes decrypted HTTPS requests through the configured CORS proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("proxied TLS"));
    vi.stubGlobal("fetch", fetchMock);
    const proxyPrefix = "https://kandelo.test/proxy?";
    let tls!: LoopbackMitmTls;
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: proxyPrefix,
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
      },
      createTlsConnection: () => (tls = new LoopbackMitmTls()),
    });
    await backend.init();

    const addr = backend.getaddrinfo("example.com");
    backend.connect(2, addr, 443);
    await tls.serverEnd.upstream.writable
      .getWriter()
      .write(encoder.encode("GET /secure HTTP/1.1\r\nHost: example.com\r\n\r\n"));
    await waitForReadable(backend, 2);

    expect(fetchMock).toHaveBeenCalledWith(
      `${proxyPrefix}https://example.com/secure`,
      expect.any(Object),
    );
  });

  it("appends repeated decrypted fields in order for direct HTTPS Fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("direct TLS"));
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    let tls!: LoopbackMitmTls;
    const backend = new TlsNetworkBackend({
      createTlsConnection: () => (tls = new LoopbackMitmTls()),
    });
    await backend.init();

    backend.connect(3, backend.getaddrinfo("example.com"), 443);
    await tls.serverEnd.upstream.writable.getWriter().write(encoder.encode(
      "GET /direct HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "X-Repeat: first\r\n" +
      "x-repeat: second\r\n\r\n",
    ));
    await waitForReadable(backend, 3);

    expectAppendCalls((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers, [
      ["X-Repeat", "first"],
      ["x-repeat", "second"],
    ]);
  });

  it("projects decrypted HTTPS immediately before proxy dispatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("proxied TLS"));
    installRecordingHeaders();
    vi.stubGlobal("fetch", fetchMock);
    let tls!: LoopbackMitmTls;
    const backend = new TlsNetworkBackend({
      corsProxy: {
        url: "https://proxy.example/?",
        allowedRequestHeaderNames: ["X-Allowed"],
        allowAnonymousGetHeaderOmission: false,
      },
      createTlsConnection: () => (tls = new LoopbackMitmTls()),
    });
    await backend.init();

    backend.connect(3, backend.getaddrinfo("example.com"), 443);
    await tls.serverEnd.upstream.writable.getWriter().write(encoder.encode(
      "GET /secure HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      "X-Allowed: first\r\n" +
      "x-allowed: second\r\n\r\n",
    ));
    await waitForReadable(backend, 3);

    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/?https://example.com/secure");
    expectAppendCalls((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers, [
      ["X-Allowed", "first"],
      ["x-allowed", "second"],
    ]);
  });
});
