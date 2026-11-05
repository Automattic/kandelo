import { guestBucketKey } from "./guest-session.ts";

/** Spacefast's D1-shaped binding brokers SQL to the Space's MySQL database. */
export interface ProxyDatabase {
  prepare(sql: string): {
    bind(...values: (string | number)[]): { all(): Promise<QueryResult> };
    all(): Promise<QueryResult>;
  };
}
interface QueryResult {
  success?: boolean;
  results?: Record<string, unknown>[];
  meta?: { changes?: number };
}

export const BUCKET_CAPACITY = 1000;
export const REFILL_PER_MINUTE = 100;
export const BUCKET_TABLE = "kandelo_cors_proxy_token_buckets_v1";
export interface RateLimitConfiguration {
  CORS_PROXY_TRUSTED_CLIENT_IP_HEADER?: string;
  CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER?: string;
}

/** Match Playground: individual IPv4 addresses, IPv6 networks of size /64. */
export function clientBucketKey(ip: string): string {
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip)) {
    const octets = ip.split(".").map(Number);
    if (octets.every(octet => octet <= 255)) {
      return "00000000000000000000ffff" + octets.map(n => n.toString(16).padStart(2, "0")).join("");
    }
  } else if (ip.length <= 45 && ip.includes(":") && /^[a-f\d:.]+$/i.test(ip)) {
    // URL validates IPv6 and canonicalizes embedded IPv4 without Node APIs.
    const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right = ""] = host.split("::");
    const front = left ? left.split(":") : [];
    const back = right ? right.split(":") : [];
    const parts = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
    return parts.slice(0, 4).map(part => part.padStart(4, "0")).join("") + "0".repeat(16);
  }
  throw new Error("Invalid rate-limit client IP");
}

function headerName(value: string | undefined): string {
  // Configuration is an assertion that the serving edge overwrites this
  // header on EVERY request and that clients cannot bypass that edge.
  if (!value || !/^[a-z\d-]+$/i.test(value)) throw new Error("Trusted rate-limit header is not configured");
  return value.toLowerCase();
}

/**
 * Playground's whole-token refill policy, backed by an atomic MySQL UPDATE.
 * Verified Spacefast quota sessions are the default identity. A protected
 * ingress header is an explicit alternative. Never trust caller-chosen IDs,
 * isolate-local accounting, or a shared fallback bucket.
 */
export function createDatabaseRateLimit(database: ProxyDatabase,
  config: RateLimitConfiguration = {}): (request: Request) => Promise<Response | void> {
  async function query(sql: string, ...values: (string | number)[]): Promise<QueryResult> {
    const prepared = database.prepare(sql);
    const result = await (values.length ? prepared.bind(...values) : prepared).all();
    if (result.success === false) throw new Error("Rate-limit database query failed");
    return result;
  }
  return async request => {
    const ipHeader = config.CORS_PROXY_TRUSTED_CLIENT_IP_HEADER === undefined
      ? undefined : headerName(config.CORS_PROXY_TRUSTED_CLIENT_IP_HEADER);
    const typeHeader = config.CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER === undefined
      ? undefined : headerName(config.CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER);
    if (ipHeader !== undefined && ipHeader === typeHeader) throw new Error("Rate-limit identity headers must differ");
    const key = ipHeader === undefined ? await guestBucketKey(database, request)
      : clientBucketKey(request.headers.get(ipHeader) ?? "");
    if (key instanceof Response) return key;
    const type = typeHeader ? request.headers.get(typeHeader) : "UNK";
    if (!type || !/^[A-Z]{3}$/.test(type)) throw new Error("Invalid rate-limit proxy classification");
    const denied = (retryAfter?: string) => new Response(request.method === "HEAD" ? null : "Rate limit exceeded",
      { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : undefined });
    // Search-engine classifications get capacity zero in Playground.
    if (type === "SES") return denied();
    await query(`CREATE TABLE IF NOT EXISTS ${BUCKET_TABLE} (client_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, tokens INT NOT NULL, updated_at DATETIME NOT NULL, INDEX (updated_at))`);
    await query(`DELETE FROM ${BUCKET_TABLE} WHERE updated_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`);
    await query(`INSERT IGNORE INTO ${BUCKET_TABLE} (client_key, tokens, updated_at) VALUES (?, ?, NOW())`, key, BUCKET_CAPACITY);
    // Evaluate admission against the locked row. The conditional UPDATE both
    // consumes and reports exactly one token; a later SELECT would race with
    // other clients and falsely reject successful consumers. Refused attempts
    // leave updated_at alone so retrying cannot postpone the next refill.
    const available = `LEAST(${BUCKET_CAPACITY}, tokens + FLOOR(${REFILL_PER_MINUTE} * GREATEST(0, TIMESTAMPDIFF(SECOND, updated_at, NOW())) / 60))`;
    const result = await query(`UPDATE ${BUCKET_TABLE} SET tokens = ${available} - 1, updated_at = GREATEST(updated_at, NOW()) WHERE client_key = ? AND ${available} >= 1`, key);
    const changes = result.meta?.changes;
    if (changes !== 0 && changes !== 1) throw new Error("Invalid rate-limit database result");
    if (changes === 0) return denied("1");
  };
}
