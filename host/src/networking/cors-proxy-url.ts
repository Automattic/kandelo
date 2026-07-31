/**
 * Route one target through a CORS-proxy prefix.
 *
 * A bare `?` proxy accepts the target URL verbatim. Named query parameters,
 * such as `?url=`, need percent encoding so a target query cannot become part
 * of the proxy's own query string.
 */
export function corsProxyFetchUrl(
  corsProxyUrl: string,
  targetUrl: string,
): string {
  const proxyUrl = corsProxyUrl.trim();
  if (proxyUrl.length === 0) {
    throw new Error("CORS proxy URL must not be empty");
  }
  if (targetUrl.startsWith(proxyUrl)) return targetUrl;
  const proxiedTarget = proxyUrl.endsWith("?")
    ? targetUrl
    : encodeURIComponent(targetUrl);
  return `${proxyUrl}${proxiedTarget}`;
}

/**
 * Recover the target from a URL produced by {@link corsProxyFetchUrl}.
 *
 * This is intended for diagnostics and acceptance evidence. The proxy still
 * owns request validation; callers must not treat a decoded target as trusted
 * input. Pass the page or worker URL as `baseUrl` when the configured prefix
 * can be relative.
 */
export function corsProxyTargetUrl(
  corsProxyUrl: string,
  fetchUrl: string,
  baseUrl?: string,
): string | undefined {
  let proxyUrl = corsProxyUrl.trim();
  if (proxyUrl.length === 0) return undefined;
  if (baseUrl !== undefined) {
    try {
      proxyUrl = new URL(proxyUrl, baseUrl).href;
    } catch {
      return undefined;
    }
  }
  if (!fetchUrl.startsWith(proxyUrl)) {
    return undefined;
  }
  const suffix = fetchUrl.slice(proxyUrl.length);
  if (suffix.length === 0) return undefined;
  let targetUrl: string;
  try {
    targetUrl = proxyUrl.endsWith("?")
      ? suffix
      : decodeURIComponent(suffix);
  } catch {
    return undefined;
  }
  try {
    const target = new URL(targetUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
}
