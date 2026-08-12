import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_CORS_PROXY_CONFIG,
  resolveBrowserCorsProxyConfig,
} from "../../apps/browser-demos/lib/browser-cors-proxy";

const PAGE_URL = "https://example.test/kandelo/";

describe("browser demo CORS proxy configuration", () => {
  it("declares one deeply immutable production proxy capability profile", () => {
    expect(DEFAULT_BROWSER_CORS_PROXY_CONFIG).toEqual({
      url: "https://wordpress-playground-cors-proxy.net/?",
      allowedRequestHeaderNames: [
        "accept",
        "content-type",
        "git-protocol",
        "wp_blog",
        "wp_install",
      ],
      allowAnonymousGetHeaderOmission: true,
    });
    expect(Object.isFrozen(DEFAULT_BROWSER_CORS_PROXY_CONFIG)).toBe(true);
    expect(Object.isFrozen(
      DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
    )).toBe(true);
    const lowerNames = DEFAULT_BROWSER_CORS_PROXY_CONFIG
      .allowedRequestHeaderNames.map((name) => name.toLowerCase());
    expect(lowerNames).not.toContain("authorization");
    expect(lowerNames).not.toContain("x-cors-proxy-allowed-request-headers");
    expect(lowerNames).not.toContain("x-cors-proxy-content-type");
  });

  it("changes only the URL for an explicit deployment proxy", () => {
    expect(resolveBrowserCorsProxyConfig({
      configuredUrl: "  /artifact-proxy?url=  ",
      development: false,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    })).toEqual({
      ...DEFAULT_BROWSER_CORS_PROXY_CONFIG,
      url: "https://example.test/artifact-proxy?url=",
    });
  });

  it("changes only the URL for Vite's same-origin development route", () => {
    expect(resolveBrowserCorsProxyConfig({
      development: true,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    })).toEqual({
      ...DEFAULT_BROWSER_CORS_PROXY_CONFIG,
      url: "https://example.test/kandelo/__kandelo_cors_proxy?url=",
    });
  });

  it("returns an immutable copy of the production profile", () => {
    const resolved = resolveBrowserCorsProxyConfig({
      development: false,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    });
    expect(resolved).toEqual(DEFAULT_BROWSER_CORS_PROXY_CONFIG);
    expect(resolved).not.toBe(DEFAULT_BROWSER_CORS_PROXY_CONFIG);
    expect(resolved.allowedRequestHeaderNames).not.toBe(
      DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
    );
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.allowedRequestHeaderNames)).toBe(true);
  });
});
