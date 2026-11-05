import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxySessionTransport } from "../src/networking/cors-proxy-session";

const origin = "https://proxy.example";
const url = origin + "/cors-proxy?url=https%3A%2F%2Fupstream.example";
function session(n = "1") {
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  return { token: `v1.${n.repeat(32)}.${expiresAt}.${"a".repeat(64)}`, expiresAt };
}
function required() { return new Response("session required", { status: 401, headers: { "X-Kandelo-Proxy-Session": "required" } }); }
afterEach(() => vi.unstubAllGlobals());

describe("CORS proxy quota session transport", () => {
  it("leaves ordinary proxies alone and never uses a caller-selected token", async () => {
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has("X-Kandelo-Proxy-Session")).toBe(false);
      expect(init.referrerPolicy).toBe("strict-origin"); return new Response("asset");
    });
    const fetch = createProxySessionTransport(null);
    expect(await (await fetch(url, { headers: { "X-Kandelo-Proxy-Session": "guest:forged" } }, send)).text()).toBe("asset");
    expect(send).toHaveBeenCalledOnce();
  });

  it("forwards every caller header unchanged and adds only its credential, without touching the caller's headers", async () => {
    const identity = session();
    const caller = new Headers({ Accept: "application/json", "X-Kandelo-Proxy-Session": "guest:forged" });
    caller.append("X-Repeat", "first");
    caller.append("X-Repeat", "second");
    const before = [...caller];
    const forwarded: Array<Array<[string, string]>> = [];
    const send = async (target: string, init: RequestInit) => {
      if (target === origin + "/cors-proxy-session") return Response.json(identity);
      forwarded.push([...new Headers(init.headers)]);
      return new Headers(init.headers).get("X-Kandelo-Proxy-Session") === identity.token ? new Response("ok") : required();
    };
    const fetch = createProxySessionTransport(null);
    expect((await fetch(url, { headers: caller }, send)).status).toBe(200);
    // The first try carries no credential (the forged one is dropped), the
    // retry carries the issued one; every other header is the caller's.
    const others = before.filter(([name]) => name !== "x-kandelo-proxy-session");
    expect(forwarded).toEqual([others, [...others, ["x-kandelo-proxy-session", identity.token]].sort()]);
    expect([...caller]).toEqual(before);
  });

  it("bootstraps only the configured proxy origin, serializes concurrent first use, and replays POST bytes once", async () => {
    const identity = session(); let issued = 0; let upstream = 0;
    vi.stubGlobal("location", new URL("https://kandelo.example/app"));
    const send = async (target: string, init: RequestInit) => {
      if (target === origin + "/cors-proxy-session") {
        issued++; expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
        expect(init.body).toBeUndefined(); return Response.json(identity);
      }
      expect(target).toBe(url); expect(init.method).toBe("POST"); expect(init.body).toEqual(new Uint8Array([0, 1, 255]));
      if (new Headers(init.headers).get("X-Kandelo-Proxy-Session") !== identity.token) return required();
      upstream++; return new Response("ok");
    };
    const fetch = createProxySessionTransport(null);
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(url,
      { method: "POST", body: new Uint8Array([0, 1, 255]) }, send)));
    expect(issued).toBe(1); expect(upstream).toBe(12); expect(responses.every(r => r.status === 200)).toBe(true);
    await fetch(url, { method: "POST", body: new Uint8Array([0, 1, 255]) }, send);
    expect(issued).toBe(1);
  });

  it("shares persisted tokens across browser realms with blocked third-party cookies", async () => {
    vi.stubGlobal("location", new URL("https://kandelo.example/"));
    const entries = new Map<string, unknown>();
    const storage = { read: async (key: string) => entries.get(key),
      write: async (key: string, value: unknown) => { entries.set(key, value); } };
    const identity = session(); let issued = 0;
    const send = async (target: string, init: RequestInit) => {
      if (target.endsWith("/cors-proxy-session")) { issued++; return Response.json(identity); }
      return new Headers(init.headers).get("X-Kandelo-Proxy-Session") === identity.token ? new Response("ok") : required();
    };
    await createProxySessionTransport(storage)(url, { credentials: "omit" }, send);
    await createProxySessionTransport(storage)(url, { credentials: "omit" }, send);
    expect(issued).toBe(1); expect(entries.size).toBe(1);
  });

  it("uses same-origin hosting cookies only for same-origin session issuance", async () => {
    vi.stubGlobal("location", new URL(origin + "/"));
    const identity = session();
    const send = async (target: string, init: RequestInit) => {
      if (target.endsWith("/cors-proxy-session")) { expect(init.credentials).toBe("same-origin"); return Response.json(identity); }
      return new Headers(init.headers).has("X-Kandelo-Proxy-Session") ? new Response("ok") : required();
    };
    expect((await createProxySessionTransport(null)(url, {}, send)).status).toBe(200);
  });

  it("falls back to memory when persistence is blocked and ignores corrupt or expired cache entries", async () => {
    vi.stubGlobal("location", new URL("https://kandelo.example/"));
    for (const storage of [
      { read: async () => { throw new Error("storage disabled"); }, write: async () => { throw new Error("storage disabled"); } },
      { read: async () => "corrupt value", write: async () => { throw new Error("quota exceeded"); } },
      { read: async () => ({ ...session(), expiresAt: 1 }), write: async () => {} },
    ]) {
      let issued = 0;
      const send = async (target: string, init: RequestInit) => {
        if (target.endsWith("/cors-proxy-session")) { issued++; return Response.json(session()); }
        return new Headers(init.headers).has("X-Kandelo-Proxy-Session") ? new Response("ok") : required();
      };
      const fetch = createProxySessionTransport(storage);
      await fetch(url, {}, send); await fetch(url, {}, send); expect(issued).toBe(1);
    }
  });

  it("uses a browser-wide lock and retries bootstrap after a failed first attempt", async () => {
    const lock = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("navigator", { locks: { request: lock } });
    let issued = 0;
    const send = async (target: string, init: RequestInit) => {
      if (target.endsWith("/cors-proxy-session")) {
        if (++issued === 1) throw new Error("temporary outage");
        return Response.json(session());
      }
      return new Headers(init.headers).has("X-Kandelo-Proxy-Session") ? new Response("ok") : required();
    };
    const fetch = createProxySessionTransport(null);
    await expect(fetch(url, {}, send)).rejects.toThrow("temporary outage");
    expect((await fetch(url, {}, send)).status).toBe(200);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it("does not retry ordinary 401s, exhausted budgets or an upstream POST", async () => {
    for (const status of [401, 429, 503]) {
      const send = vi.fn(async () => new Response("error", { status }));
      expect((await createProxySessionTransport(null)(url, { method: "POST", body: "payload" }, send)).status).toBe(status);
      expect(send).toHaveBeenCalledOnce();
    }
  });

  it("fails malformed sessions, failed bootstrap, consumed streams and cancellation visibly", async () => {
    for (const bootstrap of [() => new Response("down", { status: 503 }), () => Response.json({ token: "forged" })]) {
      const send = async (target: string) => target.endsWith("/cors-proxy-session") ? bootstrap() : required();
      await expect(createProxySessionTransport(null)(url, {}, send)).rejects.toThrow(/session/);
    }
    await expect(createProxySessionTransport(null)(url, { body: new ReadableStream() }, async () => required()))
      .rejects.toThrow(/replayable/);
    const abort = new AbortController();
    const send = async (target: string) => {
      if (target.endsWith("/cors-proxy-session")) { abort.abort(); return Response.json(session()); }
      return required();
    };
    await expect(createProxySessionTransport(null)(url, { signal: abort.signal }, send)).rejects.toThrow();
  });

  it("replaces a rejected cached credential once and does not loop if the replacement is refused", async () => {
    const identities = [session(), session("2")]; let issued = 0;
    const send = async (target: string, init: RequestInit) => {
      if (target.endsWith("/cors-proxy-session")) return Response.json(identities[issued++]);
      if (issued === 1 && new Headers(init.headers).get("X-Kandelo-Proxy-Session") === identities[0].token) return new Response("ok");
      return required();
    };
    const fetch = createProxySessionTransport(null);
    expect((await fetch(url, {}, send)).status).toBe(200);
    issued = 1;
    // Mark the first token invalid without letting the fixture accept it.
    const reject = async (target: string) => target.endsWith("/cors-proxy-session")
      ? Response.json(identities[1]) : required();
    expect((await fetch(url, {}, reject)).status).toBe(401);
  });
});
