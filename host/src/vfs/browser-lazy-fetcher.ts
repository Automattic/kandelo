import { corsProxyFetchUrl } from "../networking/cors-proxy-url";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type LazyFetch = (
  url: string,
  init?: { signal?: AbortSignal },
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
  corsProxyUrl: string,
  options: {
    fetchImpl?: FetchLike;
    runtimeUrl?: string;
  } = {},
): LazyFetch {
  const fetchImpl = options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init));
  const configuredProxyUrl = corsProxyUrl.trim();
  if (configuredProxyUrl.length === 0) {
    throw new Error("browser lazy CORS proxy URL must not be empty");
  }
  const runtimeUrl = new URL(
    options.runtimeUrl ?? globalThis.location.href,
  );
  const proxyUrl = new URL(configuredProxyUrl, runtimeUrl).href;

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

    // WHY: proxy requests can be same-origin even though the package asset is
    // public. Do not attach the application's cookies or reveal its referrer
    // to an artifact transport selected by VFS metadata.
    return fetchImpl(corsProxyFetchUrl(proxyUrl, target.href), {
      ...(init ?? {}),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  };
}
