import { describe, expect, it, vi } from "vitest";

import {
  BrowserCorsProxy,
  BrowserCorsProxyRequestError,
  ifRangeMatches,
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

  it("keeps a range alias and omits the field when none is configured", () => {
    expect(validate({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["range"],
      allowAnonymousGetHeaderOmission: true,
      rangeRequestHeaderAlias: "X-Cors-Proxy-Range",
    }).rangeRequestHeaderAlias).toBe("X-Cors-Proxy-Range");
    expect("rangeRequestHeaderAlias" in validate()).toBe(false);
  });

  it.each([
    ["an invalid token", "x bad", /field-name token/],
    ["an allowed request header", "X-Cors-Proxy-Range", /must not be an allowed/],
    ["Range itself", "RANGE", /must differ from Range/],
  ])("rejects a range alias that is %s", (_label, alias, message) => {
    expect(() => validateBrowserCorsProxyConfig({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["range", "x-cors-proxy-range"],
      allowAnonymousGetHeaderOmission: true,
      rangeRequestHeaderAlias: alias,
    })).toThrow(message);
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

  it("relays a git-upload-pack POST by dropping only browser-controlled headers", () => {
    const onDiagnostic = vi.fn();
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["accept", "content-type", "git-protocol"],
      allowAnonymousGetHeaderOmission: true,
    }, onDiagnostic).project({
      // The request shape git-remote-http / libcurl produces for the second
      // leg of a smart-HTTP clone. Before this fix the body-bearing POST threw
      // because content-length/user-agent/accept-encoding are not allow-listed.
      method: "POST",
      headers: [
        ["Accept", "application/x-git-upload-pack-result"],
        ["Content-Type", "application/x-git-upload-pack-request"],
        ["git-protocol", "version=2"],
        ["User-Agent", "git/2.47.1"],
        ["Accept-Encoding", "deflate, gzip"],
        ["Content-Length", "179"],
      ],
      bodyPresent: true,
      targetUrl: "https://github.com/Automattic/page-optimize.git/git-upload-pack",
    });

    expect([...headers.entries()]).toEqual([
      ["accept", "application/x-git-upload-pack-result"],
      ["content-type", "application/x-git-upload-pack-request"],
      ["git-protocol", "version=2"],
    ]);
    // Browser-controlled headers are managed by fetch itself, so their omission
    // is not an application-visible loss and raises no diagnostic.
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it("drops browser-controlled headers for any method without requiring anonymous GET omission", () => {
    const headers = proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: false,
    }).project({
      method: "PUT",
      headers: [
        ["Host", "github.com"],
        ["Connection", "keep-alive"],
        ["Transfer-Encoding", "chunked"],
        ["Sec-Fetch-Mode", "cors"],
        ["Proxy-Connection", "keep-alive"],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    });

    expect([...headers.entries()]).toEqual([]);
  });

  it("still fails a body-bearing request carrying an application-owned unsupported header", () => {
    expect(() => proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["content-type"],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "POST",
      headers: [
        ["Content-Type", "application/json"],
        ["Content-Length", "12"],
        ["X-App-Owned", "value"],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    })).toThrow(new BrowserCorsProxyRequestError(
      `Browser CORS proxy ${PROXY_URL} cannot relay POST request to ${TARGET_ORIGIN} with unsupported request headers: x-app-owned`,
    ));
  });

  it("still fails an unsupported credential header even alongside browser-controlled headers", () => {
    expect(() => proxy({
      url: PROXY_URL,
      allowedRequestHeaderNames: ["content-type"],
      allowAnonymousGetHeaderOmission: true,
    }).project({
      method: "POST",
      headers: [
        ["Content-Type", "application/json"],
        ["Content-Length", "12"],
        ["Authorization", "Bearer secret"],
      ],
      bodyPresent: true,
      targetUrl: TARGET_URL,
    })).toThrow(new BrowserCorsProxyRequestError(
      `Browser CORS proxy ${PROXY_URL} cannot relay POST request to ${TARGET_ORIGIN} with unsupported request headers: authorization`,
    ));
  });

  describe("range alias", () => {
    const aliased = (onDiagnostic?: (message: string) => void) =>
      proxy({
        url: PROXY_URL,
        allowedRequestHeaderNames: ["range"],
        allowAnonymousGetHeaderOmission: true,
        rangeRequestHeaderAlias: "x-cors-proxy-range",
      }, onDiagnostic);

    it("sends the forwarded Range value in both fields", () => {
      const headers = aliased().project({
        method: "GET",
        headers: [["Range", "bytes=-22"]],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      });
      expect([...headers.entries()]).toEqual([
        ["range", "bytes=-22"],
        ["x-cors-proxy-range", "bytes=-22"],
      ]);
    });

    it("adds nothing to a request without Range", () => {
      const headers = aliased().project({
        method: "GET",
        headers: [],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      });
      expect([...headers.entries()]).toEqual([]);
    });

    it("never relays a caller's own alias value", () => {
      const diagnostics: string[] = [];
      const headers = aliased((message) => diagnostics.push(message)).project({
        method: "GET",
        headers: [
          ["X-Cors-Proxy-Range", "bytes=0-0"],
          ["Range", "bytes=10-19"],
        ],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      });
      expect(headers.get("x-cors-proxy-range")).toBe("bytes=10-19");
      expect(diagnostics).toEqual([
        `Browser CORS proxy omitted unsupported request headers for ${TARGET_ORIGIN}: x-cors-proxy-range`,
      ]);
    });

    it("does not mirror a Range the profile does not forward", () => {
      const headers = proxy({
        url: PROXY_URL,
        allowedRequestHeaderNames: [],
        allowAnonymousGetHeaderOmission: true,
        rangeRequestHeaderAlias: "x-cors-proxy-range",
      }).project({
        method: "GET",
        headers: [["Range", "bytes=0-9"]],
        bodyPresent: false,
        targetUrl: TARGET_URL,
      });
      expect([...headers.entries()]).toEqual([]);
    });
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

  describe("fetch(): If-Range the proxy cannot carry", () => {
    const ENTITY = "0123456789abcdef";
    interface Sent {
      url: string;
      headers: Headers;
      cache?: RequestCache;
    }

    // An origin that honors Range (via the alias) and reports ETag "v2".
    function origin(sent: Sent[], etag = '"v2"') {
      return async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        sent.push({ url, headers, cache: init.cache });
        const match = /^bytes=(\d+)-(\d+)$/.exec(
          headers.get("x-cors-proxy-range") ?? "",
        );
        if (match === null) {
          return new Response(ENTITY, { status: 200, headers: { ETag: etag } });
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(ENTITY.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${ENTITY.length}`,
            ETag: etag,
          },
        });
      };
    }

    const rangedProxy = (diagnostics: string[] = []) =>
      proxy({
        url: PROXY_URL,
        allowedRequestHeaderNames: ["range"],
        allowAnonymousGetHeaderOmission: true,
        rangeRequestHeaderAlias: "x-cors-proxy-range",
      }, (message) => diagnostics.push(message));

    it("keeps the slice when the 206 carries the If-Range validator", async () => {
      const sent: Sent[] = [];
      const diagnostics: string[] = [];
      const response = await rangedProxy(diagnostics).fetch({
        method: "GET",
        headers: [["Range", "bytes=4-7"], ["If-Range", '"v2"']],
        targetUrl: TARGET_URL,
      }, origin(sent));
      expect(response.status).toBe(206);
      expect(await response.text()).toBe("4567");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(`${PROXY_URL}${TARGET_URL}`);
      expect(sent[0]!.headers.has("if-range")).toBe(false);
      // Honored, not dropped: no omission diagnostic.
      expect(diagnostics).toEqual([]);
    });

    it("fetches the whole representation when the resource changed", async () => {
      const sent: Sent[] = [];
      const response = await rangedProxy().fetch({
        method: "GET",
        headers: [["Range", "bytes=4-7"], ["If-Range", '"v1"']],
        targetUrl: TARGET_URL,
      }, origin(sent));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ENTITY);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.headers.has("range")).toBe(false);
      expect(sent[1]!.headers.has("x-cors-proxy-range")).toBe(false);
    });

    it("drops If-Range without Range, which servers must ignore", async () => {
      const sent: Sent[] = [];
      const response = await rangedProxy().fetch({
        method: "GET",
        headers: [["If-Range", '"v1"']],
        targetUrl: TARGET_URL,
      }, origin(sent));
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.has("if-range")).toBe(false);
    });

    it("keeps aliased requests out of the HTTP cache, and only those", async () => {
      // The HTTP cache may rewrite Range to the bytes it lacks but cannot
      // rewrite the alias, so the proxy would answer a different range.
      const sent: Sent[] = [];
      await rangedProxy().fetch({
        method: "GET",
        headers: [["Range", "bytes=4-7"], ["If-Range", '"v1"']],
        targetUrl: TARGET_URL,
      }, origin(sent));
      await rangedProxy().fetch({
        method: "GET",
        headers: [],
        targetUrl: TARGET_URL,
      }, origin(sent));
      // Stale If-Range: the ranged request is no-store, the whole-entity
      // refetch carries no alias and uses the cache normally.
      expect(sent.map(({ cache }) => cache)).toEqual([
        "no-store",
        undefined,
        undefined,
      ]);
    });

    it("fetches the whole representation for a 416 when the resource changed", async () => {
      const sent: Sent[] = [];
      const answer = async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        sent.push({ url, headers });
        return headers.has("x-cors-proxy-range")
          ? new Response(null, { status: 416, headers: { "Content-Range": "bytes */16" } })
          : new Response(ENTITY, { status: 200, headers: { ETag: '"v2"' } });
      };
      const response = await rangedProxy().fetch({
        method: "GET",
        headers: [["Range", "bytes=4000-"], ["If-Range", '"v1"']],
        targetUrl: TARGET_URL,
      }, answer);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ENTITY);
      expect(sent).toHaveLength(2);
    });

    it("keeps a 416 whose validator still matches", async () => {
      const sent: Sent[] = [];
      const response = await rangedProxy().fetch({
        method: "GET",
        headers: [["Range", "bytes=4000-"], ["If-Range", '"v2"']],
        targetUrl: TARGET_URL,
      }, async (url, init) => {
        sent.push({ url, headers: new Headers(init.headers) });
        return new Response(null, { status: 416, headers: { ETag: '"v2"' } });
      });
      expect(response.status).toBe(416);
      expect(sent).toHaveLength(1);
    });

    it("treats several If-Range fields as a mismatch, like Fetch's joined value", async () => {
      const sent: Sent[] = [];
      const response = await rangedProxy().fetch({
        method: "GET",
        headers: [["Range", "bytes=4-7"], ["If-Range", '"v0"'], ["If-Range", '"v2"']],
        targetUrl: TARGET_URL,
      }, origin(sent));
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(2);
    });

    it.each(["HEAD", "POST"])(
      "does not re-request a %s answer, which If-Range cannot govern",
      async (method) => {
        const sent: Sent[] = [];
        const response = await proxy({
          url: PROXY_URL,
          allowedRequestHeaderNames: ["range"],
          allowAnonymousGetHeaderOmission: false,
          rangeRequestHeaderAlias: "x-cors-proxy-range",
        }).fetch({
          method,
          headers: [["Range", "bytes=4-7"], ["If-Range", '"v1"']],
          ...(method === "POST" ? { body: "x" } : {}),
          targetUrl: TARGET_URL,
        }, origin(sent));
        expect(response.status).toBe(206);
        expect(sent).toHaveLength(1);
      },
    );

    it("judges projection by the body the caller reported, even if dropped", async () => {
      // The TLS backend drops a body sent with GET but still reports it, so
      // an unsupported field fails instead of being silently omitted.
      await expect(
        proxy({
          url: PROXY_URL,
          allowedRequestHeaderNames: [],
          allowAnonymousGetHeaderOmission: true,
        }).fetch({
          method: "GET",
          headers: [["X-Arbitrary", "1"]],
          bodyPresent: true,
          targetUrl: TARGET_URL,
        }, async () => new Response("unexpected")),
      ).rejects.toThrow(/unsupported request headers: x-arbitrary/);
    });

    it("forwards If-Range untouched to a proxy whose profile carries it", async () => {
      const sent: Sent[] = [];
      const response = await proxy({
        url: PROXY_URL,
        allowedRequestHeaderNames: ["range", "if-range"],
        allowAnonymousGetHeaderOmission: false,
      }).fetch({
        method: "GET",
        headers: [["Range", "bytes=4-7"], ["If-Range", '"v1"']],
        targetUrl: TARGET_URL,
      }, async (url, init) => {
        sent.push({ url, headers: new Headers(init.headers) });
        return new Response("4567", {
          status: 206,
          headers: { "Content-Range": "bytes 4-7/16", ETag: '"v2"' },
        });
      });
      // The proxy evaluated the condition itself; nothing is re-requested.
      expect(response.status).toBe(206);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.get("if-range")).toBe('"v1"');
    });
  });
});

describe("ifRangeMatches", () => {
  const date = "Sun, 28 Sep 2026 12:00:10 GMT";
  const modified = "Sun, 28 Sep 2026 12:00:00 GMT";
  it.each<[string, string, Record<string, string>, boolean]>([
    ["an equal strong ETag", '"v1"', { ETag: '"v1"' }, true],
    ["a different ETag", '"v1"', { ETag: '"v2"' }, false],
    ["a weak response ETag", '"v1"', { ETag: 'W/"v1"' }, false],
    ["a weak If-Range", 'W/"v1"', { ETag: 'W/"v1"' }, false],
    ["no ETag", '"v1"', {}, false],
    ["a strong Last-Modified", modified, { "Last-Modified": modified, Date: date }, true],
    ["Last-Modified without Date", modified, { "Last-Modified": modified }, false],
    ["a weak Last-Modified (under 1 s before Date)", modified,
      { "Last-Modified": modified, Date: modified }, false],
    ["a different Last-Modified", modified,
      { "Last-Modified": date, Date: date }, false],
  ])("treats %s as %s", (_label, ifRange, headers, expected) => {
    expect(ifRangeMatches(ifRange, new Headers(headers))).toBe(expected);
  });
});
