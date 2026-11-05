import { registerHooks } from "node:module";

// Exercise the production import path in Node using real TCP/TLS sockets.
// This hook is test-only; the published worker imports Cloudflare's module.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return { url: new URL("./support/node-sockets.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
