import { corsProxyFetchUrl } from "./cors-proxy-url";

export type HttpHeaderOccurrence =
  readonly [name: string, value: string];

export interface BrowserCorsProxyConfig {
  readonly url: string;
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
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

  return Object.freeze({
    url: value.url,
    allowedRequestHeaderNames: Object.freeze(allowedRequestHeaderNames),
    allowAnonymousGetHeaderOmission: value.allowAnonymousGetHeaderOmission,
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
