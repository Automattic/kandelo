import { createCorsProxy, type ProxyEnvironment } from "./src/proxy.ts";
import { createDatabaseRateLimit } from "./src/rate-limit.ts";

// Spacefast's standalone worker signature. No Node APIs or runtime packages.
const handler = {
  fetch(request: Request, env: ProxyEnvironment): Promise<Response> {
    return createCorsProxy({ env,
      // Spacefast currently rejects pinned TCP egress. The deployment owner
      // explicitly accepts platform-owned DNS resolution and outbound policy.
      // Local URL/literal checks still run, but cannot prevent DNS rebinding.
      fetch: (url, init) => globalThis.fetch(url, init),
      upstreamBodyEncoding: "decoded",
      onUpstreamError: error => console.error("CORS proxy upstream request failed", error),
      rateLimit: env.DB && !["true", "1"].includes(env.CORS_PROXY_DISABLE_RATE_LIMIT ?? "")
        ? createDatabaseRateLimit(env.DB, env) : undefined,
    })(request);
  },
};

/** Spacefast file-router entry, colocated with the static Kandelo build. */
export function corsProxyRoute(request: Request, context: { env: ProxyEnvironment }): Promise<Response> {
  return handler.fetch(request, context.env);
}

export default handler;
