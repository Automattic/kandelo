import { describe, expect, it, vi } from "vitest";

import {
  CorsProxyRequestPolicy,
  CorsProxyRequestPolicyError,
  validateCorsProxyRequestCapabilities,
  type CorsProxyRequestCapabilities,
} from "../src/networking/cors-proxy-request-policy";

const PROXY_URL = "https://proxy.example/?";
const TARGET_URL = "https://registry.example/packages/widget?version=1";

function validate(
  value: CorsProxyRequestCapabilities = {
    methods: ["GET", "POST"],
    allowedRequestHeaderNames: ["git-protocol"],
    allowAnonymousGetHeaderOmission: true,
  },
) {
  const validated = validateCorsProxyRequestCapabilities(PROXY_URL, value);
  expect(validated).toBeDefined();
  return validated!;
}

function policy(
  value?: CorsProxyRequestCapabilities,
  onDiagnostic?: (message: string) => void,
) {
  return new CorsProxyRequestPolicy(validate(value), onDiagnostic);
}

describe("validateCorsProxyRequestCapabilities", () => {
  it("copies and freezes capability arrays without changing spelling, order, or duplicates", () => {
    const methods = ["get", "GET", "GET"];
    const allowedRequestHeaderNames = [
      "Git-Protocol",
      "x-custom",
      "Git-Protocol",
    ];

    const validated = validate({
      methods,
      allowedRequestHeaderNames,
      allowAnonymousGetHeaderOmission: true,
    });

    expect(validated.methods).toEqual(["get", "GET", "GET"]);
    expect(validated.allowedRequestHeaderNames).toEqual([
      "Git-Protocol",
      "x-custom",
      "Git-Protocol",
    ]);
    expect(validated.methods).not.toBe(methods);
    expect(validated.allowedRequestHeaderNames).not.toBe(
      allowedRequestHeaderNames,
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.methods)).toBe(true);
    expect(Object.isFrozen(validated.allowedRequestHeaderNames)).toBe(true);
  });

  it("does not retain caller-owned mutable arrays", () => {
    const methods = ["GET"];
    const allowedRequestHeaderNames = ["git-protocol"];
    const validated = validate({
      methods,
      allowedRequestHeaderNames,
      allowAnonymousGetHeaderOmission: true,
    });

    methods[0] = "POST";
    methods.push("HEAD");
    allowedRequestHeaderNames[0] = "authorization";
    allowedRequestHeaderNames.push("x-later");

    expect(validated.methods).toEqual(["GET"]);
    expect(validated.allowedRequestHeaderNames).toEqual(["git-protocol"]);
  });

  it.each([
    ["method", ""],
    ["method", "GET POST"],
    ["method", "GET/POST"],
    ["method", "GÉT"],
    ["header", ""],
    ["header", "x custom"],
    ["header", "x:custom"],
    ["header", "x,custom"],
    ["header", "x-☃"],
  ])("rejects an invalid HTTP %s token %j", (kind, token) => {
    const value: CorsProxyRequestCapabilities = {
      methods: kind === "method" ? [token] : ["GET"],
      allowedRequestHeaderNames:
        kind === "header" ? [token] : ["git-protocol"],
      allowAnonymousGetHeaderOmission: true,
    };

    expect(() => validateCorsProxyRequestCapabilities(PROXY_URL, value)).toThrow(
      /invalid HTTP token/,
    );
  });

  it("rejects capabilities when no proxy URL is configured", () => {
    const capabilities: CorsProxyRequestCapabilities = {
      methods: ["GET"],
      allowedRequestHeaderNames: ["accept"],
      allowAnonymousGetHeaderOmission: true,
    };

    expect(() =>
      validateCorsProxyRequestCapabilities(undefined, capabilities),
    ).toThrow(/proxy URL/);
    expect(() => validateCorsProxyRequestCapabilities("", capabilities)).toThrow(
      /proxy URL/,
    );
  });

  it("keeps URL-only proxy configuration backward compatible", () => {
    expect(
      validateCorsProxyRequestCapabilities(PROXY_URL, undefined),
    ).toBeUndefined();
    expect(
      validateCorsProxyRequestCapabilities(undefined, undefined),
    ).toBeUndefined();
  });
});

