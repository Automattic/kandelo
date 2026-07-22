import { describe, expect, it } from "vitest";
import {
  CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER,
  applyCorsProxyRequestPolicy,
  corsProxyFetchUrl,
  normalizeCorsProxyUrl,
} from "../src/networking/cors-proxy";
import {
  DEFAULT_CORS_PROXY_URL,
  resolveBrowserCorsProxyUrl,
} from "../../apps/browser-demos/lib/cors-proxy-config";

describe("CORS proxy configuration", () => {
  it("keeps proxying disabled for absent or blank configuration", () => {
    expect(normalizeCorsProxyUrl(undefined)).toBeUndefined();
    expect(normalizeCorsProxyUrl("   ")).toBeUndefined();
  });

  it("preserves reviewed HTTP(S) prefixes exactly", () => {
    expect(normalizeCorsProxyUrl(" https://proxy.example/? ")).toBe(
      "https://proxy.example/?",
    );
    expect(normalizeCorsProxyUrl("http://127.0.0.1:5401/proxy?url=")).toBe(
      "http://127.0.0.1:5401/proxy?url=",
    );
  });

  it.each([
    ["relative URL", "/proxy?url="],
    ["protocol-relative URL", "//proxy.example/?"],
    ["malformed URL", "not a URL"],
    ["script URL", "javascript:alert(1)"],
    ["file URL", "file:///tmp/proxy"],
    ["insecure remote URL", "http://proxy.example/?"],
    ["embedded credentials", "https://user:secret@proxy.example/?"],
    ["fragment", "https://proxy.example/?#hidden"],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeCorsProxyUrl(value)).toThrow(/corsProxyUrl/);
  });

  it("supports the proxy's raw-target and encoded-target URL forms", () => {
    const target = "https://example.com/repo/info/refs?service=git-upload-pack";
    expect(corsProxyFetchUrl("https://proxy.example/?", target)).toBe(
      `https://proxy.example/?${target}`,
    );
    expect(corsProxyFetchUrl("https://proxy.example/?url=", target)).toBe(
      `https://proxy.example/?url=${encodeURIComponent(target)}`,
    );
  });

  it("derives the Authorization opt-in instead of trusting guest policy", () => {
    const headers = new Headers({
      Authorization: "Bearer guest-token",
      [CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER]: "cookie, proxy-authorization",
    });
    applyCorsProxyRequestPolicy(headers, true);
    expect(headers.get(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER)).toBe(
      "authorization",
    );

    headers.delete("authorization");
    headers.set(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER, "authorization");
    applyCorsProxyRequestPolicy(headers, true);
    expect(headers.has(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER)).toBe(false);
  });

  it("does not add proxy control headers when proxying is disabled", () => {
    const headers = new Headers({ Authorization: "Bearer direct" });
    applyCorsProxyRequestPolicy(headers, false);
    expect(headers.has(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER)).toBe(false);
  });
});

describe("browser demo CORS proxy selection", () => {
  it("uses the same-origin relay in development", () => {
    expect(resolveBrowserCorsProxyUrl({
      baseUrl: "/kandelo/",
      isDev: true,
      locationHref: "http://127.0.0.1:5401/kandelo/",
    })).toBe(
      "http://127.0.0.1:5401/kandelo/__kandelo_cors_proxy?url=",
    );
  });

  it("uses the public default in production and honors an explicit override", () => {
    expect(resolveBrowserCorsProxyUrl({
      baseUrl: "/kandelo/",
      isDev: false,
      locationHref: "https://automattic.github.io/kandelo/",
    })).toBe(DEFAULT_CORS_PROXY_URL);
    expect(resolveBrowserCorsProxyUrl({
      baseUrl: "/kandelo/",
      configuredUrl: "https://proxy.example/?url=",
      isDev: false,
      locationHref: "https://automattic.github.io/kandelo/",
    })).toBe("https://proxy.example/?url=");
  });

  it.each([
    ["relative override", "/proxy?url="],
    ["insecure remote override", "http://proxy.example/?"],
    ["credential-bearing override", "https://user:secret@proxy.example/?"],
  ])("rejects a %s before selecting the app proxy", (_label, configuredUrl) => {
    expect(() => resolveBrowserCorsProxyUrl({
      baseUrl: "/kandelo/",
      configuredUrl,
      isDev: false,
      locationHref: "https://automattic.github.io/kandelo/",
    })).toThrow(/corsProxyUrl/);
  });
});
