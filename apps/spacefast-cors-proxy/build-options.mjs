import { parseApprovedRefererOrigins } from "./src/request-policy.ts";

export function buildOptions(args, { site = false } = {}) {
  const origins = [];
  let source;
  let withoutProxy = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-referer") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--allow-referer needs an origin");
      const value = args[++i];
      if (parseApprovedRefererOrigins(value).length !== 1) throw new Error("--allow-referer needs one origin");
      origins.push(value);
    } else if (site && args[i] === "--without-proxy") {
      withoutProxy = true;
    } else if (site && !args[i].startsWith("--") && source === undefined) {
      source = args[i];
    } else throw new Error(`Unexpected build argument: ${args[i]}`);
  }
  const approved = parseApprovedRefererOrigins(origins.join(" "));
  if (approved.length !== origins.length) throw new Error("Each --allow-referer needs one distinct origin");
  if (!site && approved.length === 0) throw new Error("Standalone proxy needs at least one --allow-referer origin");
  if (withoutProxy && approved.length) throw new Error("--allow-referer cannot be used with --without-proxy");
  return { source, approved, withoutProxy };
}

export function proxyEntry(approved, { route = false } = {}) {
  if (route && approved.length === 0) return 'export { corsProxyRoute as default } from "./handler.ts";';
  const settings = JSON.stringify({ CORS_PROXY_ALLOWED_REFERER_ORIGINS: approved.join(" ") });
  // Build-selected origins take precedence over runtime env, so a packaged
  // restricted proxy cannot silently revert to its legacy CORS-only mode.
  const fetch = `handler.fetch(request, { ...env, ...${settings} })`;
  return `import handler from "./handler.ts";\n` + (route
    ? `export default (request, { env }) => ${fetch};\n`
    : `export default { fetch: (request, env) => ${fetch} };\n`);
}
