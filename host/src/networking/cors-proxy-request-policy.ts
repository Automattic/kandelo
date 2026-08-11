export interface CorsProxyRequestCapabilities {
  readonly methods: readonly string[];
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export interface ValidatedCorsProxyRequestCapabilities {
  readonly methods: readonly string[];
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export interface CorsProxyRequestProjection {
  readonly headers: Headers;
  readonly omittedHeaders: readonly string[];
}

export class CorsProxyRequestPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorsProxyRequestPolicyError";
  }
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const OUTER_TRANSPORT_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESERVED_PROXY_HEADERS = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
  "x-cors-proxy-allowed-request-headers",
  "x-cors-proxy-content-type",
]);

const SIMPLE_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

const CORS_SAFELIST_VALUE_SIZE_LIMIT = 1024;

export function validateCorsProxyRequestCapabilities(
  proxyUrl: string | undefined,
  value: CorsProxyRequestCapabilities | undefined,
): ValidatedCorsProxyRequestCapabilities | undefined {
  if (value === undefined) return undefined;
  if (typeof proxyUrl !== "string" || proxyUrl.length === 0) {
    throw new TypeError(
      "browser CORS proxy request capabilities require a proxy URL",
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("browser CORS proxy request capabilities must be an object");
  }

  const methods = copyHttpTokens(value.methods, "method");
  const allowedRequestHeaderNames = copyHttpTokens(
    value.allowedRequestHeaderNames,
    "request header name",
  );
  if (typeof value.allowAnonymousGetHeaderOmission !== "boolean") {
    throw new TypeError(
      "browser CORS proxy allowAnonymousGetHeaderOmission must be a boolean",
    );
  }

  return Object.freeze({
    methods,
    allowedRequestHeaderNames,
    allowAnonymousGetHeaderOmission: value.allowAnonymousGetHeaderOmission,
  });
}

export class CorsProxyRequestPolicy {
  private readonly diagnostics = new Set<string>();

  constructor(
    private readonly capabilities: ValidatedCorsProxyRequestCapabilities,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  project(input: {
    method: string;
    headers: readonly (readonly [name: string, value: string])[];
    bodyPresent: boolean;
    targetUrl: string;
  }): CorsProxyRequestProjection {
    const origin = new URL(input.targetUrl).origin;
    const connectionHeaders = connectionNominatedHeaderNames(input.headers);
    const projectedHeaders = new Headers();
    const unsupportedNames: string[] = [];
    const classifiedHeaders: Array<{
      name: string;
      value: string;
      safelisted: boolean;
      configured: boolean;
    }> = [];
    let safelistValueSize = 0;
    let hasReservedProxyHeader = false;

    for (const [name, value] of input.headers) {
      const lowerName = asciiLowercase(name);
      if (
        OUTER_TRANSPORT_HEADERS.has(lowerName) ||
        connectionHeaders.has(lowerName)
      ) {
        continue;
      }

      if (RESERVED_PROXY_HEADERS.has(lowerName)) {
        hasReservedProxyHeader = true;
        unsupportedNames.push(lowerName);
        continue;
      }

      const safelisted = isCorsSafelistedRequestHeader(lowerName, value);
      if (safelisted) safelistValueSize += headerValueByteLength(value);
      classifiedHeaders.push({
        name,
        value,
        safelisted,
        configured: this.capabilities.allowedRequestHeaderNames.some(
          (allowedName) =>
            asciiCaseInsensitiveEqual(allowedName, name),
        ),
      });
    }

    // Fetch makes every individually safelisted name unsafe when their values
    // exceed the aggregate limit. Explicit proxy capability remains separate.
    const safelistWithinSizeLimit =
      safelistValueSize <= CORS_SAFELIST_VALUE_SIZE_LIMIT;
    for (const header of classifiedHeaders) {
      if (
        header.configured ||
        (header.safelisted && safelistWithinSizeLimit)
      ) {
        projectedHeaders.append(header.name, header.value);
      } else {
        unsupportedNames.push(asciiLowercase(header.name));
      }
    }

    const sortedUnsupportedNames = sortedUnique(unsupportedNames);
    const methodSupported = this.capabilities.methods.includes(input.method);
    if (!methodSupported) {
      throw unsupportedRequestError(
        input.method,
        origin,
        `unsupported method ${input.method}`,
        sortedUnsupportedNames,
      );
    }

    // Fetch cannot carry a GET body, so accepting one here would silently
    // change the guest request before the backend dispatches it.
    if (
      input.method === "GET" &&
      input.bodyPresent &&
      sortedUnsupportedNames.length === 0
    ) {
      throw new CorsProxyRequestPolicyError(
        `Browser CORS proxy cannot represent ${input.method} request with a body for ${origin}`,
      );
    }

    if (hasReservedProxyHeader || sortedUnsupportedNames.length > 0) {
      const canOmit =
        !hasReservedProxyHeader &&
        input.method === "GET" &&
        !input.bodyPresent &&
        this.capabilities.allowAnonymousGetHeaderOmission;

      if (!canOmit) {
        throw unsupportedRequestError(
          input.method,
          origin,
          undefined,
          sortedUnsupportedNames,
        );
      }

      this.reportOmission(origin, sortedUnsupportedNames);
    }

    return {
      headers: projectedHeaders,
      omittedHeaders: sortedUnsupportedNames,
    };
  }

  private reportOmission(origin: string, names: readonly string[]): void {
    if (names.length === 0) return;
    const diagnosticKey = `${origin}\n${names.join("\n")}`;
    if (this.diagnostics.has(diagnosticKey)) return;
    this.diagnostics.add(diagnosticKey);
    this.onDiagnostic?.(
      `Browser CORS proxy omitted unsupported request headers for ${origin}: ${names.join(", ")}`,
    );
  }
}

function copyHttpTokens(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`browser CORS proxy ${label}s must be an array`);
  }

  const copy = value.map((token, index) => {
    if (typeof token !== "string" || !HTTP_TOKEN.test(token)) {
      throw new TypeError(
        `browser CORS proxy ${label} at index ${index} is an invalid HTTP token`,
      );
    }
    return token;
  });
  return Object.freeze(copy);
}

