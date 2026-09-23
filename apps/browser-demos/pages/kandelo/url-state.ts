import type {
  BootDescriptor,
  DescriptorMount,
  GalleryItem,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export const VFS_IMAGE_QUERY_PARAM = "vfs";

/**
 * `&profile=<id>` — which machine inside the image to boot.
 *
 * This replaced `?demo=<id>` outright. The old parameter named one of a dozen
 * ids the APP held; this one names a profile the IMAGE declares, so the app
 * never has to know what any of them are. A legacy `?demo=` is ignored (and
 * stripped when the app rewrites a URL) rather than rejected: every link ever
 * shared carries `?vfs=` too, so such a link still resolves its image and
 * boots that image's declared default profile.
 */
export const PROFILE_QUERY_PARAM = "profile";

const VFS_IMAGE_QUERY_ALIASES = [
  VFS_IMAGE_QUERY_PARAM,
  "vfsUrl",
  "demoVfs",
  "demoVfsUrl",
  "image",
] as const;

export interface KandeloBootQuery {
  vfsImageUrl: string | null;
  /** `&profile=` only. The image URL's own `#fragment` is the other channel,
   *  read from `vfsImageUrl` where its precedence is decided. */
  profileId: string | null;
}

export interface TrustedVfsSourceCandidate<SourceId extends string> {
  id: SourceId;
  resolveVfsImageUrl: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
}

export function readKandeloBootQuery(search = currentSearch()): KandeloBootQuery {
  const params = new URLSearchParams(search);
  return {
    vfsImageUrl: normalizeVfsImageUrl(firstVfsImageQueryValue(params)),
    profileId: nonEmpty(params.get(PROFILE_QUERY_PARAM)),
  };
}

/**
 * The profile an image URL names in its own fragment, e.g.
 * `https://cdn/shell.vfs.zst#doom`.
 *
 * A fragment is a client-side view selector on a resource, not part of its
 * identity, and "which profile of this image" is exactly that — which is why
 * URL identity here is already fragment-safe (see `matchTrustedVfsSourceId`).
 * Keeping this channel is what makes a third party's single image URL
 * self-describing, with no second parameter to paste alongside it.
 */
export function profileIdFromVfsImageUrl(
  vfsImageUrl: string,
  baseHref = currentHref(),
): string | null {
  try {
    return nonEmpty(
      decodeURIComponent(new URL(vfsImageUrl, baseHref).hash.slice(1)),
    );
  } catch {
    return null;
  }
}

export function galleryItemUrl(
  item: GalleryItem,
  href = currentHref(),
): string {
  const url = new URL(href);
  // `?demo=` is gone. Strip it so a legacy link the visitor arrived on does
  // not keep a parameter nothing reads any more.
  url.searchParams.delete("demo");
  url.searchParams.delete("idle");
  url.searchParams.delete(PROFILE_QUERY_PARAM);
  clearVfsImageQueryParams(url.searchParams);
  // A #k1= boot-link fragment belongs to the linked machine only. Launching
  // a different machine from the gallery must not carry its script along.
  url.hash = "";
  if (item.vfsImageUrl) {
    // WHY: the exact image URL identifies the bytes and their resource limit,
    // while the profile selects which machine inside them to boot. The image
    // URL already carries that profile in its own fragment; `&profile=` is
    // written too so the selection is visible in the address bar and survives
    // a hand-edited link that drops the fragment.
    url.searchParams.set(VFS_IMAGE_QUERY_PARAM, item.vfsImageUrl);
    url.searchParams.set(PROFILE_QUERY_PARAM, item.id);
  }
  return url.href;
}

export function navigateToGalleryItemUrl(item: GalleryItem): void {
  const next = galleryItemUrl(item);
  if (next === window.location.href) return;
  window.location.assign(next);
}

export function vfsImageUrlFromDescriptor(
  descriptor: BootDescriptor,
  baseHref = currentHref(),
): string | null {
  const root = descriptor.mounts.find((mount) =>
    mount.path === "/" &&
    mount.source === "image" &&
    typeof mount.ref === "string"
  );
  const ref = root?.ref ?? null;
  if (!isUrlLikeImageRef(ref)) return null;
  return normalizeVfsImageUrl(ref, baseHref);
}

export function descriptorWithVfsImageUrl(
  descriptor: BootDescriptor,
  vfsImageUrl: string,
  opts: {
    id?: string;
    title?: string;
    packages?: string[];
  } = {},
): BootDescriptor {
  const normalizedVfsImageUrl = normalizeVfsImageUrl(vfsImageUrl) ?? vfsImageUrl;
  const id = opts.id ?? demoIdFromVfsImageUrl(normalizedVfsImageUrl);
  return {
    ...descriptor,
    id,
    title: opts.title ?? titleFromVfsImageUrl(normalizedVfsImageUrl),
    packages: opts.packages ?? descriptor.packages.slice(),
    mounts: mountsWithRootImageUrl(descriptor.mounts, normalizedVfsImageUrl),
  };
}

export function mountsWithRootImageUrl(
  mounts: DescriptorMount[],
  vfsImageUrl: string,
): DescriptorMount[] {
  let replaced = false;
  const next = mounts.map((mount) => {
    if (mount.path !== "/" || mount.source !== "image") return { ...mount };
    replaced = true;
    return { ...mount, ref: vfsImageUrl, readonly: false };
  });
  if (!replaced) {
    next.unshift({ path: "/", source: "image", ref: vfsImageUrl, readonly: false });
  }
  return next;
}

export function normalizeVfsImageUrl(
  raw: string | null | undefined,
  baseHref = currentHref(),
): string | null {
  const trimmed = nonEmpty(raw);
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed, baseHref);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/**
 * Match a URL to one exact trusted VFS source.
 *
 * Fragments describe launch behavior, not file identity, so they are ignored
 * here. Unmatched, duplicated, ambiguous, and unresolvable sources fail closed.
 */
export async function matchTrustedVfsSourceId<SourceId extends string>(
  vfsImageUrl: string,
  candidates: readonly TrustedVfsSourceCandidate<SourceId>[],
  baseHref = currentHref(),
): Promise<SourceId | null> {
  const normalized = normalizeVfsImageUrl(vfsImageUrl, baseHref);
  if (!normalized) return null;

  const ids = new Set<SourceId>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) return null;
    ids.add(candidate.id);
  }

  const requestedBase = withoutUrlHash(new URL(normalized));

  const matches = (
    await Promise.all(candidates.map(async (candidate) => ({
      id: candidate.id,
      baseUrl: await resolvedCandidateBaseUrl(candidate, baseHref),
    })))
  ).filter((candidate) => candidate.baseUrl === requestedBase);
  return matches.length === 1 ? matches[0].id : null;
}

