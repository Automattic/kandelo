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
  //
  // WHY the openai/codex names (and oai-product-sku): they
  // are the ordinary (non-credential) request fields signed-in Codex 0.163.0
  // sends, as observed against local mocks, plus the two it sends only for
  // US-residency and FedRAMP accounts (x-openai-account-routing-override,
  // x-openai-fedramp). The Kandelo CORS proxies allow them. They are relayed
  // for any request, granted or not. Codex's credentials (Authorization,
  // ChatGPT-Account-ID) are deliberately absent: BrowserCorsProxy relays
  // them only for a process holding a credential grant for the target
  // origin. A proxy whose preflight does not allow one of these names fails
  // a request that carries it at the browser's CORS check instead of
  // dropping the field.
  //
  // WHY content-encoding: Codex compresses every signed-in model turn with
  // zstd. Kandelo relays the compressed bytes and their Content-Encoding as
  // written, and the proxies must relay both unchanged; nothing here decodes
  // a zstd body (see docs/browser-support.md).
  //
  // WHY NOT x-openai-memgen-request: Codex sends it only for its `memories`
  // feature, which is off by default and was not observed. A request that
  // carries it still fails loudly, naming it.
  //
  // WHY NOT cache-control: Codex sends it only on its user-settings call
  // (wham/settings/user), which a model turn does not need. Listing it would
  // relay it for every request, and the Playground proxy's preflight does not
  // allow it, so an anonymous GET that carries it (pip revalidating an index)
  // would fail there instead of going out without the field. That settings
  // call is refused before dispatch, naming the field.
  allowedRequestHeaderNames: [
    "accept",
    "content-encoding",
    "content-type",
    "git-protocol",
    "oai-product-sku",
    "openai-beta",
    "originator",
    "range",
    "session-id",
    "thread-id",
    "version",
    "wp_blog",
    "wp_install",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-parent-thread-id",
    "x-codex-routing-hint",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-codex-window-id",
    "x-openai-account-routing-override",
    "x-openai-fedramp",
    "x-openai-internal-codex-responses-lite",
    "x-openai-product-sku",
    "x-openai-subagent",
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

export const DEVELOPMENT_CREDENTIAL_RELAY_ORIGINS = Object.freeze([
  'https://auth.openai.com', 'https://chatgpt.com', 'https://api.openai.com',
]);

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
    ...(environment.development &&
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(environment.pageUrl).hostname)
      ? { credentialRelay: {
        url: new URL(`${environment.baseUrl.replace(/\/$/, '')}/__kandelo_credential_relay`, environment.pageUrl).href,
        allowedOrigins: DEVELOPMENT_CREDENTIAL_RELAY_ORIGINS,
      } } : {}),
  })!;
}
