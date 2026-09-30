import {
  BrowserCorsProxy,
  type BrowserCorsProxyConfig,
} from "../../../host/src/networking/browser-cors-proxy";
import type { ArchiveFetch } from "../../../web-libs/kandelo-session/src/internet-archive";

/**
 * A fetch that reaches hosts which send no CORS headers, such as the
 * Internet Archive's download hosts, through the configured CORS proxy.
 *
 * WHY through BrowserCorsProxy rather than a hand-built proxy URL: it owns the
 * proxy's declared request-header surface, including the X-Cors-Proxy-Range
 * alias the production proxy currently needs to see a byte range. A ranged
 * read built any other way would silently come back whole.
 */
export function corsProxyFetch(config: BrowserCorsProxyConfig): ArchiveFetch {
  const proxy = new BrowserCorsProxy(config);
  return (url, init) => proxy.fetch(
    {
      method: init.method ?? "GET",
      headers: [...new Headers(init.headers)],
      targetUrl: url,
    },
    (input, proxied) => globalThis.fetch(input, { ...proxied, signal: init.signal }),
  );
}
