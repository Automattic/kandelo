export interface PagesVfsProductEntry {
  bytes: number;
  id: string;
  load: "eager" | "lazy";
  path: string;
  sha256: string;
}

export type PagesVfsProductFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface PagesVfsProductLoader {
  activate(id: string): Promise<string>;
  bytes(id: string): Promise<ArrayBuffer>;
  path(id: string): string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function createPagesVfsProductLoader(
  entries: readonly PagesVfsProductEntry[],
  fetcher: PagesVfsProductFetcher,
): PagesVfsProductLoader {
  const base = configuredViteBase();
  const byId = new Map<string, PagesVfsProductEntry>();
  for (const [index, value] of entries.entries()) {
    const entry = validateEntry(value, index, base);
    if (byId.has(entry.id)) {
      throw new Error(`Pages VFS product map contains duplicate ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  const cached = new Map<string, Promise<string>>();
  const validatedBytes = new Map<string, Uint8Array>();
  const activate = (id: string): Promise<string> => {
    const entry = byId.get(id);
    if (entry === undefined) {
      return Promise.reject(new Error(`unknown Pages VFS product ${JSON.stringify(id)}`));
    }
    const prior = cached.get(id);
    if (prior !== undefined) return prior;

    let fulfill!: (url: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolve, rejectPromise) => {
      fulfill = resolve;
      reject = rejectPromise;
    });
    // WHY: publish the promise before calling an injectable fetcher. This
    // closes both ordinary concurrent activation and synchronous re-entry.
    cached.set(id, promise);
    void fetchAndValidate(entry, fetcher).then((bytes) => {
      validatedBytes.set(id, bytes);
      fulfill(entry.path);
    }, reject);
    return promise;
  };

  for (const entry of byId.values()) {
    if (entry.load === "eager") {
      // The rejected promise remains cached for the first consumer, while this
      // observer prevents a pre-activation integrity failure from becoming an
      // unrelated global unhandled-rejection event.
      void activate(entry.id).catch(() => undefined);
    }
  }
  const bytes = async (id: string): Promise<ArrayBuffer> => {
    await activate(id);
    const value = validatedBytes.get(id);
    if (value === undefined) throw new Error(`Pages VFS product ${id} has no validated bytes`);
    return value.slice().buffer;
  };
  const path = (id: string): string => {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`unknown Pages VFS product ${JSON.stringify(id)}`);
    return entry.path;
  };
  return { activate, bytes, path };
}

async function fetchAndValidate(
  entry: PagesVfsProductEntry,
  fetcher: PagesVfsProductFetcher,
): Promise<Uint8Array> {
  const response = await fetcher(entry.path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Pages VFS product ${entry.id} returned HTTP ${response.status}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength === null || !/^[1-9][0-9]*$/u.test(declaredLength) ||
    Number(declaredLength) !== entry.bytes
  ) {
    throw new Error(`Pages VFS product ${entry.id} content-length differs from ${entry.bytes}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== entry.bytes) {
    throw new Error(`Pages VFS product ${entry.id} received length differs from ${entry.bytes}`);
  }
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== entry.sha256) {
    throw new Error(`Pages VFS product ${entry.id} SHA-256 differs from ${entry.sha256}`);
  }
  return bytes;
}

function validateEntry(
  value: PagesVfsProductEntry,
  index: number,
  base: string,
): PagesVfsProductEntry {
  if (
    value === null || typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "bytes,id,load,path,sha256" ||
    !STABLE_ID.test(value.id) ||
    (value.load !== "eager" && value.load !== "lazy") ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
    !SHA256.test(value.sha256)
  ) {
    throw new Error(`Pages VFS product entry ${index} is invalid`);
  }
  const pageLocation = typeof location === "undefined"
    ? new URL("https://kandelo.invalid/")
    : new URL(location.href);
  const url = new URL(value.path, pageLocation);
  if (url.origin !== pageLocation.origin) {
    throw new Error(`Pages VFS product ${value.id} path must be same-origin`);
  }
  const expectedPrefix = `${base}products/${value.id}/sha256-${value.sha256}/`;
  if (
    !url.pathname.startsWith(expectedPrefix) ||
    !new RegExp(`^${escapeRegExp(expectedPrefix)}${escapeRegExp(value.id)}-[1-9][0-9]*\\.vfs\\.zst$`, "u")
      .test(url.pathname) ||
    url.search !== "" || url.hash !== "" || value.path !== url.pathname
  ) {
    throw new Error(`Pages VFS product ${value.id} lacks its canonical product path`);
  }
  return Object.freeze({ ...value });
}

function configuredViteBase(): string {
  const environment = (import.meta as ImportMeta & {
    env?: { BASE_URL?: unknown };
  }).env;
  const value = environment?.BASE_URL;
  if (typeof value !== "string" || !value.startsWith("/") || !value.endsWith("/")) {
    return "/";
  }
  return value;
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
