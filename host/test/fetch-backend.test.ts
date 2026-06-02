import { afterEach, describe, it, expect, vi } from "vitest";
import { FetchNetworkBackend, EagainError } from "../src/networking/fetch-backend";

describe("FetchNetworkBackend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe("poll", () => {
    it("reports writable readiness without echoing requested error bits", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      expect(backend.poll(1, 0x0004 | 0x0008)).toBe(0x0004);
    });
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
});
