export const DEFAULT_CORS_PROXY_URL = "https://wordpress-playground-cors-proxy.net/?";

export function resolveCorsProxyUrl(envUrl?: string): string {
  const trimmed = envUrl?.trim();
  return trimmed || DEFAULT_CORS_PROXY_URL;
}

export function browserCorsProxyUrl(): string {
  return resolveCorsProxyUrl(import.meta.env.VITE_CORS_PROXY_URL as string | undefined);
}

export function corsProxyFetchUrl(targetUrl: string, proxyUrl = browserCorsProxyUrl()): string {
  const trimmedProxyUrl = proxyUrl.trim();
  if (targetUrl.startsWith(trimmedProxyUrl)) {
    return targetUrl;
  }
  const proxiedTarget = trimmedProxyUrl.endsWith("?")
    ? targetUrl
    : encodeURIComponent(targetUrl);
  return `${trimmedProxyUrl}${proxiedTarget}`;
}
