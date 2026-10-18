import assert from "node:assert/strict";
import { test } from "node:test";
import handler, { corsProxyRoute } from "../handler.ts";
import { createDatabaseRateLimit, clientBucketKey, BUCKET_CAPACITY, REFILL_PER_MINUTE,
  type ProxyDatabase } from "../src/rate-limit.ts";

const config = { CORS_PROXY_TRUSTED_CLIENT_IP_HEADER: "X-Trusted-IP" };
const classified = { ...config, CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER: "X-Trusted-Type" };
const request = (ip = "192.0.2.1", type?: string, method = "GET") =>
  new Request("https://proxy.example/cors-proxy?url=http%3A%2F%2F127.0.0.1", {
    method, headers: { "X-Trusted-IP": ip, ...(type ? { "X-Trusted-Type": type } : {}) },
  });

function database() {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const state = { now: 1000, buckets, calls: [] as { sql: string; values: (string | number)[] }[],
    failAt: 0, rejectAt: 0, changes: undefined as unknown };
  const DB: ProxyDatabase = {
    prepare(sql) {
      let values: (string | number)[] = [];
      const prepared = {
        bind(...bound: (string | number)[]) { values = bound; return prepared; },
        async all() {
          state.calls.push({ sql, values });
          if (state.calls.length === state.rejectAt) throw new Error("database down");
          if (state.calls.length === state.failAt) return { success: false };
          if (sql.startsWith("CREATE TABLE")) return { success: true };
          if (sql.startsWith("DELETE FROM")) {
            for (const [key, row] of buckets) if (row.updated < state.now - 86400) buckets.delete(key);
            return { success: true };
          }
          const key = String(values[0]);
          if (sql.startsWith("INSERT IGNORE")) {
            if (!buckets.has(key)) buckets.set(key, { tokens: Number(values[1]), updated: state.now });
            return { success: true };
          }
          assert.match(sql, /^UPDATE .* WHERE client_key = \? AND .* >= 1$/);
          const row = buckets.get(key)!;
          const available = Math.min(BUCKET_CAPACITY, row.tokens + Math.floor(REFILL_PER_MINUTE * Math.max(0, state.now - row.updated) / 60));
          const changes = available > 0 ? 1 : 0;
          if (changes) { row.tokens = available - 1; row.updated = Math.max(row.updated, state.now); }
          return { meta: { changes: state.changes === undefined ? changes : state.changes as number } };
        },
      };
      return prepared;
    },
  };
  return { state, DB };
}

test("Playground capacity/refill and canonical IPv4/IPv6 /64 identities", () => {
  assert.equal(BUCKET_CAPACITY, 1000); assert.equal(REFILL_PER_MINUTE, 100);
  assert.equal(clientBucketKey("192.0.2.1"), "00000000000000000000ffffc0000201");
  assert.notEqual(clientBucketKey("192.0.2.1"), clientBucketKey("192.0.2.2"));
  for (const value of ["2001:db8:ABCD:1234::1", "2001:0db8:abcd:1234:ffff:ffff:ffff:ffff"])
    assert.equal(clientBucketKey(value), "20010db8abcd12340000000000000000");
  assert.notEqual(clientBucketKey("2001:db8:abcd:1234::1"), clientBucketKey("2001:db8:abcd:1235::1"));
  assert.equal(clientBucketKey("::"), "0".repeat(32));
  assert.equal(clientBucketKey("1:2:3:4:5:6:7:8"), "00010002000300040000000000000000");
  assert.equal(clientBucketKey("1:2:3:4:5:6:192.0.2.1"), "00010002000300040000000000000000");
  // Playground treats an IPv6-mapped input as IPv6 and groups its /64.
  assert.equal(clientBucketKey("::ffff:192.0.2.1"), "0".repeat(32));
  for (const ip of ["", "192.000.2.1", "256.1.2.3", "1.2.3", "0x7f000001", "2130706433", "example.com",
    "192.0.2.1, 192.0.2.2", "192.0.2.1:80", "[::1]", "fe80::1%en0", "::1/64", "::::", "::gg", "1:".repeat(30)])
    assert.throws(() => clientBucketKey(ip));
});

test("independent handlers share 1000 burst tokens per client, not one Space-wide budget", async () => {
  const { state, DB } = database();
  for (let i = 0; i < BUCKET_CAPACITY; i++) assert.equal((await handler.fetch(request(), { DB, ...config })).status, 400);
  const denied = await corsProxyRoute(request(), { env: { DB, ...config } });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get("retry-after"), "1");
  assert.equal(await denied.text(), "Rate limit exceeded");
  assert.equal((await handler.fetch(request("192.0.2.2"), { DB, ...config })).status, 400);
  assert.equal(state.buckets.size, 2);
});

