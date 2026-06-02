import { afterEach, describe, it, expect, vi } from "vitest";
import { FetchNetworkBackend, EagainError } from "../src/networking/fetch-backend";
import { TlsNetworkBackend } from "../src/networking/tls-network-backend";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sendGet(
  backend: Pick<TlsNetworkBackend, "send">,
  handle: number,
  path: string,
) {
  backend.send(
    handle,
    encoder.encode(
      `GET ${path} HTTP/1.1\r\n` +
      "Host: proxy.local\r\n" +
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

describe("FetchNetworkBackend", () => {
  describe("getaddrinfo", () => {
    it("returns a 4-byte address for any hostname", () => {
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
});

describe("TlsNetworkBackend HTTP proxy path", () => {
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
    const addr = backend.getaddrinfo("proxy.local");
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
    const addr = backend.getaddrinfo("proxy.local");
    backend.connect(1, addr, 80);

    sendGet(backend, 1, "/encoded");
    const response = decoder.decode(await recvWhenReady(backend, 1));
    expect(response).toContain("plain");
    expect(response.toLowerCase()).toContain("content-length: 5");
    expect(response.toLowerCase()).not.toContain("content-length: 999");
    expect(response.toLowerCase()).not.toContain("content-encoding");
    expect(response.toLowerCase()).not.toContain("connection: close");
  });
});
