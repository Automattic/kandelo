import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_CORS_PROXY_URL,
  resolveBrowserCorsProxyUrl,
} from "../../apps/browser-demos/lib/browser-cors-proxy";

const PAGE_URL = "https://example.test/kandelo/";

describe("browser demo CORS proxy configuration", () => {
  it("uses and normalizes an explicit deployment proxy", () => {
    expect(resolveBrowserCorsProxyUrl({
      configuredUrl: "  /artifact-proxy?url=  ",
      development: false,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    })).toBe("https://example.test/artifact-proxy?url=");
  });

  it("uses Vite's same-origin route during local development", () => {
    expect(resolveBrowserCorsProxyUrl({
      development: true,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    })).toBe(
      "https://example.test/kandelo/__kandelo_cors_proxy?url=",
    );
  });

  it("uses the service worker's public default for production builds", () => {
    expect(resolveBrowserCorsProxyUrl({
      development: false,
      baseUrl: "/kandelo/",
      pageUrl: PAGE_URL,
    })).toBe(DEFAULT_BROWSER_CORS_PROXY_URL);
  });
});
