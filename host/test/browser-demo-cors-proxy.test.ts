import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_CORS_PROXY_CONFIG,
  resolveBrowserCorsProxyConfig,
} from "../../apps/browser-demos/lib/browser-cors-proxy";
import {
  BrowserCorsProxy,
  BrowserCorsProxyRequestError,
  type HttpHeaderOccurrence,
} from "../src/networking/browser-cors-proxy";
import {
  CODEX_OBSERVED_REQUESTS,
  CODEX_SOURCE_ONLY_REQUEST_FIELDS,
  type CodexObservedRequest,
} from "./fixtures/codex-observed-requests";

const PAGE_URL = "https://example.test/kandelo/";

describe("browser demo CORS proxy configuration", () => {
  it("declares one deeply immutable production proxy capability profile", () => {
    expect(DEFAULT_BROWSER_CORS_PROXY_CONFIG).toEqual({
      url: "https://wordpress-playground-cors-proxy.net/?",
      allowedRequestHeaderNames: [
        "accept",
        "content-encoding",
        "content-type",
        "git-protocol",
        "oai-product-sku",
        "openai-beta",
        "originator",
        "range",
        "session-id",
        "thread-id",
        "version",
        "wp_blog",
        "wp_install",
        "x-client-request-id",
        "x-codex-beta-features",
        "x-codex-parent-thread-id",
        "x-codex-routing-hint",
        "x-codex-turn-metadata",
        "x-codex-turn-state",
        "x-codex-window-id",
        "x-openai-account-routing-override",
        "x-openai-fedramp",
        "x-openai-internal-codex-responses-lite",
        "x-openai-product-sku",
        "x-openai-subagent",
      ],
      allowAnonymousGetHeaderOmission: true,
      rangeRequestHeaderAlias: "x-cors-proxy-range",
    });
    expect(Object.isFrozen(DEFAULT_BROWSER_CORS_PROXY_CONFIG)).toBe(true);
    expect(Object.isFrozen(
      DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
    )).toBe(true);
    const lowerNames = DEFAULT_BROWSER_CORS_PROXY_CONFIG
      .allowedRequestHeaderNames.map((name) => name.toLowerCase());
    expect(lowerNames).not.toContain("authorization");
    // Grant-only credentials: BrowserCorsProxy relays them only for a
    // process that holds a credential grant for the target origin.
    expect(lowerNames).not.toContain("chatgpt-account-id");
    expect(lowerNames).not.toContain("x-kandelo-credential-grant");
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

describe("the production profile and signed-in Codex's requests", () => {
  const GRANT = { token: "synthetic-grant-token" };

  // What the TLS backend hands projection: everything the guest wrote except
  // Host and Connection, which name the guest's own connection.
  function project(
    request: CodexObservedRequest,
    grant?: { token: string },
    extra: ReadonlyArray<readonly [string, string]> = [],
  ): Headers {
    const headers: HttpHeaderOccurrence[] = [...request.headers, ...extra]
      .filter(([name]) => !["host", "connection"].includes(name.toLowerCase()))
      .map(([name, value]) => [name, value]);
    return new BrowserCorsProxy(DEFAULT_BROWSER_CORS_PROXY_CONFIG).project({
      method: request.method,
      headers,
      bodyPresent: request.method === "POST",
      targetUrl: request.url,
      grant,
    });
  }

  it("relays a granted model turn with exactly the fields Codex sends", () => {
    const sent = project(CODEX_OBSERVED_REQUESTS.responses, GRANT);
    expect([...sent.keys()].sort()).toEqual([
      "accept",
      "authorization",
      "chatgpt-account-id",
      "content-encoding",
      "content-type",
      "originator",
      "session-id",
      "thread-id",
      "version",
      "x-client-request-id",
      "x-codex-beta-features",
      "x-codex-routing-hint",
      "x-codex-turn-metadata",
      "x-codex-turn-state",
      "x-codex-window-id",
      "x-cors-proxy-allowed-request-headers",
      "x-kandelo-credential-grant",
    ]);
    // The body stays compressed, so its encoding goes with it unchanged.
    expect(sent.get("content-encoding")).toBe("zstd");
    expect(sent.get("x-kandelo-credential-grant")).toBe(GRANT.token);
  });

  it("relays the same turn for account classes and sub-agents the probe did not reach", () => {
    const sent = project(
      CODEX_OBSERVED_REQUESTS.responses,
      GRANT,
      CODEX_SOURCE_ONLY_REQUEST_FIELDS,
    );
    for (const [name, value] of CODEX_SOURCE_ONLY_REQUEST_FIELDS) {
      expect(sent.get(name)).toBe(value);
    }
  });

  it("refuses the same turn without a grant, naming only its credentials", () => {
    expect(() => project(CODEX_OBSERVED_REQUESTS.responses)).toThrow(
      /unsupported request headers: authorization, chatgpt-account-id$/,
    );
  });

  it.each([
    "responsesLite",
    "models",
    "analyticsEvents",
    "installedPlugins",
    "mcpInitialize",
    "tokenRefresh",
  ] as const)("relays Codex's granted %s request", (name) => {
    expect(() => project(CODEX_OBSERVED_REQUESTS[name], GRANT)).not.toThrow();
  });

  it("refuses Codex's settings call, which a turn does not need, naming Cache-Control", () => {
    // Relaying Cache-Control would make anonymous GETs that carry it fail
    // the Playground proxy's preflight instead of omitting the field.
    expect(() => project(CODEX_OBSERVED_REQUESTS.userSettings, GRANT)).toThrow(
      /unsupported request headers: cache-control$/,
    );
  });

  it("refuses the WebSocket handshake, which the HTTP(S) bridge cannot carry", () => {
    for (const grant of [GRANT, undefined]) {
      let failure: unknown;
      try {
        project(CODEX_OBSERVED_REQUESTS.websocketHandshake, grant);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BrowserCorsProxyRequestError);
      expect((failure as Error).message).toContain("WebSocket");
    }
  });

  it("no longer relays fields Codex 0.163.0 does not send", () => {
    const names = DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames;
    // 0.163.0 sends session-id; x-codex-installation-id is a body field.
    expect(names).not.toContain("session_id");
    expect(names).not.toContain("x-codex-installation-id");
    // Telemetry and internal/desktop paths, never needed by the CLI.
    expect(names).not.toContain("statsig-api-key");
    expect(names).not.toContain("x-oai-attestation");
    // Kept out so anonymous GETs carrying it can still omit it.
    expect(names).not.toContain("cache-control");
  });
});
