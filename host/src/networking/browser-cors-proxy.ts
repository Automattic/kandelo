import { corsProxyFetchUrl } from "./cors-proxy-url";

export type HttpHeaderOccurrence =
  readonly [name: string, value: string];

export interface BrowserCorsProxyConfig {
  readonly url: string;
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
  /**
   * A second request field this proxy reads a byte range from.
   *
   * WORKAROUND for a WP Cloud limitation. The WordPress Playground CORS proxy
   * is a PHP script hosted on WP Cloud, and WP Cloud's front-end web servers
   * strip the `Range` header before the request reaches PHP. The proxy
   * therefore also accepts the same value in the custom header
   * `X-Cors-Proxy-Range`, which WP Cloud passes through, and forwards it to
   * the target as `Range`. Every proxy dispatch copies an outgoing `Range`
   * into this field unchanged and keeps `Range` itself, a combination the
   * proxy documents as safe once `Range` gets through.
   *
   * The whole workaround can be removed as soon as WP Cloud relays `Range`
   * headers to PHP: this field, its value in the default profile, the copies
   * in `project()`/`fetch()`, the service worker, and the development relay,
   * and the `no-store` cache mode that exists only because of the alias.
   * Check with a plain `Range: bytes=0-15` request through the proxy: a
   * `206` answer means `Range` now reaches PHP.
   */
  readonly rangeRequestHeaderAlias?: string;
}

export class BrowserCorsProxyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserCorsProxyRequestError";
  }
}

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const ANONYMOUS_OMISSION_EXCLUDED_NAMES = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);

// Request-header names the browser sets or forbids on every fetch(). A guest's
// value for one of these can never reach the origin no matter what the proxy
// allow-list says, so dropping it is not a proxy-imposed loss of intent — it is
// the browser's own constraint. These are omitted for ANY method (not just
// anonymous GET), which is what lets protocols that POST with a body (notably
// git smart-HTTP's `git-upload-pack`, whose libcurl request carries
// content-length/accept-encoding/user-agent) traverse the proxy instead of
// failing before dispatch. Credential names in ANONYMOUS_OMISSION_EXCLUDED_NAMES
// are deliberately NOT included here: those must still fail loudly rather than
// be silently dropped. Kept in sync with the same list in the service worker
// (apps/browser-demos/public/service-worker.js).
export const BROWSER_CONTROLLED_REQUEST_HEADER_NAMES = new Set([
  // Fetch "forbidden request-header" names.
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  // Client-hint / identity fields the browser manages itself.
  "accept-language",
  "user-agent",
]);

function isBrowserControlledRequestHeader(lowerName: string): boolean {
  return (
    BROWSER_CONTROLLED_REQUEST_HEADER_NAMES.has(lowerName) ||
    lowerName.startsWith("proxy-") ||
    lowerName.startsWith("sec-")
  );
}

export function validateBrowserCorsProxyConfig(
  value: BrowserCorsProxyConfig | undefined,
): BrowserCorsProxyConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("browser CORS proxy configuration must be an object");
  }
  if (typeof value.url !== "string" || value.url.trim().length === 0) {
    throw new TypeError("browser CORS proxy URL must not be empty");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new TypeError("browser CORS proxy URL must be an HTTP(S) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError("browser CORS proxy URL must be an HTTP(S) URL");
  }
  if (!Array.isArray(value.allowedRequestHeaderNames)) {
    throw new TypeError(
      "browser CORS proxy allowed request header names must be an array",
    );
  }
  if (typeof value.allowAnonymousGetHeaderOmission !== "boolean") {
    throw new TypeError(
      "browser CORS proxy allowAnonymousGetHeaderOmission must be a boolean",
    );
  }

  const allowedRequestHeaderNames = value.allowedRequestHeaderNames.map(
    (name, index) => {
      if (typeof name !== "string" || !HTTP_FIELD_NAME.test(name)) {
        throw new TypeError(
          `browser CORS proxy request header name at index ${index} is an invalid HTTP field-name token`,
        );
      }
      return name;
    },
  );

  const alias = value.rangeRequestHeaderAlias;
  if (alias !== undefined) {
    if (typeof alias !== "string" || !HTTP_FIELD_NAME.test(alias)) {
      throw new TypeError(
        "browser CORS proxy rangeRequestHeaderAlias must be an HTTP field-name token",
      );
    }
    if (asciiCaseInsensitiveEqual(alias, "range")) {
      throw new TypeError(
        "browser CORS proxy rangeRequestHeaderAlias must differ from Range",
      );
    }
    // The alias is written by projection from Range, never taken from the
    // caller: a guest-supplied value could disagree with the Range it sent.
    if (
      allowedRequestHeaderNames.some((name) =>
        asciiCaseInsensitiveEqual(name, alias)
      )
    ) {
      throw new TypeError(
        "browser CORS proxy rangeRequestHeaderAlias must not be an allowed request header",
      );
    }
  }

  return Object.freeze({
    url: value.url,
    allowedRequestHeaderNames: Object.freeze(allowedRequestHeaderNames),
    allowAnonymousGetHeaderOmission: value.allowAnonymousGetHeaderOmission,
    ...(alias === undefined ? {} : { rangeRequestHeaderAlias: alias }),
  });
}

