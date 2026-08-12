import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "../../../host/src/networking/browser-cors-proxy";

const defaultConfig = validateBrowserCorsProxyConfig({
  url: "https://wordpress-playground-cors-proxy.net/?",
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
});
if (defaultConfig === undefined) {
  throw new Error("default browser CORS proxy configuration is missing");
}

export const DEFAULT_BROWSER_CORS_PROXY_CONFIG = defaultConfig;

// The service-worker template consumes only a transport URL. Its value is
// derived from the complete application-owned capability profile above.
export const DEFAULT_BROWSER_CORS_PROXY_URL =
  DEFAULT_BROWSER_CORS_PROXY_CONFIG.url;

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
export function resolveBrowserCorsProxyConfig(
  environment: BrowserCorsProxyEnvironment,
): BrowserCorsProxyConfig {
  const configuredUrl = environment.configuredUrl?.trim();
  let url: string;
  if (configuredUrl) {
    url = new URL(configuredUrl, environment.pageUrl).href;
  } else if (!environment.development) {
    url = DEFAULT_BROWSER_CORS_PROXY_CONFIG.url;
  } else {
    const baseUrl = environment.baseUrl.endsWith("/")
      ? environment.baseUrl
      : `${environment.baseUrl}/`;
    url = new URL(
      `${baseUrl}__kandelo_cors_proxy?url=`,
      environment.pageUrl,
    ).href;
  }
  return validateBrowserCorsProxyConfig({
    ...DEFAULT_BROWSER_CORS_PROXY_CONFIG,
    url,
  })!;
}
