export function browserResolvedLazySourceUrl(
  source: string,
  pageUrl: string,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return new URL(source).href;
  }
  if (!source.startsWith("/")) {
    throw new Error(
      `lazy source must be absolute or root-relative: ${source}`,
    );
  }
  return new URL(source, pageUrl).href;
}

export function expectedBrowserLazyTransport(
  sourceUrl: string,
  pageUrl: string,
): "direct" | "proxy" {
  return new URL(sourceUrl).origin === new URL(pageUrl).origin
    ? "direct"
    : "proxy";
}
