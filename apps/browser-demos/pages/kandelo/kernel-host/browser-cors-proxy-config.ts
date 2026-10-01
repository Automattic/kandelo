import { resolveBrowserCorsProxyConfig } from "../../../lib/browser-cors-proxy";
import { corsProxyFetch } from "../../../lib/archive-fetch";

/** The CORS proxy this deployment uses, for the machine and for page code. */
export const BROWSER_CORS_PROXY = resolveBrowserCorsProxyConfig({
  configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});

/** Page-side fetch for hosts without CORS headers (library downloads). */
export const pageCorsProxyFetch = corsProxyFetch(BROWSER_CORS_PROXY);
