export const DEFAULT_BROWSER_CORS_PROXY_URL =
  "https://wordpress-playground-cors-proxy.net/?";

interface BrowserCorsProxyEnvironment {
  configuredUrl?: string;
  development: boolean;
  baseUrl: string;
  pageUrl: string;
}

/**
 * Resolve the proxy used by browser-owned network transports.
 *
 * Development uses Vite's same-origin route so local tests do not depend on
 * a public service. Production uses the configured deployment proxy, or the
 * same public default injected into the service worker.
 */
export function resolveBrowserCorsProxyUrl(
  environment: BrowserCorsProxyEnvironment,
): string {
  const configuredUrl = environment.configuredUrl?.trim();
  if (configuredUrl) {
    return new URL(configuredUrl, environment.pageUrl).href;
  }
  if (!environment.development) {
    return DEFAULT_BROWSER_CORS_PROXY_URL;
  }
  const baseUrl = environment.baseUrl.endsWith("/")
    ? environment.baseUrl
    : `${environment.baseUrl}/`;
  return new URL(
    `${baseUrl}__kandelo_cors_proxy?url=`,
    environment.pageUrl,
  ).href;
}
