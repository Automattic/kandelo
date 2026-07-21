import type {
  BootDescriptor,
  DescriptorArtifactIntegrity,
  DescriptorMount,
  DescriptorMountResolver,
  GalleryItem,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export const VFS_IMAGE_QUERY_PARAM = "vfs";
export const HOMEBREW_VFS_QUERY_PARAM = "homebrewVfs";

const VFS_IMAGE_QUERY_ALIASES = [
  VFS_IMAGE_QUERY_PARAM,
  "vfsUrl",
  "demoVfs",
  "demoVfsUrl",
  "image",
] as const;

const HOMEBREW_VFS_QUERY_ALIASES = [
  HOMEBREW_VFS_QUERY_PARAM,
  "homebrewVfsDescriptor",
] as const;

export interface KandeloBootQuery {
  vfsImageUrl: string | null;
  homebrewVfsDescriptorUrl: string | null;
}

export function readKandeloBootQuery(search = currentSearch()): KandeloBootQuery {
  const params = new URLSearchParams(search);
  const rawVfsImageUrl = firstVfsImageQueryValue(params);
  const rawHomebrewDescriptorUrl = firstHomebrewVfsQueryValue(params);
  const vfsImageUrl = normalizeVfsImageUrl(rawVfsImageUrl);
  const homebrewVfsDescriptorUrl = normalizeHomebrewVfsDescriptorUrl(
    rawHomebrewDescriptorUrl,
  );
  if (rawVfsImageUrl && !vfsImageUrl) {
    throw new Error("vfs must name an HTTP(S) VFS image URL");
  }
  if (rawHomebrewDescriptorUrl && !homebrewVfsDescriptorUrl) {
    throw new Error(
      "homebrewVfs must name an absolute canonical HTTPS release descriptor URL",
    );
  }
  return {
    vfsImageUrl,
    homebrewVfsDescriptorUrl,
  };
}

export function galleryItemUrl(
  item: GalleryItem,
  href = currentHref(),
): string {
  const url = new URL(href);
  url.searchParams.delete("demo");
  url.searchParams.delete("idle");
  clearVfsImageQueryParams(url.searchParams);
  clearHomebrewVfsQueryParams(url.searchParams);
  if (item.vfsImageResolver?.kind === "homebrew-vfs-release") {
    url.searchParams.set(
      HOMEBREW_VFS_QUERY_PARAM,
      item.vfsImageResolver.descriptorUrl,
    );
  } else if (item.vfsImageUrl) {
    url.searchParams.set(VFS_IMAGE_QUERY_PARAM, item.vfsImageUrl);
  }
  return url.href;
}

export function vfsImageResolverFromDescriptor(
  descriptor: BootDescriptor,
): DescriptorMountResolver | null {
  const root = descriptor.mounts.find((mount) =>
    mount.path === "/" &&
    mount.source === "image" &&
    mount.resolver?.kind === "homebrew-vfs-release"
  );
  return root?.resolver ?? null;
}

export function vfsImageIntegrityFromDescriptor(
  descriptor: BootDescriptor,
): DescriptorArtifactIntegrity | null {
  const root = descriptor.mounts.find((mount) =>
    mount.path === "/" && mount.source === "image"
  );
  return root?.integrity ?? null;
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

export function descriptorWithVfsImageResolver(
  descriptor: BootDescriptor,
  resolver: DescriptorMountResolver,
  opts: {
    id?: string;
    title?: string;
    packages?: string[];
  } = {},
): BootDescriptor {
  return {
    ...descriptor,
    id: opts.id ?? "homebrew-vfs",
    title: opts.title ?? "Homebrew VFS",
    packages: opts.packages ?? descriptor.packages.slice(),
    mounts: mountsWithRootImageResolver(descriptor.mounts, resolver),
  };
}

export function mountsWithRootImageUrl(
  mounts: DescriptorMount[],
  vfsImageUrl: string,
  options: {
    integrity?: DescriptorArtifactIntegrity;
    resolver?: DescriptorMountResolver;
  } = {},
): DescriptorMount[] {
  let replaced = false;
  const next = mounts.map((mount) => {
    if (mount.path !== "/" || mount.source !== "image") return { ...mount };
    replaced = true;
    const { ref: _ref, resolver: _resolver, integrity: _integrity, ...base } = mount;
    return {
      ...base,
      ref: vfsImageUrl,
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.integrity ? { integrity: options.integrity } : {}),
      readonly: false,
    };
  });
  if (!replaced) {
    next.unshift({
      path: "/",
      source: "image",
      ref: vfsImageUrl,
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ...(options.integrity ? { integrity: options.integrity } : {}),
      readonly: false,
    });
  }
  return next;
}

export function mountsWithRootImageResolver(
  mounts: DescriptorMount[],
  resolver: DescriptorMountResolver,
): DescriptorMount[] {
  let replaced = false;
  const next = mounts.map((mount) => {
    if (mount.path !== "/" || mount.source !== "image") return { ...mount };
    replaced = true;
    const { ref: _ref, resolver: _resolver, integrity: _integrity, ...base } = mount;
    return { ...base, resolver, readonly: false };
  });
  if (!replaced) {
    next.unshift({ path: "/", source: "image", resolver, readonly: false });
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

export function normalizeHomebrewVfsDescriptorUrl(
  raw: string | null | undefined,
): string | null {
  const trimmed = nonEmpty(raw);
  if (!trimmed || raw !== trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== trimmed
  ) {
    return null;
  }
  return url.href;
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

function firstHomebrewVfsQueryValue(params: URLSearchParams): string | null {
  for (const key of HOMEBREW_VFS_QUERY_ALIASES) {
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

function clearHomebrewVfsQueryParams(params: URLSearchParams): void {
  for (const key of HOMEBREW_VFS_QUERY_ALIASES) {
    params.delete(key);
  }
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
