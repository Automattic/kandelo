import { describe, expect, it, vi } from "vitest";

import {
  BrowserCorsProxy,
  BrowserCorsProxyRequestError,
  validateBrowserCorsProxyConfig,
  type BrowserCorsProxyConfig,
} from "../src/networking/browser-cors-proxy";

const PROXY_URL = "https://proxy.example/?";
const TARGET_URL = "https://registry.example/packages/widget?version=1";
const TARGET_ORIGIN = "https://registry.example";

function validate(
  value: BrowserCorsProxyConfig = {
    url: PROXY_URL,
    allowedRequestHeaderNames: ["git-protocol"],
    allowAnonymousGetHeaderOmission: true,
  },
): BrowserCorsProxyConfig {
  const config = validateBrowserCorsProxyConfig(value);
  expect(config).toBeDefined();
  return config!;
}

function proxy(
  value?: BrowserCorsProxyConfig,
  onDiagnostic?: (message: string) => void,
): BrowserCorsProxy {
  return new BrowserCorsProxy(validate(value), onDiagnostic);
}

describe("validateBrowserCorsProxyConfig", () => {
  it("copies and freezes configuration without changing URL or allowed-name spelling, order, or duplicates", () => {
    const allowedRequestHeaderNames = [
      "Git-Protocol",
      "x-custom",
      "Git-Protocol",
    ];
    const config = validate({
      url: PROXY_URL,
      allowedRequestHeaderNames,
      allowAnonymousGetHeaderOmission: true,
    });

    expect(config).toEqual({
      url: PROXY_URL,
      allowedRequestHeaderNames: [
        "Git-Protocol",
        "x-custom",
        "Git-Protocol",
      ],
      allowAnonymousGetHeaderOmission: true,
    });
    expect(config.allowedRequestHeaderNames).not.toBe(allowedRequestHeaderNames);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedRequestHeaderNames)).toBe(true);

    allowedRequestHeaderNames[0] = "authorization";
    allowedRequestHeaderNames.push("x-later");
    expect(config.allowedRequestHeaderNames).toEqual([
      "Git-Protocol",
      "x-custom",
      "Git-Protocol",
    ]);
  });

  it.each([
    ["", /URL/],
    ["   ", /URL/],
    ["file:///tmp/cors-proxy", /HTTP\(S\)/],
    ["mailto:proxy@example.test", /HTTP\(S\)/],
  ])("rejects empty or non-HTTP(S) proxy URL %j", (url, message) => {
    expect(() => validateBrowserCorsProxyConfig({
      url,
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    })).toThrow(message);
  });

  it.each(["", "x bad", "x:bad", "x,bad", "x-☃"])(
    "rejects invalid HTTP field-name token %j",
    (name) => {
      expect(() => validateBrowserCorsProxyConfig({
        url: PROXY_URL,
        allowedRequestHeaderNames: [name],
        allowAnonymousGetHeaderOmission: true,
      })).toThrow(/invalid HTTP field-name token/);
    },
  );

  it("retains an absent configuration", () => {
    expect(validateBrowserCorsProxyConfig(undefined)).toBeUndefined();
  });
});

