import { corsProxyFetchUrl } from "./cors-proxy-url";
import { fetchWithProxySession } from "./cors-proxy-session";
import {
  type CredentialRelayConfig,
  credentialRelayCarries,
  credentialRelayFetchUrl,
  validateCredentialRelayConfig,
} from "./credential-relay";

export type HttpHeaderOccurrence =
  readonly [name: string, value: string];

export interface BrowserCorsProxyConfig {
  /**
   * Loopback development servers only: the local relay that carries its
   * destinations' requests in this proxy's place, with the same projection
   * (credentials only for a granted process). See `credential-relay.ts`.
   */
  readonly credentialRelay?: CredentialRelayConfig;
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

// Credential fields. They are never silently dropped: a request that carries
// one the proxy will not relay fails before dispatch, so it can never go out
// unauthenticated. `chatgpt-account-id` names the signed-in ChatGPT account;
// it only means something next to that account's bearer token.
const ANONYMOUS_OMISSION_EXCLUDED_NAMES = new Set([
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);

/**
 * Every credential field. The app's service worker mirrors this set: a
 * request to the proxy that carries one needs a verified grant tag there too.
 */
export const CREDENTIAL_REQUEST_HEADER_NAMES: ReadonlySet<string> =
  ANONYMOUS_OMISSION_EXCLUDED_NAMES;

/**
 * The credential fields a per-process credential grant lets through. A
 * grant covers a bearer token and the account it names, nothing else:
 * cookies and proxy credentials stay refused for every request.
 */
export const GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES: ReadonlySet<string> =
  new Set(["authorization", "chatgpt-account-id"]);

/**
 * Tags a granted request with its grant's token. The browser app's service
 * worker verifies the tag with the kernel worker that sent it
 * (`credential-gate.ts`) and removes it before the request leaves the
 * browser.
 */
export const CREDENTIAL_GRANT_REQUEST_HEADER = "X-Kandelo-Credential-Grant";

/**
 * The CORS proxy protocol's opt-in: the proxy relays `Authorization` only
 * when the request names it here (apps/spacefast-cors-proxy/README.md, and
 * the Playground PHP proxy's `X-Cors-Proxy-Allowed-Request-Headers`).
 */
export const CORS_PROXY_ALLOWED_REQUEST_HEADERS_HEADER =
  "X-Cors-Proxy-Allowed-Request-Headers";

/** A grant's tag for one request; see `BrowserCorsProxy.fetch`. */
export interface BrowserCorsProxyCredentialGrant {
  readonly token: string;
}

// Fields that instruct the proxy or the service worker rather than the
// destination. Only projection writes them, so a caller that sends one is
// trying to forge the grant tag or the proxy's credential opt-in (or its
// range alias) and is refused, granted or not, never relayed or omitted.
function isReservedRequestHeader(lowerName: string): boolean {
  return lowerName === "x-kandelo-credential-grant" ||
    lowerName.startsWith("x-cors-proxy-");
}

/** The credential fields a request carries, lowercased, sorted, unique. */
export function credentialRequestHeaderNames(
  headers: readonly HttpHeaderOccurrence[],
): string[] {
  return [...sortedUnique(
    headers
      .map(([name]) => asciiLowercase(name))
      .filter((name) => ANONYMOUS_OMISSION_EXCLUDED_NAMES.has(name)),
  )];
}

/** Whether a request carries a field only a credential grant can relay. */
export function requestCarriesGrantableCredential(
  headers: readonly HttpHeaderOccurrence[],
): boolean {
  return headers.some(([name]) =>
    GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES.has(asciiLowercase(name))
  );
}

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

// A WebSocket handshake asks for the connection itself: its answer is
// `101 Switching Protocols`, after which both sides speak WebSocket. fetch()
// cannot send `Upgrade`, so relaying the handshake would deliver a plain GET
// and hand the guest the destination's answer to a request it never made.
// Refuse it as a request the bridge cannot carry. An upgrade a server may
// ignore (h2c) loses nothing when dropped, so only WebSocket is refused.
function requestsWebSocketUpgrade(
  headers: readonly HttpHeaderOccurrence[],
): boolean {
  return headers.some(([name, value]) =>
    asciiLowercase(name) === "upgrade" &&
    value.split(",").some((token) => asciiLowercase(token.trim()) === "websocket")
  );
}

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
  // Projection refuses these from every caller, so allowing one would be a
  // capability the profile can never exercise.
  const reserved = allowedRequestHeaderNames.find((name) =>
    isReservedRequestHeader(asciiLowercase(name))
  );
  if (reserved !== undefined) {
    throw new TypeError(
      `browser CORS proxy request header ${reserved} is a reserved proxy-control field`,
    );
  }
  // Only a per-process credential grant relays credentials. A profile that
  // allowed one would send it for every process, granted or not.
  const credential = allowedRequestHeaderNames.find((name) =>
    ANONYMOUS_OMISSION_EXCLUDED_NAMES.has(asciiLowercase(name))
  );
  if (credential !== undefined) {
    throw new TypeError(
      `browser CORS proxy request header ${credential} is a credential field; only a credential grant relays it`,
    );
  }

  return Object.freeze({
    url: value.url,
    ...(value.credentialRelay === undefined ? {} : {
      credentialRelay: validateCredentialRelayConfig(value.credentialRelay),
    }),
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
   *
   * `grant` is the caller's finding that the process that wrote this request
   * holds a credential grant whose destinations include the target origin.
   * Only then do `Authorization` and `ChatGPT-Account-ID` pass, with the
   * proxy's opt-in and the grant's tag (see `project`). The caller owns that
   * finding; this class cannot see processes.
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
    grant?: BrowserCorsProxyCredentialGrant,
  ): Promise<Response> {
    // The development relay takes its destinations' requests in the proxy's
    // place. Projection is the same, so an ungranted credential fails here,
    // before anything reaches it.
    const relay = this.config.credentialRelay;
    const viaRelay = credentialRelayCarries(relay, request.targetUrl);
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
      grant,
    });
    const url = viaRelay
      ? credentialRelayFetchUrl(relay!, request.targetUrl)
      : this.urlFor(request.targetUrl);
    const init: RequestInit = {
      method: request.method,
      headers,
      body: request.body,
      // The relay is same-origin: the browser's own cookies are not the
      // guest's and must not ride along.
      ...(viaRelay ? { credentials: "omit" as const } : {}),
    };
    // The proxy session is the public proxy's quota protocol; the local
    // relay has none.
    const send = (input: string, sendInit: RequestInit) => viaRelay
      ? fetchImpl(input, sendInit)
      : fetchWithProxySession(input, sendInit, fetchImpl);
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
    const response = await send(url, init);
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
    return send(url, { ...wholeInit, headers });
  }

