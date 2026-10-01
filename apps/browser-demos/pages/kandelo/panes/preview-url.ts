export function buildPreviewUrl(base: string, path: string): string {
  if (base === "about:blank") return base;
  try {
    const root = new URL(base, window.location.href);
    const url = new URL(`.${normalizePreviewPath(path, base)}`, root);
    return relativePathFromHref(base, url.href) === null ? root.href : url.href;
  } catch {
    return base;
  }
}

export function normalizePreviewPath(raw: string, base: string): string {
  const value = raw.trim();
  if (!value) return "/";

  const fromAbsolute = relativePathFromHref(base, value);
  if (fromAbsolute) return fromAbsolute;

  if (value.startsWith("?") || value.startsWith("#")) return `/${value}`;
  return value.startsWith("/") ? value : `/${value}`;
}

export function relativePathFromHref(base: string, href: string): string | null {
  if (base === "about:blank") return "/";
  try {
    const root = new URL(base, window.location.href);
    const url = new URL(href, root);
    const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    if (url.origin !== root.origin || !url.pathname.startsWith(rootPath)) return null;
    const suffix = url.pathname.slice(rootPath.length);
    return `/${suffix}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
