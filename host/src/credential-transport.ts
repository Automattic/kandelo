/**
 * Which intermediary would carry a granted process's credentials
 * (`CredentialRequest.transport`).
 *
 * A credential prompt has to say who besides the destination can read the
 * credentials. In the browser, a granted request never goes to its
 * destination directly: the kernel worker's `BrowserCorsProxy` sends it to
 * the configured CORS proxy, or, on a loopback development server, to the
 * development credential relay for the origins the relay carries
 * (`BrowserCorsProxy.fetch`). Whoever operates that proxy or relay receives
 * the credentials in clear text. Without a proxy, every credentialed request
 * is refused before dispatch (`PROXYLESS_CREDENTIAL_REASON`), so nothing is
 * sent at all. On Node, programs open real sockets and connect directly.
 *
 * The browser plan is computed from the configuration the kernel worker's
 * network backends use, validated the same way, so the prompt cannot name
 * an intermediary other than the one the request would reach.
 */
import type {
  CredentialTransport,
  CredentialTransportPlan,
} from "./credential-grants";
import {
  type BrowserCorsProxyConfig,
  validateBrowserCorsProxyConfig,
} from "./networking/browser-cors-proxy";

/**
 * An endpoint as a prompt names it: origin and path, without the query the
 * proxy protocol appends targets to and without user info. A proxy at the
 * root of its origin is named by its origin.
 */
function endpointName(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

/** Group destinations by leg, in the order each leg first appears. */
function group(
  destinations: readonly string[],
  legFor: (destination: string) => Omit<CredentialTransport, "destinations">,
): CredentialTransport[] {
  const legs = new Map<string, { kind: CredentialTransport["kind"]; via?: string; destinations: string[] }>();
  for (const destination of destinations) {
    const leg = legFor(destination);
    const key = `${leg.kind} ${leg.via ?? ""}`;
    let entry = legs.get(key);
    if (entry === undefined) {
      entry = { ...leg, destinations: [] };
      legs.set(key, entry);
    }
    entry.destinations.push(destination);
  }
  return [...legs.values()];
}

/** The browser kernel worker's plan for its CORS proxy configuration. */
export function browserCredentialTransport(
  corsProxy: BrowserCorsProxyConfig | undefined,
): CredentialTransportPlan {
  const config = validateBrowserCorsProxyConfig(corsProxy);
  if (config === undefined) {
    return (destinations) => group(destinations, () => ({ kind: "none" }));
  }
  const proxy = endpointName(config.url);
  const relay = config.credentialRelay;
  const relayName = relay === undefined ? undefined : endpointName(relay.url);
  return (destinations) => group(destinations, (destination) =>
    // The routing rule `BrowserCorsProxy.fetch` applies.
    relay?.allowedOrigins.includes(new URL(destination).origin)
      ? { kind: "relay", via: relayName }
      : { kind: "proxy", via: proxy }
  );
}

/** Node: programs open real sockets, so every destination is reached directly. */
export const directCredentialTransport: CredentialTransportPlan = (destinations) =>
  group(destinations, () => ({ kind: "direct" }));
