/** Shared browser-demo CORS proxy selection for Vite and BrowserKernel. */

import { normalizeCorsProxyUrl } from "../../../host/src/networking/cors-proxy";

export const DEFAULT_CORS_PROXY_URL =
  "https://wordpress-playground-cors-proxy.net/?";

export function devCorsProxyPathForBase(base: string): string {
  const normalized = base.startsWith("/") ? base : `/${base}`;
  return `${normalized.endsWith("/") ? normalized : `${normalized}/`}__kandelo_cors_proxy`;
}

export function devCorsProxyFetchUrlForBase(base: string): string {
  return `${devCorsProxyPathForBase(base)}?url=`;
}

export function resolveBrowserCorsProxyUrl(options: {
  baseUrl: string;
  configuredUrl?: string;
  isDev: boolean;
  locationHref: string;
}): string {
  const configured = options.configuredUrl?.trim();
  if (configured) {
    // An override is deployment configuration, not a link relative to the
    // current page. Requiring an absolute reviewed URL keeps page location
    // changes from silently changing the proxy trust boundary.
    return normalizeCorsProxyUrl(configured)!;
  }

  const selected = options.isDev
    ? new URL(
      devCorsProxyFetchUrlForBase(options.baseUrl),
      options.locationHref,
    ).href
    : DEFAULT_CORS_PROXY_URL;
  return normalizeCorsProxyUrl(selected)!;
}
