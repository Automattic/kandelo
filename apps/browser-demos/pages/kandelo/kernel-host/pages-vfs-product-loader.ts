import {
  resolveGroupedAssetUrl,
  validateVfsAssetGroupManifest,
  type VfsAssetGroupManifestV1,
} from "../../../../../web-libs/kandelo-session/src/vfs-asset-group";
import { normalizeDeploymentBase } from "../../../../../web-libs/kandelo-session/src/deployment-scope";

export interface PagesVfsAssetGroupIdentity {
  bytes: number;
  path: string;
  sha256: string;
}
export interface PagesVfsProductEntry {
  asset_group?: PagesVfsAssetGroupIdentity;
  bytes: number;
  id: string;
  load: "eager" | "lazy";
  path: string;
  sha256: string;
}
export interface ActivatedPagesVfsProduct {
  id: string;
  imageBytes: ArrayBuffer;
  imageUrl: string;
  lazyAssets?: {
    deploymentBase: string;
    directoryUrl: string;
    manifestUrl: string;
  };
}
export type PagesVfsProductFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export interface PagesVfsProductLoader {
  activate(id: string): Promise<ActivatedPagesVfsProduct>;
  bytes(id: string): Promise<ArrayBuffer>;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function createPagesVfsProductLoader(
  entries: readonly PagesVfsProductEntry[],
  fetcher: PagesVfsProductFetcher,
): PagesVfsProductLoader {
  return createPagesVfsProductLoaderForBase(
    entries,
    fetcher,
    configuredViteBase(),
  );
}

export function createPagesVfsProductLoaderForBase(
  entries: readonly PagesVfsProductEntry[],
  fetcher: PagesVfsProductFetcher,
  deploymentBase: string,
): PagesVfsProductLoader {
  const base = normalizeDeploymentBase(deploymentBase);
  const byId = new Map<string, PagesVfsProductEntry>();
  let group: PagesVfsAssetGroupIdentity | undefined;
  let grouped: boolean | undefined;
  for (const [index, value] of entries.entries()) {
    const entry = validateEntry(value, index, base);
    if (byId.has(entry.id))
      throw new Error(`Pages VFS product map contains duplicate ${entry.id}`);
    const declaresGroup = entry.asset_group !== undefined;
    if (grouped !== undefined && grouped !== declaresGroup) {
      throw new Error(
        "Pages VFS products must all declare one asset group or all omit it",
      );
    }
    grouped = declaresGroup;
    if (
      group !== undefined &&
      entry.asset_group !== undefined &&
      !sameIdentity(group, entry.asset_group)
    ) {
      throw new Error("Pages VFS products must share one asset group identity");
    }
    group = entry.asset_group;
    byId.set(entry.id, entry);
  }
  if (grouped === undefined) throw new Error("Pages VFS product map is empty");

  let groupLoading: Promise<VfsAssetGroupManifestV1> | undefined;
  let settledGroupPromise: Promise<VfsAssetGroupManifestV1> | undefined;
  const activations = new Map<string, Promise<ActivatedPagesVfsProduct>>();
  const loadGroup = (): Promise<VfsAssetGroupManifestV1> => {
    if (group === undefined)
      return Promise.reject(new Error("Pages VFS product map has no asset group"));
    if (settledGroupPromise !== undefined) return settledGroupPromise;
    if (groupLoading !== undefined) return groupLoading;
    const pending = fetchAndValidateGroup(group!, fetcher).then((manifest) => {
      settledGroupPromise = Promise.resolve(manifest);
      return manifest;
    });
    groupLoading = pending;
    void pending.then(
      () => {
        if (groupLoading === pending) groupLoading = undefined;
      },
      () => {
        if (groupLoading === pending) groupLoading = undefined;
      },
    );
    return pending;
  };
  const activate = (id: string): Promise<ActivatedPagesVfsProduct> => {
    const entry = byId.get(id);
    if (entry === undefined)
      return Promise.reject(
        new Error(`unknown Pages VFS product ${JSON.stringify(id)}`),
      );
    const prior = activations.get(id);
    if (prior !== undefined) return prior;
    const pending = (entry.asset_group === undefined
      ? fetchAndValidate(
          entry.path,
          entry.bytes,
          entry.sha256,
          `Pages VFS product ${id}`,
          fetcher,
        ).then((image) => ({
          id,
          imageBytes: image.slice().buffer,
          imageUrl: absoluteUrl(entry.path),
        }))
      : loadGroup().then(async (manifest) => {
          const product = manifest.products.find(
            (candidate) => candidate.id === id,
          );
          if (product === undefined)
            throw new Error(`VFS asset group lacks product ${id}`);
          if (
            product.image.bytes !== entry.bytes ||
            product.image.sha256 !== entry.sha256
          ) {
            throw new Error(
              `Pages VFS product ${id} differs from its group image identity`,
            );
          }
          const manifestUrl = absoluteUrl(entry.asset_group.path);
          const imageUrl = resolveGroupedAssetUrl(
            manifestUrl,
            product.image.path,
            base,
          );
          const image = await fetchAndValidate(
            imageUrl,
            product.image.bytes,
            product.image.sha256,
            `Pages VFS product ${id}`,
            fetcher,
          );
          return {
            id,
            imageBytes: image.slice().buffer,
            imageUrl,
            // A cached activation is shared by consumers; do not expose authority
            // that one consumer can redirect before another serializes its image.
            lazyAssets: Object.freeze({
              deploymentBase: base,
              directoryUrl: new URL("./", manifestUrl).href,
              manifestUrl,
            }),
          };
        }));
    activations.set(id, pending);
    void pending.then(
      () => undefined,
      () => {
        if (activations.get(id) === pending) activations.delete(id);
      },
    );
    return pending;
  };
  for (const entry of byId.values())
    if (entry.load === "eager") void activate(entry.id).catch(() => undefined);
  return {
    activate,
    async bytes(id) {
      return (await activate(id)).imageBytes.slice(0);
    },
  };
}

async function fetchAndValidateGroup(
  identity: PagesVfsAssetGroupIdentity,
  fetcher: PagesVfsProductFetcher,
): Promise<VfsAssetGroupManifestV1> {
  const bytes = await fetchAndValidate(
    identity.path,
    identity.bytes,
    identity.sha256,
    "Pages VFS asset group manifest",
    fetcher,
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Pages VFS asset group manifest is not JSON");
  }
  return validateVfsAssetGroupManifest(value);
}

async function fetchAndValidate(
  url: string,
  expectedBytes: number,
  expectedSha256: string,
  label: string,
  fetcher: PagesVfsProductFetcher,
): Promise<Uint8Array> {
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (
    contentLength === null ||
    !/^[1-9][0-9]*$/u.test(contentLength) ||
    Number(contentLength) !== expectedBytes
  ) {
    throw new Error(`${label} content-length differs from ${expectedBytes}`);
  }
  const bytes = await readBounded(response, expectedBytes, label);
  const digestBytes = new Uint8Array(bytes.byteLength);
  digestBytes.set(bytes);
  if (
    bytesToHex(await crypto.subtle.digest("SHA-256", digestBytes)) !==
    expectedSha256
  ) {
    throw new Error(`${label} SHA-256 differs from ${expectedSha256}`);
  }
  return bytes;
}

async function readBounded(
  response: Response,
  maximum: number,
  label: string,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`${label} has no response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum)
        throw new Error(`${label} received length exceeds ${maximum}`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== maximum)
    throw new Error(`${label} received length differs from ${maximum}`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateEntry(
  value: PagesVfsProductEntry,
  index: number,
  base: string,
): PagesVfsProductEntry {
  const declaresAssetGroup = Object.prototype.hasOwnProperty.call(
    value,
    "asset_group",
  );
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      (declaresAssetGroup
        ? "asset_group,bytes,id,load,path,sha256"
        : "bytes,id,load,path,sha256") ||
    !STABLE_ID.test(value.id) ||
    (value.load !== "eager" && value.load !== "lazy") ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    !SHA256.test(value.sha256)
  )
    throw new Error(`Pages VFS product entry ${index} is invalid`);
  const assetGroup = value.asset_group;
  if (declaresAssetGroup) {
    if (
      assetGroup === undefined ||
      assetGroup === null ||
      typeof assetGroup !== "object" ||
      Object.keys(assetGroup).sort().join(",") !== "bytes,path,sha256" ||
      !Number.isSafeInteger(assetGroup.bytes) ||
      assetGroup.bytes < 1 ||
      !SHA256.test(assetGroup.sha256)
    )
      throw new Error(
        `Pages VFS product ${value.id} has an invalid asset group identity`,
      );
  }
  const page = pageUrl();
  const image = new URL(value.path, page);
  const manifest =
    assetGroup === undefined ? undefined : new URL(assetGroup.path, page);
  const prefix = `${base}products/${value.id}/sha256-${value.sha256}/`;
  if (
    image.origin !== page.origin ||
    (manifest !== undefined && manifest.origin !== page.origin) ||
    !image.pathname.startsWith(prefix) ||
    !new RegExp(
      `^${escapeRegExp(prefix)}${escapeRegExp(value.id)}-[1-9][0-9]*\\.vfs\\.zst$`,
      "u",
    ).test(image.pathname) ||
    (manifest !== undefined && !manifest.pathname.startsWith(base)) ||
    image.search !== "" ||
    image.hash !== "" ||
    (manifest !== undefined && manifest.search !== "") ||
    (manifest !== undefined && manifest.hash !== "") ||
    value.path !== image.pathname ||
    (manifest !== undefined && assetGroup!.path !== manifest.pathname)
  )
    throw new Error(
      `Pages VFS product ${value.id} lacks its canonical product or group path`,
    );
  return Object.freeze(
    assetGroup === undefined
      ? { ...value }
      : { ...value, asset_group: Object.freeze({ ...assetGroup }) },
  );
}

function sameIdentity(
  left: PagesVfsAssetGroupIdentity,
  right: PagesVfsAssetGroupIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}
function pageUrl(): URL {
  return typeof location === "undefined"
    ? new URL("https://kandelo.invalid/")
    : new URL(location.href);
}
function absoluteUrl(path: string): string {
  return new URL(path, pageUrl()).href;
}
function configuredViteBase(): string {
  const environment = (
    import.meta as ImportMeta & { env?: { BASE_URL?: unknown } }
  ).env;
  if (typeof environment?.BASE_URL !== "string")
    throw new Error("Vite deployment base is unavailable");
  return normalizeDeploymentBase(environment.BASE_URL);
}
function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