test("whole-second refill matches Playground, denied retries don't postpone it, idle buckets cap and expire", async () => {
  const { state, DB } = database(); const limit = createDatabaseRateLimit(DB, config);
  const key = clientBucketKey("192.0.2.1");
  state.buckets.set(key, { tokens: 0, updated: state.now });
  for (let i = 0; i < 4; i++) assert.equal((await limit(request()))?.status, 429);
  state.now++;
  assert.equal(await limit(request()), undefined);
  assert.equal((await limit(request()))?.status, 429);
  state.now += 60;
  assert.equal(await limit(request()), undefined); assert.equal(state.buckets.get(key)?.tokens, 99);
  state.now += 10000;
  assert.equal(await limit(request()), undefined); assert.equal(state.buckets.get(key)?.tokens, 999);
  state.buckets.set("old", { tokens: 0, updated: state.now - 86401 });
  state.buckets.set("recent", { tokens: 0, updated: state.now - 86400 });
  await limit(request()); assert.ok(!state.buckets.has("old")); assert.ok(state.buckets.has("recent"));
});

test("IPv6 addresses in one /64 share a bucket; neighboring subnets do not", async () => {
  const { state, DB } = database(); const limit = createDatabaseRateLimit(DB, config);
  state.buckets.set(clientBucketKey("2001:db8::1"), { tokens: 0, updated: state.now });
  assert.equal((await limit(request("2001:db8::abcd")))?.status, 429);
  assert.equal(await limit(request("2001:db8:0:1::abcd")), undefined);
});

test("atomic consumption admits exactly the available tokens across concurrent isolates", async () => {
  const { state, DB } = database();
  state.buckets.set(clientBucketKey("192.0.2.1"), { tokens: 5, updated: state.now });
  const results = await Promise.all(Array.from({ length: 16 }, () => createDatabaseRateLimit(DB, config)(request())));
  assert.equal(results.filter(result => result === undefined).length, 5);
  assert.equal(state.buckets.get(clientBucketKey("192.0.2.1"))?.tokens, 0);
});

test("SES is denied and all other Playground classifications use the default budget", async () => {
  const { state, DB } = database(); const limit = createDatabaseRateLimit(DB, classified);
  const searchEngine = await limit(request("192.0.2.1", "SES"));
  assert.equal(searchEngine?.status, 429); assert.equal(searchEngine?.headers.has("retry-after"), false);
  assert.equal(state.calls.length, 0);
  assert.equal(await (await limit(request("192.0.2.1", "SES", "HEAD")))?.text(), "");
  for (const type of ["VPN", "TOR", "PUB", "WEB", "UNK", "DCH", "RES"])
    assert.equal(await limit(request("192.0.2.1", type)), undefined);
});

test("unknown ingress identity fails closed and arbitrary forwarded headers cannot choose buckets", async () => {
  const { state, DB } = database();
  const forged = new Request("https://proxy.example/cors-proxy", { headers: { "X-Forwarded-For": "192.0.2.1", "CF-Connecting-IP": "192.0.2.2" } });
  for (const settings of [{}, config, { CORS_PROXY_TRUSTED_CLIENT_IP_HEADER: "" },
    { CORS_PROXY_TRUSTED_CLIENT_IP_HEADER: "bad header" }, { ...config, CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER: "" },
    { ...config, CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER: "X-Trusted-IP" }]) {
    assert.equal((await handler.fetch(forged, { DB, ...settings })).status, 503);
  }
  for (const type of [undefined, "ses", "BAD,SES", "", "TOOLONG"])
    assert.equal((await handler.fetch(request("192.0.2.1", type), { DB, ...classified })).status, 503);
  assert.equal(state.calls.length, 0);
  for (const ip of ["", "192.0.2.1, 192.0.2.2", "not-an-ip"])
    assert.equal((await handler.fetch(request(ip), { DB, ...config })).status, 503);
  assert.equal(state.calls.length, 0);
});

test("database failures and malformed affected-row metadata fail closed", async () => {
  for (const kind of ["failAt", "rejectAt"] as const) {
    for (let stage = 1; stage <= 4; stage++) {
      const { state, DB } = database(); state[kind] = stage;
      const response = await handler.fetch(request(), { DB, ...config });
      assert.equal(response.status, 503); assert.equal(await response.text(), "Rate limiter unavailable");
    }
  }
  for (const changes of ["1", null, -1, 0.5, 2, NaN, {}]) {
    const { state, DB } = database(); state.changes = changes;
    assert.equal((await handler.fetch(request(), { DB, ...config })).status, 503);
  }
  const missing: ProxyDatabase = { prepare() { return { all: async () => ({}), bind() { return this; } }; } };
  await assert.rejects(createDatabaseRateLimit(missing, config)(request()), /Invalid/);
});

test("operator opt-out and OPTIONS still avoid the database and identity requirement", async () => {
  const { state, DB } = database(); state.rejectAt = 1;
  for (const value of ["true", "1"]) assert.equal((await handler.fetch(request(), { DB, CORS_PROXY_DISABLE_RATE_LIMIT: value })).status, 400);
  assert.equal((await corsProxyRoute(new Request("https://proxy.example/cors-proxy", { method: "OPTIONS" }), { env: { DB } })).status, 204);
  assert.equal(state.calls.length, 0);
});
