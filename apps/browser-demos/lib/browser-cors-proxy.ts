import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "../../../host/src/networking/browser-cors-proxy";

const defaultConfig = validateBrowserCorsProxyConfig({
  url: "https://wordpress-playground-cors-proxy.net/?",
  // WHY range/if-range: forwarding them is what makes a byte-range read
  // possible at all. They are relayed opaquely; nothing here parses them. A
  // proxy that still ignores them answers 200 with the whole entity, which
  // fetchByteRange() reports as such instead of as the requested slice.
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "if-range",
    "range",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
});
if (defaultConfig === undefined) {
  throw new Error("default browser CORS proxy configuration is missing");
}

export const DEFAULT_BROWSER_CORS_PROXY_CONFIG = defaultConfig;

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
    url = new URL(`${baseUrl}__kandelo_cors_proxy?url=`, environment.pageUrl)
      .href;
  }
  return validateBrowserCorsProxyConfig({
    ...DEFAULT_BROWSER_CORS_PROXY_CONFIG,
    url,
  })!;
}
