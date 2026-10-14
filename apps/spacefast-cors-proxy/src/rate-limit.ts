/** Spacefast's D1-shaped binding brokers SQL to the Space's MySQL database. */
export interface ProxyDatabase {
  prepare(sql: string): {
    bind(...values: number[]): { all(): Promise<QueryResult> };
    all(): Promise<QueryResult>;
  };
}
interface QueryResult {
  success?: boolean;
  results?: Record<string, unknown>[];
}

export const REQUESTS_PER_MINUTE = 600;
const TABLE = "kandelo_cors_proxy_rate_limits";

function integer(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("Invalid rate-limit database result");
  }
  return number;
}

/**
 * A Space-wide fixed-window budget, shared across worker isolates. Concurrent
 * reads can conservatively deny an earlier increment; they cannot admit more
 * than the budget because each admission first increments a monotonic counter.
 */
export function createDatabaseRateLimit(database: ProxyDatabase): () => Promise<Response | void> {
  async function query(sql: string, ...values: number[]): Promise<QueryResult> {
    const prepared = database.prepare(sql);
    const result = await (values.length ? prepared.bind(...values) : prepared).all();
    if (result.success === false) throw new Error("Rate-limit database query failed");
    return result;
  }
  return async () => {
    await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (window_id BIGINT PRIMARY KEY, request_count BIGINT NOT NULL)`);
    // Use the database clock, so skew between isolates cannot multiply budgets.
    const clock = await query("SELECT FLOOR(UNIX_TIMESTAMP() / 60) AS window_id");
    const window = integer(clock.results?.[0]?.window_id);
    await query(`INSERT INTO ${TABLE} (window_id, request_count) VALUES (?, 1) ON DUPLICATE KEY UPDATE request_count = request_count + 1`, window);
    const counter = await query(`SELECT request_count, FLOOR(UNIX_TIMESTAMP() / 60) AS current_window FROM ${TABLE} WHERE window_id = ?`, window);
    const count = integer(counter.results?.[0]?.request_count);
    const currentWindow = integer(counter.results?.[0]?.current_window);
    if (count === 0) throw new Error("Invalid rate-limit counter");
    // Retain the preceding window for requests straddling the minute boundary.
    await query(`DELETE FROM ${TABLE} WHERE window_id < ?`, window - 1);
    if (count > REQUESTS_PER_MINUTE || currentWindow !== window) {
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "60" } });
    }
  };
}
