import type { ProxyDatabase } from "./rate-limit.ts";

export const SESSION_HEADER = "X-Kandelo-Proxy-Session";
export const SESSION_KEY_TABLE = "kandelo_cors_proxy_session_key_v1";

/** A quota credential only: it grants neither Space access nor upstream auth. */
export async function guestBucketKey(database: ProxyDatabase, request: Request): Promise<string | Response> {
  const token = request.headers.get(SESSION_HEADER) ?? "";
  const match = /^v1\.([a-f0-9]{32})\.([0-9]{10})\.([a-f0-9]{64})$/.exec(token);
  const challenge = () => new Response(request.method === "HEAD" ? null : "Proxy session required", {
    status: 401, headers: { [SESSION_HEADER]: "required" },
  });
  if (!match || Number(match[2]) <= Math.floor(Date.now() / 1000)) return challenge();
  const result = await database.prepare(`SELECT secret FROM ${SESSION_KEY_TABLE} WHERE id = 1`).all();
  const secret = result.results?.[0]?.secret;
  if (result.success === false || typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Proxy session key unavailable");
  }
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const unsigned = token.slice(0, token.lastIndexOf("."));
  const data = new TextEncoder().encode(`kandelo-cors-proxy\n${new URL(request.url).origin}\n${unsigned}`);
  if (!await crypto.subtle.verify("HMAC", key, bytes(match[3]), data)) return challenge();
  return match[1];
}
