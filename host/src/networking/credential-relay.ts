/**
 * The loopback development relay for signed-in HTTPS traffic
 * (`apps/browser-demos/vite/credential-relay.ts`).
 *
 * It speaks the CORS proxy protocol for a fixed list of HTTPS origins: the
 * request goes to `<url>?url=<target>` with the guest's fields as request
 * fields. A per-process credential grant is its only permission: the kernel
 * worker adds a credential, the proxy opt-in and the grant's tag only for a
 * granted process (`BrowserCorsProxy.fetch`), the app's service worker
 * verifies and removes the tag, and the relay carries a credential only
 * with the opt-in and never with a tag.
 */
export interface CredentialRelayConfig {
  readonly url: string;
  readonly allowedOrigins: readonly string[];
}

export const CREDENTIAL_RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function validateCredentialRelayConfig(value: CredentialRelayConfig): CredentialRelayConfig {
  if (!value || typeof value.url !== 'string' || !Array.isArray(value.allowedOrigins)) {
    throw new TypeError('Invalid credential relay configuration');
  }
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError('Credential relay must be a local HTTP(S) endpoint');
  }
  for (const origin of value.allowedOrigins) {
    const target = new URL(origin);
    if (target.protocol !== 'https:' || target.origin !== origin) {
      throw new TypeError('Credential relay destinations must be exact HTTPS origins');
    }
  }
  return Object.freeze({ url: url.href, allowedOrigins: Object.freeze([...value.allowedOrigins]) });
}

/** Whether the relay, not the CORS proxy, carries requests to `targetUrl`. */
export function credentialRelayCarries(
  config: CredentialRelayConfig | undefined,
  targetUrl: string,
): config is CredentialRelayConfig {
  return config !== undefined &&
    config.allowedOrigins.includes(new URL(targetUrl).origin);
}

/**
 * The relay URL for one target. The app's service worker mirrors this
 * (`credentialRelayFetchUrl` in apps/browser-demos/public/service-worker.js).
 */
export function credentialRelayFetchUrl(
  config: CredentialRelayConfig,
  targetUrl: string,
): string {
  return `${config.url}?url=${encodeURIComponent(targetUrl)}`;
}