  /**
   * The headers the proxy receives for a request, or a
   * `BrowserCorsProxyRequestError` when the request cannot be relayed as the
   * caller made it.
   *
   * With `grant`, `Authorization` and `ChatGPT-Account-ID` pass; a request
   * carrying either also gets the grant's tag, and one carrying
   * `Authorization` gets the proxy's opt-in for it. A granted credential
   * still makes the request credentialed, so no other field is omitted from
   * it. Every other credential field, and every credential without a grant,
   * fails the request. Reserved proxy-control fields fail it whatever the
   * grant, and so does a WebSocket handshake, which fetch() cannot carry.
   */
  project(input: {
    method: string;
    headers: readonly HttpHeaderOccurrence[];
    bodyPresent: boolean;
    targetUrl: string;
    grant?: BrowserCorsProxyCredentialGrant;
  }): Headers {
    const headers = new Headers();
    const unsupportedNames: string[] = [];
    const reservedNames: string[] = [];
    let hasAnonymousOmissionExcludedName = false;
    let carriesGrantedCredential = false;
    let carriesGrantedAuthorization = false;

    for (const [name, value] of input.headers) {
      const lowerName = asciiLowercase(name);
      if (isReservedRequestHeader(lowerName)) {
        reservedNames.push(lowerName);
        continue;
      }
      const isCredential = ANONYMOUS_OMISSION_EXCLUDED_NAMES.has(lowerName);
      if (isCredential) {
        hasAnonymousOmissionExcludedName = true;
      }
      if (
        input.grant !== undefined &&
        GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES.has(lowerName)
      ) {
        headers.append(name, value);
        carriesGrantedCredential = true;
        if (lowerName === "authorization") carriesGrantedAuthorization = true;
        continue;
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

    const origin = new URL(input.targetUrl).origin;
    if (reservedNames.length > 0) {
      throw new BrowserCorsProxyRequestError(
        `Browser CORS proxy ${this.config.url} cannot relay ${input.method} request to ${origin} with reserved request headers: ${sortedUnique(reservedNames).join(", ")}`,
      );
    }
    if (requestsWebSocketUpgrade(input.headers)) {
      throw new BrowserCorsProxyRequestError(
        `Browser CORS proxy ${this.config.url} cannot relay ${input.method} request to ${origin}: it asks to upgrade the connection to WebSocket, and the browser's HTTP(S) bridge carries HTTP requests only`,
      );
    }

    this.mirrorRange(headers);
    if (carriesGrantedCredential) {
      if (carriesGrantedAuthorization) {
        headers.set(CORS_PROXY_ALLOWED_REQUEST_HEADERS_HEADER, "Authorization");
      }
      headers.set(CREDENTIAL_GRANT_REQUEST_HEADER, input.grant!.token);
    }
    if (unsupportedNames.length === 0) return headers;

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