export function demoIdFromVfsImageUrl(vfsImageUrl: string): string {
  let name = "custom-vfs";
  try {
    const url = new URL(vfsImageUrl, currentHref());
    name = url.pathname.split("/").filter(Boolean).pop() ?? name;
  } catch {
    name = vfsImageUrl.split(/[/?#]/).filter(Boolean).pop() ?? name;
  }
  name = name
    .replace(/\.vfs(?:\.zst)?$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return name || "custom-vfs";
}

export function titleFromVfsImageUrl(vfsImageUrl: string): string {
  const id = demoIdFromVfsImageUrl(vfsImageUrl);
  if (id === "custom-vfs") return "Custom VFS image";
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function firstVfsImageQueryValue(params: URLSearchParams): string | null {
  for (const key of VFS_IMAGE_QUERY_ALIASES) {
    const value = nonEmpty(params.get(key));
    if (value) return value;
  }
  return null;
}

function clearVfsImageQueryParams(params: URLSearchParams): void {
  for (const key of VFS_IMAGE_QUERY_ALIASES) {
    params.delete(key);
  }
}

async function resolvedCandidateBaseUrl<SourceId extends string>(
  candidate: TrustedVfsSourceCandidate<SourceId>,
  baseHref = currentHref(),
): Promise<string | null> {
  try {
    const resolved = await candidate.resolveVfsImageUrl();
    const normalized = normalizeVfsImageUrl(resolved, baseHref);
    return normalized ? withoutUrlHash(new URL(normalized)) : null;
  } catch {
    return null;
  }
}

function withoutUrlHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isUrlLikeImageRef(value: string | null | undefined): boolean {
  const trimmed = nonEmpty(value);
  if (!trimmed) return false;
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  );
}

function currentHref(): string {
  return typeof window === "undefined" ? "https://kandelo.local/" : window.location.href;
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}