describe("CorsProxyRequestPolicy", () => {
  it("matches configured header names case-insensitively", () => {
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: ["GiT-PrOtOcOl"],
      allowAnonymousGetHeaderOmission: false,
    }).project({
      method: "GET",
      headers: [["git-protocol", "version=2"]],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect(result.headers.get("git-protocol")).toBe("version=2");
    expect(result.omittedHeaders).toEqual([]);
  });

  it("matches configured methods exactly and case-sensitively", () => {
    const requestPolicy = policy({
      methods: ["get"],
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    });

    expect(() =>
      requestPolicy.project({
        method: "GET",
        headers: [],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      }),
    ).toThrow(CorsProxyRequestPolicyError);

    expect(
      requestPolicy.project({
        method: "get",
        headers: [],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      }).omittedHeaders,
    ).toEqual([]);
  });

  it("retains each value-valid CORS-safelisted header", () => {
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [
        ["Accept", "application/json"],
        ["Accept-Language", "en-US, fr;q=0.8"],
        ["Content-Language", "en-US"],
        ["Content-Type", "text/plain;charset=UTF-8"],
        ["Range", "bytes=0-499"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect([...result.headers.entries()]).toEqual([
      ["accept", "application/json"],
      ["accept-language", "en-US, fr;q=0.8"],
      ["content-language", "en-US"],
      ["content-type", "text/plain;charset=UTF-8"],
      ["range", "bytes=0-499"],
    ]);
    expect(result.omittedHeaders).toEqual([]);
  });

  it("appends repeated configured and safelisted occurrences in same-name order", () => {
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: ["x-repeat"],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [
        ["X-Repeat", "first"],
        ["Accept", "application/json"],
        ["x-repeat", "second"],
        ["accept", "text/plain"],
        ["X-Repeat", "first"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect(result.headers.get("x-repeat")).toBe("first, second, first");
    expect(result.headers.get("accept")).toBe("application/json, text/plain");
  });

  it("keeps individually safelisted occurrences when their values total 1024 bytes", () => {
    const acceptValues = Array.from(
      { length: 7 },
      (_, index) => String(index).repeat(128),
    );
    const contentLanguage = "e".repeat(128);
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [
        ...acceptValues.map((value) => ["Accept", value] as const),
        ["Content-Language", contentLanguage],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect(result.headers.get("accept")).toBe(acceptValues.join(", "));
    expect(result.headers.get("content-language")).toBe(contentLanguage);
    expect(result.omittedHeaders).toEqual([]);
  });

  it("omits every safelist-dependent name when cumulative value size exceeds 1024 bytes", () => {
    const onDiagnostic = vi.fn();
    const result = policy(
      {
        methods: ["GET"],
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
      },
      onDiagnostic,
    ).project({
      method: "GET",
      headers: [
        ...Array.from(
          { length: 7 },
          (_, index) => ["Accept", String(index).repeat(128)] as const,
        ),
        ["Content-Language", "e".repeat(128)],
        ["Range", "bytes=0-0"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect([...result.headers.entries()]).toEqual([]);
    expect(result.omittedHeaders).toEqual([
      "accept",
      "content-language",
      "range",
    ]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "Browser CORS proxy omitted unsupported request headers for https://registry.example: accept, content-language, range",
    );
  });

  it("retains configured occurrences in order after cumulative safelist overflow", () => {
    const acceptValues = Array.from(
      { length: 7 },
      (_, index) => String(index).repeat(128),
    );
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: ["AcCePt"],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [
        ...acceptValues.map((value) => ["Accept", value] as const),
        ["Content-Language", "e".repeat(128)],
        ["Range", "bytes=0-0"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect(result.headers.get("accept")).toBe(acceptValues.join(", "));
    expect(result.headers.has("content-language")).toBe(false);
    expect(result.headers.has("range")).toBe(false);
    expect(result.omittedHeaders).toEqual(["content-language", "range"]);
  });

  it.each([
    ["Accept", "application/json\"unsafe"],
    ["Accept-Language", "en_US"],
    ["Content-Language", "en/US"],
    ["Content-Type", "application/json"],
    ["Content-Type", "text/plain\"unsafe"],
    ["Range", "bytes=0-1,3-4"],
    ["Range", "items=0-1"],
    ["Accept", "a".repeat(129)],
  ])("does not safelist a value-invalid %s occurrence", (name, value) => {
    const result = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "GET",
      headers: [[name, value]],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect(result.headers.has(name)).toBe(false);
    expect(result.omittedHeaders).toEqual([name.toLowerCase()]);
  });

  it("strips fixed and Connection-nominated outer transport headers", () => {
    const requestPolicy = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: [
        "host",
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-hop-one",
        "x-hop-two",
        "x-end-to-end",
      ],
      allowAnonymousGetHeaderOmission: false,
    });

    const result = requestPolicy.project({
      method: "GET",
      headers: [
        ["Host", "registry.example"],
        ["Connection", "x-hop-one, X-Hop-Two"],
        ["Connection", "keep-alive"],
        ["Content-Length", "0"],
        ["Keep-Alive", "timeout=5"],
        ["Proxy-Authenticate", "Basic"],
        ["TE", "trailers"],
        ["Trailer", "Digest"],
        ["Transfer-Encoding", "chunked"],
        ["Upgrade", "websocket"],
        ["X-Hop-One", "one"],
        ["x-hop-two", "two"],
        ["X-End-To-End", "kept"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect([...result.headers.entries()]).toEqual([
      ["x-end-to-end", "kept"],
    ]);
    expect(result.omittedHeaders).toEqual([]);
  });

  it.each([
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "x-cors-proxy-allowed-request-headers",
    "x-cors-proxy-content-type",
  ])(
    "strips Connection-nominated reserved header %s before classification",
    (name) => {
      const onDiagnostic = vi.fn();
      const result = policy(
        {
          methods: ["GET"],
          allowedRequestHeaderNames: [name],
          allowAnonymousGetHeaderOmission: true,
        },
        onDiagnostic,
      ).project({
        method: "GET",
        headers: [
          ["Connection", name.toUpperCase()],
          [name, "secret"],
        ],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      });

      expect([...result.headers.entries()]).toEqual([]);
      expect(result.omittedHeaders).toEqual([]);
      expect(onDiagnostic).not.toHaveBeenCalled();
    },
  );

  it.each([
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "x-cors-proxy-allowed-request-headers",
    "x-cors-proxy-content-type",
  ])("rejects reserved credential or proxy-control header %s", (name) => {
    const requestPolicy = policy({
      methods: ["GET"],
      allowedRequestHeaderNames: [name],
      allowAnonymousGetHeaderOmission: true,
    });

    expect(() =>
      requestPolicy.project({
        method: "GET",
        headers: [[name.toUpperCase(), "secret"]],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      }),
    ).toThrowError(
      new CorsProxyRequestPolicyError(
        `Browser CORS proxy cannot represent GET request for https://registry.example: unsupported request headers: ${name}`,
      ),
    );
  });

  it("omits unsupported headers only from anonymous bodyless GETs and sorts their names", () => {
    const onDiagnostic = vi.fn();
    const result = policy(undefined, onDiagnostic).project({
      method: "GET",
      headers: [
        ["X-Zeta", "last"],
        ["Accept", "application/json"],
        ["x-alpha", "first"],
        ["X-Zeta", "again"],
      ],
      bodyPresent: false,
      targetUrl: TARGET_URL,
    });

    expect([...result.headers.entries()]).toEqual([
      ["accept", "application/json"],
    ]);
    expect(result.omittedHeaders).toEqual(["x-alpha", "x-zeta"]);
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(
      "Browser CORS proxy omitted unsupported request headers for https://registry.example: x-alpha, x-zeta",
    );
  });

  it.each([
    { method: "GET", methods: ["GET"] },
    { method: "POST", methods: ["POST"] },
    { method: "PUT", methods: ["PUT"] },
  ])(
    "rejects unsupported headers on body-bearing $method when the method is supported",
    ({ method, methods }) => {
      const headerName = "x-client-trace";
      const requestPolicy = policy({
        methods,
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
      });

      expect(() =>
        requestPolicy.project({
          method,
          headers: [[headerName, "opaque"]],
          bodyPresent: true,
          targetUrl: TARGET_URL,
        }),
      ).toThrowError(
        new CorsProxyRequestPolicyError(
          `Browser CORS proxy cannot represent ${method} request for https://registry.example: unsupported request headers: ${headerName}`,
        ),
      );
    },
  );

  it("rejects a body-bearing GET even when all headers are representable", () => {
    expect(() =>
      policy().project({
        method: "GET",
        headers: [["Accept", "application/json"]],
        bodyPresent: true,
        targetUrl: TARGET_URL,
      }),
    ).toThrowError(
      new CorsProxyRequestPolicyError(
        "Browser CORS proxy cannot represent GET request with a body for https://registry.example",
      ),
    );
  });

  it.each(["PUT", "HEAD"])(
    "rejects unsupported proxy method %s without substituting it",
    (method) => {
      expect(() =>
        policy().project({
          method,
          headers: [],
          bodyPresent: false,
          targetUrl: TARGET_URL,
        }),
      ).toThrowError(
        new CorsProxyRequestPolicyError(
          `Browser CORS proxy cannot represent ${method} request for https://registry.example: unsupported method ${method}`,
        ),
      );
    },
  );

  it("does not use the target hostname or an unsupported header prefix as policy input", () => {
    const requestPolicy = policy();
    const project = (targetUrl: string, name: string) =>
      requestPolicy.project({
        method: "GET",
        headers: [[name, "metadata"]],
        bodyPresent: false,
        targetUrl,
      });

    expect(project(TARGET_URL, "x-metadata-one").omittedHeaders).toEqual([
      "x-metadata-one",
    ]);
    expect(
      project("https://unrelated.example/resource", "x-metadata-two")
        .omittedHeaders,
    ).toEqual(["x-metadata-two"]);
  });

  it("emits one diagnostic per target origin and sorted omitted-header set", () => {
    const onDiagnostic = vi.fn();
    const requestPolicy = policy(undefined, onDiagnostic);
    const project = (
      targetUrl: string,
      headers: readonly (readonly [string, string])[],
    ) =>
      requestPolicy.project({
        method: "GET",
        headers,
        bodyPresent: false,
        targetUrl,
      });

    project(TARGET_URL, [
      ["X-Zeta", "1"],
      ["x-alpha", "2"],
    ]);
    project("https://registry.example/another-path", [
      ["X-ALPHA", "3"],
      ["x-zeta", "4"],
      ["x-alpha", "5"],
    ]);
    project(TARGET_URL, [["x-beta", "1"]]);
    project("https://other.example/item", [
      ["x-zeta", "1"],
      ["x-alpha", "2"],
    ]);

    expect(onDiagnostic.mock.calls).toEqual([
      [
        "Browser CORS proxy omitted unsupported request headers for https://registry.example: x-alpha, x-zeta",
      ],
      [
        "Browser CORS proxy omitted unsupported request headers for https://registry.example: x-beta",
      ],
      [
        "Browser CORS proxy omitted unsupported request headers for https://other.example: x-alpha, x-zeta",
      ],
    ]);
  });
});
