/** Resolve one image-owned relative lazy asset without rewriting absolute URLs. */
export function resolveLazyUrl(base: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return url;
  return base.replace(/\/?$/, "/") + url;
}
