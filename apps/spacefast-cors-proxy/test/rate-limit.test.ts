import assert from "node:assert/strict";
import { test } from "node:test";
import handler, { corsProxyRoute } from "../handler.ts";
import { createDatabaseRateLimit, REQUESTS_PER_MINUTE, type ProxyDatabase } from "../src/rate-limit.ts";

function database() {
  const counters = new Map<number, number>();
  const state = { window: 1000, counters, calls: [] as { sql: string; values: number[] }[],
    failAt: 0, rejectAt: 0, clockValue: undefined as unknown, countValue: undefined as unknown,
    currentWindow: undefined as number | undefined };
  const DB: ProxyDatabase = {
    prepare(sql) {
      let values: number[] = [];
      const prepared = {
        bind(...bound: number[]) { values = bound; return prepared; },
        async all() {
          state.calls.push({ sql, values });
          if (state.calls.length === state.rejectAt) throw new Error("database down");
          if (state.calls.length === state.failAt) return { success: false };
          if (sql.startsWith("CREATE TABLE")) return { success: true };
          if (sql.startsWith("SELECT FLOOR")) {
            return { results: [{ window_id: state.clockValue ?? state.window }] };
          }
          if (sql.startsWith("INSERT INTO")) {
            assert.match(sql, /ON DUPLICATE KEY UPDATE request_count = request_count \+ 1$/);
            counters.set(values[0], (counters.get(values[0]) ?? 0) + 1);
            return { success: true };
          }
          if (sql.startsWith("SELECT request_count")) {
            return { results: [{ request_count: state.countValue ?? counters.get(values[0]),
              current_window: state.currentWindow ?? state.window }] };
          }
          assert.match(sql, /^DELETE FROM .* WHERE window_id < \?$/);
          for (const window of counters.keys()) if (window < values[0]) counters.delete(window);
          return { success: true };
        },
      };
      return prepared;
    },
  };
  return { state, DB };
}

test("durable budget is shared by separate handlers and resets on the database's minute", async () => {
  const { state, DB } = database();
  const request = new Request("https://proxy.example/cors-proxy?url=http%3A%2F%2F127.0.0.1");
  for (let i = 0; i < REQUESTS_PER_MINUTE; i++) {
    assert.equal((await handler.fetch(request, { DB })).status, 400);
  }
  const denied = await corsProxyRoute(request, { env: { DB } });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.equal(await denied.text(), "Too Many Requests");
  state.window++;
  assert.equal(await createDatabaseRateLimit(DB)(), undefined);
  assert.equal(state.counters.size, 2);
  state.window++;
  assert.equal(await createDatabaseRateLimit(DB)(), undefined);
  assert.equal(state.counters.size, 2);
  assert.ok(!state.counters.has(1000));
});

test("concurrent isolates cannot exceed the remaining shared budget", async () => {
  const { state, DB } = database();
  state.counters.set(state.window, REQUESTS_PER_MINUTE - 5);
  const results = await Promise.all(Array.from({ length: 16 }, () => createDatabaseRateLimit(DB)()));
  assert.ok(results.filter(result => result === undefined).length <= 5);
  assert.equal(state.counters.get(state.window), REQUESTS_PER_MINUTE + 11);
});

test("a delayed request cannot use an expired window's budget", async () => {
  const { state, DB } = database(); state.currentWindow = state.window + 2;
  assert.equal((await createDatabaseRateLimit(DB)())?.status, 429);
});

test("database failures at every query fail closed through the deployed entry", async () => {
  for (const kind of ["failAt", "rejectAt"] as const) {
    for (let stage = 1; stage <= 5; stage++) {
      const { state, DB } = database(); state[kind] = stage;
      const response = await handler.fetch(new Request("https://proxy.example/cors-proxy"), { DB });
      assert.equal(response.status, 503);
      assert.equal(await response.text(), "Rate limiter unavailable");
    }
  }
});

test("malformed and missing database results cannot admit traffic", async () => {
  for (const value of ["abc", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, {}]) {
    const { state, DB } = database(); state.clockValue = value;
    await assert.rejects(createDatabaseRateLimit(DB)(), /Invalid/);
  }
  for (const value of ["abc", -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { state, DB } = database(); state.countValue = value;
    await assert.rejects(createDatabaseRateLimit(DB)(), /Invalid/);
  }
  const missing: ProxyDatabase = { prepare() { return { all: async () => ({}), bind() { throw new Error("not reached"); } }; } };
  await assert.rejects(createDatabaseRateLimit(missing)(), /Invalid/);
  const { state, DB } = database(); state.clockValue = "1000"; state.countValue = "1";
  assert.equal(await createDatabaseRateLimit(DB)(), undefined);
});

test("explicit operator opt-out bypasses the database; OPTIONS always avoids it", async () => {
  const { state, DB } = database(); state.rejectAt = 1;
  for (const value of ["true", "1"]) {
    const response = await handler.fetch(new Request("https://proxy.example/cors-proxy"),
      { DB, CORS_PROXY_DISABLE_RATE_LIMIT: value });
    assert.equal(response.status, 400);
  }
  assert.equal((await corsProxyRoute(new Request("https://proxy.example/cors-proxy", { method: "OPTIONS" }),
    { env: { DB } })).status, 204);
  assert.equal(state.calls.length, 0);
});