describe("BrowserCorsProxy", () => {
  it("creates fetch URLs through the configured proxy prefix", () => {
    expect(proxy().urlFor(TARGET_URL)).toBe(`${PROXY_URL}${TARGET_URL}`);
  });

  it("accepts configured names using ASCII case-insensitive comparison without interpreting values", () => {
    const largeValue = "x".repeat(1025);
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["Content-Type", "Range", "Accept"],
      allowAnonymousGetHeaderOmission: false,
    }).project({
      method: "POST",
      headers: [
        ["content-type", "application/json; charset=utf-8"],
        ["CONTENT-TYPE", "multipart/form-data; boundary=example"],
        ["range", "bytes=0-9, 20-29"],
        ["ACCEPT", "application/json\u00a0with non-ASCII whitespace"],
        ["accept", "control-like\u0001text"],
        ["Accept", largeValue],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    });

    expect(headers.get("content-type")).toBe(
      "application/json; charset=utf-8, multipart/form-data; boundary=example",
    );
    expect(headers.get("range")).toBe("bytes=0-9, 20-29");
    expect(headers.get("accept")).toBe(
      `application/json\u00a0with non-ASCII whitespace, control-like\u0001text, ${largeValue}`,
    );
  });

  it("treats otherwise CORS-safelisted values as unsupported when their names are absent", () => {
    const onDiagnostic = vi.fn();
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    }, onDiagnostic).project({
      method: "GET",
      headers: [
        ["Accept", "application/json"],
        ["Content-Type", "text/plain;charset=UTF-8"],
        ["Range", "bytes=0-499"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect([...headers.entries()]).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "Browser CORS proxy omitted unsupported request headers for https://registry.example: accept, content-type, range",
    );
  });

  it("appends every repeated allowed occurrence in original occurrence order", () => {
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["X-Repeat"],
      allowAnonymousGetHeaderOmission: false,
    }).project({
      method: "PATCH",
      headers: [
        ["x-repeat", "first"],
        ["X-Repeat", "second"],
        ["x-repeat", "first"],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    });

    expect(headers.get("x-repeat")).toBe("first, second, first");
  });

  it("omits unsupported names only for anonymous bodyless GET requests and diagnoses each origin/name set once", () => {
    const onDiagnostic = vi.fn();
    const browserProxy = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["x-allowed"],
      allowAnonymousGetHeaderOmission: true,
    }, onDiagnostic);
    const input = {
      method: "GET",
      headers: [
        ["X-Allowed", "kept"],
        ["X-Zebra", "one"],
        ["x-alpha", "two"],
        ["X-Zebra", "three"],
      ] as const,
      bodyPresent: false,
      targetUrl: TARGET_URL,
    };

    expect(browserProxy.project(input).get("x-allowed")).toBe("kept");
    expect(browserProxy.project(input).get("x-allowed")).toBe("kept");
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "Browser CORS proxy omitted unsupported request headers for https://registry.example: x-alpha, x-zebra",
    );

    browserProxy.project({ ...input, targetUrl: "https://other.example/path" });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenLastCalledWith(
      "Browser CORS proxy omitted unsupported request headers for https://other.example: x-alpha, x-zebra",
    );
  });

  it.each(["Authorization", "Cookie", "Cookie2", "Proxy-Authorization"])(
    "does not anonymously omit unsupported credential header %s",
    (name) => {
      expect(() => proxy({
        url: PROXY_URL,
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
      }).project({
        method: "GET",
        headers: [[name, "secret"]],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      })).toThrow(new BrowserCorsProxyRequestError(
        `Browser CORS proxy ${PROXY_URL} cannot relay GET request to ${TARGET_ORIGIN} with unsupported request headers: ${name.toLowerCase()}`,
      ));
    },
  );

  it("does not anonymously omit another unsupported header when an allowed credential header is present", () => {
    expect(() => proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["authorization"],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [
        ["Authorization", "Bearer opaque"],
        ["X-Unsupported", "value"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    })).toThrow(new BrowserCorsProxyRequestError(
      `Browser CORS proxy ${PROXY_URL} cannot relay GET request to ${TARGET_ORIGIN} with unsupported request headers: x-unsupported`,
    ));
  });

  it.each([
    ["GET", true],
    ["POST", false],
  ])("fails unsupported names outside anonymous bodyless GET requests", (method, bodyPresent) => {
    expect(() => proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method,
      headers: [["X-Unsupported", "value"]],
      bodyPresent,
      targetUrl: TARGET_URL,
    })).toThrow(new BrowserCorsProxyRequestError(
      `Browser CORS proxy ${PROXY_URL} cannot relay ${method} request to ${TARGET_ORIGIN} with unsupported request headers: x-unsupported`,
    ));
  });

  it("passes allowed-only body-bearing and state-changing requests without judging header or method meaning", () => {
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["authorization", "content-type"],
      allowAnonymousGetHeaderOmission: false,
    }).project({
      method: "PATCH",
      headers: [
        ["Authorization", "Bearer opaque"],
        ["Content-Type", "application/json"],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    });

    expect([...headers.entries()]).toEqual([
      ["authorization", "Bearer opaque"],
      ["content-type", "application/json"],
    ]);
  });
});
