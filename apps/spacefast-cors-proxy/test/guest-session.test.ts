import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import handler from "../handler.ts";
import { guestBucketKey, SESSION_HEADER } from "../src/guest-session.ts";
import type { ProxyDatabase } from "../src/rate-limit.ts";
import { createCorsProxy } from "../src/proxy.ts";

const secret = "a1".repeat(32);
const subject = "12".repeat(16);
const origin = "https://proxy.example";
function token(id = subject, audience = origin, expires = Math.floor(Date.now() / 1000) + 3600) {
  const unsigned = `v1.${id}.${expires}`;
  return unsigned + "." + createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`kandelo-cors-proxy\n${audience}\n${unsigned}`).digest("hex");
}
function request(value?: string, method = "GET") {
  return new Request(origin + "/?url=http://127.0.0.1", { method,
    headers: value === undefined ? {} : { [SESSION_HEADER]: value } });
}
function database(result: object = { success: true, results: [{ secret }] }): ProxyDatabase {
  return { prepare(sql) {
    assert.match(sql, /^SELECT secret/);
    return { all: async () => result, bind() { throw new Error("unexpected binding"); } };
  } };
}

test("verified guest quota token is bound to the proxy origin and preserves the identity", async () => {
  assert.equal(await guestBucketKey(database(), request(token())), subject);
  const a = await guestBucketKey(database(), request(token(subject, "https://another.example")));
  assert.equal((a as Response).status, 401);
  const forged = token().slice(0, -64) + "0".repeat(64);
  assert.equal(((await guestBucketKey(database(), request(forged))) as Response).status, 401);
});

test("missing, malformed and expired sessions challenge without querying storage", async () => {
  const db = { prepare() { throw new Error("must not access storage"); } } as ProxyDatabase;
  for (const value of [undefined, "", "guest:anon_" + "1".repeat(32), "v1.arbitrary", token(subject, origin, 1700000000)]) {
    const response = await guestBucketKey(db, request(value)) as Response;
    assert.equal(response.status, 401); assert.equal(response.headers.get(SESSION_HEADER), "required");
    assert.equal(await response.text(), "Proxy session required");
  }
  assert.equal(await (await guestBucketKey(db, request(undefined, "HEAD")) as Response).text(), "");
});

test("missing, malformed or failed signing-key storage fails closed", async () => {
  for (const result of [{}, { results: [] }, { results: [{}] }, { results: [{ secret: 3 }] },
    { results: [{ secret: "bad" }] }, { success: false, results: [{ secret }] }]) {
    await assert.rejects(guestBucketKey(database(result), request(token())), /unavailable/);
  }
  const response = await handler.fetch(request(token()), { DB: database({ success: false }) });
  assert.equal(response.status, 503);
});

test("guest mode ignores forged IP and identity headers; a valid session reaches atomic admission", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: ProxyDatabase = { prepare(sql) {
    let values: unknown[] = [];
    const statement = { bind(...v: unknown[]) { values = v; return statement; }, async all() {
      calls.push({ sql, values });
      return sql.startsWith("SELECT secret") ? { results: [{ secret }] } : { meta: { changes: 1 } };
    } }; return statement;
  } };
  const req = request(token()); req.headers.set("X-Forwarded-For", "1.2.3.4"); req.headers.set("X-Guest-Id", "someone-else");
  assert.equal((await handler.fetch(req, { DB: db })).status, 400);
  assert.deepEqual(calls.at(-1)?.values, [subject]);
  const challenged = await handler.fetch(request(), { DB: db });
  assert.equal(challenged.status, 401);
  assert.equal(challenged.headers.get(SESSION_HEADER), "required");
});

test("quota credentials cannot escape to destinations or be injected by an upstream 401", async () => {
  let fetched = 0;
  const proxy = createCorsProxy({ disableRateLimit: true, fetch: async (_url, init) => {
    fetched++; assert.equal(new Headers(init.headers).has(SESSION_HEADER), false);
    return new Response("upstream denial", { status: 401, headers: { [SESSION_HEADER]: "required" } });
  } });
  const response = await proxy(new Request(origin + "/?url=https://public.example", { headers: { [SESSION_HEADER]: token() } }));
  assert.equal(response.status, 401); assert.equal(response.headers.has(SESSION_HEADER), false);
  assert.equal(fetched, 1);
});
