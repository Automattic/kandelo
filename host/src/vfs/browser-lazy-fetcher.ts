import { corsProxyFetchUrl } from "../networking/cors-proxy-url";
import { fetchWithProxySession } from "../networking/cors-proxy-session";
import type {
  BrowserCorsProxyConfig,
} from "../networking/browser-cors-proxy";
import type { LazyFetch } from "./lazy-download-event";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Build the browser transport for lazy VFS files and archives.
 *
 * Same-origin assets keep the ordinary browser path. External HTTP(S) assets
 * use the configured proxy because lazy materialization must read the response
 * bytes. That requires CORS; CORP can permit embedding under COEP, but it does
 * not make an opaque no-CORS response body readable to JavaScript.
 */
export function createBrowserLazyFetcher(
  corsProxy: BrowserCorsProxyConfig,
  options: {
    fetchImpl?: FetchLike;
    runtimeUrl?: string;
  } = {},
): LazyFetch {
  const fetchImpl = options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));
  const configuredProxyUrl = corsProxy.url.trim();
  if (configuredProxyUrl.length === 0) {
    throw new Error("browser lazy CORS proxy URL must not be empty");
  }
  const runtimeUrl = new URL(
    options.runtimeUrl ?? globalThis.location.href,
  );
  const proxyUrl = new URL(configuredProxyUrl, runtimeUrl).href;
  const proxyCredentials = new URL(proxyUrl).origin === runtimeUrl.origin
    ? "same-origin" : "omit";

  return (url, init) => {
    const target = new URL(url, runtimeUrl);
    const externalHttp =
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.origin !== runtimeUrl.origin;
    if (!externalHttp) {
      return init === undefined
        ? fetchImpl(url)
        : fetchImpl(url, init);
    }

    // The deployment config, not VFS metadata, chooses this proxy. A private
    // same-origin proxy needs the application's session to admit the request;
    // it must strip that cookie before contacting the artifact destination.
    // External proxies receive no browser credentials. Only the application's
    // origin is sent as Referer, for restricted proxy admission.
    return fetchWithProxySession(corsProxyFetchUrl(proxyUrl, target.href), {
      ...(init ?? {}),
      credentials: proxyCredentials,
      referrerPolicy: "strict-origin",
    }, fetchImpl);
  };
}
