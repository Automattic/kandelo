const SENTINEL_ORIGIN = "https://kandelo.invalid";
const STORAGE_NAME = /^[a-z0-9-]+$/u;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

export function normalizeDeploymentBase(value: string): string {
  if (value === "" || !value.startsWith("/") || !value.endsWith("/")) {
    throw new Error(`deployment base is invalid: ${JSON.stringify(value)}`);
  }

  const parsed = new URL(value, SENTINEL_ORIGIN);
  if (parsed.origin !== SENTINEL_ORIGIN || parsed.pathname !== value) {
    throw new Error(`deployment base is invalid: ${JSON.stringify(value)}`);
  }
  if (value === "/") return value;

  const segments = value.slice(1, -1).split("/");
  if (segments.some((segment) => segment === "")) {
    throw new Error(`deployment base is invalid: ${JSON.stringify(value)}`);
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`deployment base is invalid: ${JSON.stringify(value)}`);
    }
    if (
      decoded === "." || decoded === ".." || decoded.includes("/") ||
      decoded.includes("\\") || decoded.includes("\0") ||
      PERCENT_ESCAPE.test(decoded)
    ) {
      throw new Error(`deployment base is invalid: ${JSON.stringify(value)}`);
    }
  }
  return value;
}

export function deploymentScopeFromServiceWorkerUrl(
  swUrl: string,
  pageUrl: string,
): string {
  const script = new URL(swUrl);
  const page = new URL(pageUrl);
  if (
    (script.protocol !== "http:" && script.protocol !== "https:") ||
    (page.protocol !== "http:" && page.protocol !== "https:") ||
    script.origin === "null" || page.origin === "null"
  ) {
    throw new Error("service worker and page URLs must use http: or https:");
  }
  if (script.origin !== page.origin) {
    throw new Error("service worker and page must have the same origin");
  }
  const scope = normalizeDeploymentBase(new URL("./", script).pathname);
  if (!page.pathname.startsWith(scope)) {
    throw new Error("page must be inside the service worker script directory");
  }
  return scope;
}

export function scopedStorageKey(scopePath: string, name: string): string {
  const scope = normalizeDeploymentBase(scopePath);
  if (!STORAGE_NAME.test(name)) {
    throw new Error(`storage name is invalid: ${JSON.stringify(name)}`);
  }
  return `kandelo:${encodeURIComponent(scope)}:${name}`;
}