function connectionNominatedHeaderNames(
  headers: readonly (readonly [name: string, value: string])[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, value] of headers) {
    if (asciiLowercase(name) !== "connection") continue;
    for (const nominatedName of value.split(",")) {
      const trimmedName = trimHttpWhitespace(nominatedName);
      if (trimmedName !== "") names.add(asciiLowercase(trimmedName));
    }
  }
  return names;
}

function isCorsSafelistedRequestHeader(
  lowerName: string,
  value: string,
): boolean {
  if (headerValueByteLength(value) > 128) return false;

  switch (lowerName) {
    case "accept":
      return !containsCorsUnsafeRequestHeaderByte(value);
    case "accept-language":
    case "content-language":
      return /^[0-9A-Za-z *,.\-;=]*$/.test(value);
    case "content-type":
      return (
        !containsCorsUnsafeRequestHeaderByte(value) &&
        SIMPLE_CONTENT_TYPES.has(mimeTypeEssence(value))
      );
    case "range":
      return isSimpleRangeHeaderValue(value);
    default:
      return false;
  }
}

function headerValueByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function containsCorsUnsafeRequestHeaderByte(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    if (
      (byte < 0x20 && byte !== 0x09) ||
      byte === 0x22 ||
      byte === 0x28 ||
      byte === 0x29 ||
      byte === 0x3a ||
      byte === 0x3c ||
      byte === 0x3e ||
      byte === 0x3f ||
      byte === 0x40 ||
      byte === 0x5b ||
      byte === 0x5c ||
      byte === 0x5d ||
      byte === 0x7b ||
      byte === 0x7d ||
      byte === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function mimeTypeEssence(value: string): string {
  const semicolon = value.indexOf(";");
  const essence = trimHttpWhitespace(
    semicolon === -1 ? value : value.slice(0, semicolon),
  ).toLowerCase();
  const slash = essence.indexOf("/");
  if (
    slash <= 0 ||
    slash !== essence.lastIndexOf("/") ||
    !HTTP_TOKEN.test(essence.slice(0, slash)) ||
    !HTTP_TOKEN.test(essence.slice(slash + 1))
  ) {
    return "";
  }
  return essence;
}

function trimHttpWhitespace(value: string): string {
  return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

function isSimpleRangeHeaderValue(value: string): boolean {
  const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(value);
  if (!match) return false;
  if (match[2] === "") return true;
  return BigInt(match[1]) <= BigInt(match[2]);
}

function unsupportedRequestError(
  method: string,
  origin: string,
  firstReason: string | undefined,
  unsupportedNames: readonly string[],
): CorsProxyRequestPolicyError {
  const reasons: string[] = [];
  if (firstReason !== undefined) reasons.push(firstReason);
  if (unsupportedNames.length > 0) {
    reasons.push(`unsupported request headers: ${unsupportedNames.join(", ")}`);
  }
  return new CorsProxyRequestPolicyError(
    `Browser CORS proxy cannot represent ${method} request for ${origin}: ${reasons.join("; ")}`,
  );
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
    lower +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return lower;
}