export class BrowserCorsProxy {
  private readonly diagnostics = new Set<string>();

  constructor(
    private readonly config: BrowserCorsProxyConfig,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  urlFor(targetUrl: string): string {
    return corsProxyFetchUrl(this.config.url, targetUrl);
  }

  /**
   * Project a request, send it through the proxy, and honor its `If-Range`.
   *
   * WHY: a proxy whose profile does not allow `If-Range` cannot carry it, and
   * dropping it would turn a conditional ranged read into an unconditional
   * one: after the resource changes, a resuming client would get a slice of
   * the new version. RFC 9110 section 13.1.5 says a server whose If-Range
   * condition is false ignores `Range` and sends the whole representation.
   * Apply that rule here instead: send the range without `If-Range`, and if
   * the `206` does not carry the matching validator, discard it and fetch
   * the whole representation. A validator this cannot confirm counts as a
   * mismatch, so the cost of doubt is one extra full request, never a wrong
   * slice. Without `Range`, `If-Range` is meaningless and is dropped. A
   * `416` gets the same treatment: a server whose condition is false would
   * have ignored the unsatisfiable range and sent the whole representation.
   * Several `If-Range` occurrences are joined as Fetch joins them, which
   * never matches a single validator, so the service worker agrees.
   */
  async fetch(
    request: {
      method: string;
      headers: readonly HttpHeaderOccurrence[];
      body?: BodyInit;
      /** Defaults to `body !== undefined`; a caller that drops a body sent
       *  with GET/HEAD still reports it so projection judges the real ask. */
      bodyPresent?: boolean;
      targetUrl: string;
    },
    fetchImpl: (input: string, init: RequestInit) => Promise<Response> =
      (input, init) => globalThis.fetch(input, init),
  ): Promise<Response> {
    const ifRangeValues: string[] = [];
    const occurrences = this.isAllowed("if-range")
      ? request.headers
      : request.headers.filter(([name, value]) => {
        if (asciiLowercase(name) !== "if-range") return true;
        ifRangeValues.push(value);
        return false;
      });
    const ifRange = ifRangeValues.length === 0
      ? undefined
      : ifRangeValues.join(", ");
    const headers = this.project({
      method: request.method,
      headers: occurrences,
      bodyPresent: request.bodyPresent ?? request.body !== undefined,
      targetUrl: request.targetUrl,
    });
    const url = this.urlFor(request.targetUrl);
    const init: RequestInit = { method: request.method, headers, body: request.body };
    const alias = this.config.rangeRequestHeaderAlias;
    if (alias !== undefined && headers.has(alias)) {
      // WORKAROUND, part of the X-Cors-Proxy-Range alias for WP Cloud (see
      // BrowserCorsProxyConfig.rangeRequestHeaderAlias). The browser's HTTP
      // cache may shrink Range on the wire to the bytes it has not stored,
      // but it cannot shrink the alias to match. The proxy then answers the
      // alias's range and the cache joins a body shorter than its
      // Content-Range, so keep this request out of the cache. In Chromium
      // this also skips the CORS preflight cache, so every aliased request
      // pays a preflight (documented technical debt). Remove this together
      // with the alias, as soon as WP Cloud relays Range headers to PHP.
      init.cache = "no-store";
    }
    const response = await fetchImpl(url, init);
    if (
      ifRange === undefined ||
      request.method !== "GET" ||
      (response.status !== 206 && response.status !== 416) ||
      ifRangeMatches(ifRange, response.headers)
    ) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    headers.delete("range");
    if (alias !== undefined) headers.delete(alias);
    const { cache: _cache, ...wholeInit } = init;
    return fetchImpl(url, { ...wholeInit, headers });
  }

  project(input: {
    method: string;
    headers: readonly HttpHeaderOccurrence[];
    bodyPresent: boolean;
    targetUrl: string;
  }): Headers {
    const headers = new Headers();
    const unsupportedNames: string[] = [];
    let hasAnonymousOmissionExcludedName = false;

    for (const [name, value] of input.headers) {
      const lowerName = asciiLowercase(name);
      const isCredential = ANONYMOUS_OMISSION_EXCLUDED_NAMES.has(lowerName);
      if (isCredential) {
        hasAnonymousOmissionExcludedName = true;
      }
      if (this.isAllowed(name)) {
        headers.append(name, value);
        continue;
      }
      if (isCredential) {
        // Credentials are never silently dropped — surface them as unsupported
        // so the request fails loudly instead of going out unauthenticated.
        unsupportedNames.push(lowerName);
        continue;
      }
      if (isBrowserControlledRequestHeader(lowerName)) {
        // The browser sets/forbids this field on the outgoing fetch itself, so
        // omitting it here changes nothing the origin could have observed.
        continue;
      }

      unsupportedNames.push(lowerName);
    }

    this.mirrorRange(headers);
    if (unsupportedNames.length === 0) return headers;

    const origin = new URL(input.targetUrl).origin;
    const names = sortedUnique(unsupportedNames);
    const canOmit =
      input.method === "GET" &&
      !input.bodyPresent &&
      this.config.allowAnonymousGetHeaderOmission &&
      !hasAnonymousOmissionExcludedName;
    if (canOmit) {
      this.reportOmission(origin, names);
      return headers;
    }

    throw new BrowserCorsProxyRequestError(
      `Browser CORS proxy ${this.config.url} cannot relay ${input.method} request to ${origin} with unsupported request headers: ${names.join(", ")}`,
    );
  }

  // WORKAROUND for WP Cloud stripping Range before it reaches the proxy's
  // PHP (see BrowserCorsProxyConfig.rangeRequestHeaderAlias). Remove as soon
  // as WP Cloud relays Range headers to PHP.
  private mirrorRange(headers: Headers): void {
    const alias = this.config.rangeRequestHeaderAlias;
    const range = headers.get("range");
    if (alias !== undefined && range !== null) headers.set(alias, range);
  }

  private isAllowed(name: string): boolean {
    // Preserve the configured list as the proxy's declared capability surface.
    return this.config.allowedRequestHeaderNames.some((allowedName) =>
      asciiCaseInsensitiveEqual(allowedName, name)
    );
  }

  private reportOmission(origin: string, names: readonly string[]): void {
    const key = `${origin}\n${names.join("\n")}`;
    if (this.diagnostics.has(key)) return;
    this.diagnostics.add(key);
    this.onDiagnostic?.(
      `Browser CORS proxy omitted unsupported request headers for ${origin}: ${names.join(", ")}`,
    );
  }
}

/**
 * Whether a `206` satisfies an `If-Range` condition (RFC 9110 13.1.5).
 *
 * An entity tag must equal the response's strong `ETag`. A date must equal
 * `Last-Modified` exactly, and that `Last-Modified` must be a strong
 * validator: at least one second older than the response's `Date`.
 */
export function ifRangeMatches(ifRange: string, headers: Headers): boolean {
  const value = ifRange.trim();
  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) {
    return headers.get("etag")?.trim() === value;
  }
  const lastModified = headers.get("last-modified")?.trim();
  if (lastModified === undefined || lastModified !== value) return false;
  const modified = Date.parse(lastModified);
  const date = Date.parse(headers.get("date") ?? "");
  return Number.isFinite(modified) && Number.isFinite(date) &&
    date - modified >= 1000;
}

function sortedUnique(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort();
}

function asciiCaseInsensitiveEqual(left: string, right: string): boolean {
  return asciiLowercase(left) === asciiLowercase(right);
}

function asciiLowercase(value: string): string {
  let lower = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    lower += code >= 0x41 && code <= 0x5a
      ? String.fromCharCode(code + 0x20)
      : value[index];
  }
  return lower;
}
