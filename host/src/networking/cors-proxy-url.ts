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
