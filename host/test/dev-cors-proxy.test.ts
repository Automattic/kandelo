import { describe, expect, it } from "vitest";
import {
  devCorsProxyRequestHeaders,
  devCorsProxyTargetIsRecursive,
} from "../../apps/browser-demos/vite/dev-cors-proxy";

describe("development CORS proxy header boundary", () => {
  it("forwards guest headers but removes browser and proxy credentials", () => {
    const headers = devCorsProxyRequestHeaders({
      accept: "application/vnd.oci.image.index.v1+json",
      authorization: "Bearer guest-token",
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
      "x-guest-probe": "preserved",
      "x-cors-proxy-allowed-request-headers": "authorization",
      cookie: "ambient=session-secret",
      host: "127.0.0.1:5401",
      origin: "http://127.0.0.1:5401",
      referer: "http://127.0.0.1:5401/private/path",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "127.0.0.1",
    });

    expect(headers.get("accept")).toBe(
      "application/vnd.oci.image.index.v1+json",
    );
    expect(headers.get("authorization")).toBe("Bearer guest-token");
    expect(headers.get("content-type")).toBe(
      "application/x-git-upload-pack-request",
    );
    expect(headers.get("git-protocol")).toBe("version=2");
    expect(headers.get("x-guest-probe")).toBe("preserved");
    expect(headers.has("x-cors-proxy-allowed-request-headers")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("host")).toBe(false);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("referer")).toBe(false);
    expect(headers.has("sec-fetch-site")).toBe(false);
    expect(headers.has("x-forwarded-for")).toBe(false);
  });

  it("does not forward Authorization without the explicit proxy opt-in", () => {
    const headers = devCorsProxyRequestHeaders({
      authorization: "Basic ambient-browser-auth",
      accept: "application/json",
    });
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("rejects exact and loopback-alias recursion without blocking another port", () => {
    expect(devCorsProxyTargetIsRecursive(
      new URL("http://127.0.0.1:5401/__kandelo_cors_proxy"),
      "127.0.0.1:5401",
    )).toBe(true);
    expect(devCorsProxyTargetIsRecursive(
      new URL("http://localhost.:5401/__kandelo_cors_proxy"),
      "127.0.0.1:5401",
    )).toBe(true);
    expect(devCorsProxyTargetIsRecursive(
      new URL("http://localhost:8080/upstream"),
      "127.0.0.1:5401",
    )).toBe(false);
    expect(devCorsProxyTargetIsRecursive(
      new URL("https://example.com/"),
      "127.0.0.1:5401",
    )).toBe(false);
  });
});
