import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "../../../host/src/networking/browser-cors-proxy";

const defaultConfig = validateBrowserCorsProxyConfig({
  url: "https://wordpress-playground-cors-proxy.net/?",
  // WHY range: forwarding it is what makes a byte-range read possible at
  // all. It is relayed opaquely; nothing here parses it. A relay that still
  // ignores it answers 200 with the whole entity, which fetchByteRange()
  // reports as such instead of as the requested slice.
  //
  // WHY NOT if-range: the Playground proxy's preflight does not allow it, and
  // If-Range is never CORS-safelisted, so listing it here would make every
  // request that carries it fail preflight. Unlisted, it is never sent;
  // BrowserCorsProxy.fetch() and the service worker apply its semantics to
  // the answer instead (RFC 9110 section 13.1.5).
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "range",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
  // WORKAROUND: WP Cloud, which hosts the Playground CORS proxy, strips the
  // Range header before the request reaches the proxy's PHP, so ranges are
  // also sent as X-Cors-Proxy-Range (see
  // BrowserCorsProxyConfig.rangeRequestHeaderAlias). Remove this line, and
  // the workaround it enables, as soon as WP Cloud relays Range headers to
  // PHP.
  // TECHNICAL DEBT: the alias is not a CORS-safelisted header, so ranged
  // requests need a CORS preflight. Aliased requests also skip the HTTP
  // cache, which in Chromium means one preflight per ranged request. See
  // docs/future-improvements.md.
  rangeRequestHeaderAlias: "x-cors-proxy-range",
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
