/** Exercise the production SQL against MySQL-compatible storage, not a SQL mock. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mysql } from "../../signalling/spacefast/test/mysql.ts";
import { createDatabaseRateLimit, BUCKET_TABLE, clientBucketKey,
  type ProxyDatabase } from "../src/rate-limit.ts";

const config = { CORS_PROXY_TRUSTED_CLIENT_IP_HEADER: "X-Trusted-IP" };
const request = (ip = "192.0.2.1") => new Request("https://proxy.example/", { headers: { "X-Trusted-IP": ip } });

test("production MySQL bucket SQL enforces Playground policy and concurrent admission", { timeout: 60000 }, async t => {
  const sql = await mysql(); t.after(() => sql.close());
  let now = 1700000000;
  // SET timestamp controls the actual database clock for each fresh broker
  // connection, without adding an injectable clock to production code.
  const db: ProxyDatabase = { prepare(statement) {
    const run = (values: (string | number)[] = []) => sql.query(`SET timestamp = ${now}; ${statement}`, values);
    return { all: () => run(), bind: (...values) => ({ all: () => run(values) }) };
  } };
  const limit = () => createDatabaseRateLimit(db, config);
  async function tokens(ip = "192.0.2.1") {
    const result = await sql.query(`SELECT tokens, UNIX_TIMESTAMP(updated_at) AS updated FROM ${BUCKET_TABLE} WHERE client_key = ?`, [clientBucketKey(ip)]);
    return result.results![0];
  }
  await t.test("first request starts at 1000; each address has its own budget", async () => {
    assert.equal(await limit()(request()), undefined);
    assert.equal(Number((await tokens()).tokens), 999);
    assert.equal(await limit()(request("192.0.2.2")), undefined);
    assert.equal(Number((await tokens("192.0.2.2")).tokens), 999);
  });
  await t.test("concurrent first requests initialize only one full bucket", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, () => limit()(request("192.0.2.3"))));
    assert.ok(results.every(result => result === undefined));
    assert.equal(Number((await tokens("192.0.2.3")).tokens), 984);
  });
  await t.test("locked conditional UPDATE admits exactly five of 32 concurrent consumers", async () => {
    await sql.query(`UPDATE ${BUCKET_TABLE} SET tokens = 5 WHERE client_key = ?`, [clientBucketKey("192.0.2.1")]);
    const results = await Promise.all(Array.from({ length: 32 }, () => limit()(request())));
    assert.equal(results.filter(value => value === undefined).length, 5);
    assert.equal(results.filter(value => value?.status === 429).length, 27);
    assert.equal(Number((await tokens()).tokens), 0);
  });
  await t.test("denied retries preserve refill time; one second yields one whole token", async () => {
    assert.equal((await limit()(request()))?.status, 429);
    assert.equal(Number((await tokens()).updated), now);
    now++;
    assert.equal(await limit()(request()), undefined);
    assert.equal((await limit()(request()))?.status, 429);
    assert.equal(Number((await tokens()).tokens), 0);
  });
  await t.test("60 seconds refills 100 tokens, capped at capacity after an idle period", async () => {
    now += 60; assert.equal(await limit()(request()), undefined);
    assert.equal(Number((await tokens()).tokens), 99);
    now += 10000; assert.equal(await limit()(request()), undefined);
    assert.equal(Number((await tokens()).tokens), 999);
  });
  await t.test("clock going backward cannot mint tokens or move the refill timestamp back", async () => {
    const previous = now; now -= 100;
    assert.equal(await limit()(request()), undefined);
    assert.equal(Number((await tokens()).tokens), 998);
    assert.equal(Number((await tokens()).updated), previous); now = previous;
  });
  await t.test("IPv6 /64 aliases share tokens; other networks remain independent", async () => {
    assert.equal(await limit()(request("2001:db8:1234:5678::1")), undefined);
    assert.equal(await limit()(request("2001:0db8:1234:5678:ffff:ffff:ffff:ffff")), undefined);
    assert.equal(Number((await tokens("2001:db8:1234:5678::1")).tokens), 998);
    assert.equal(await limit()(request("2001:db8:1234:5679::1")), undefined);
    assert.equal(Number((await tokens("2001:db8:1234:5679::1")).tokens), 999);
  });
  await t.test("buckets older than a day expire; no unbounded minute rows remain", async () => {
    now += 86401;
    assert.equal(await limit()(request()), undefined);
    const rows = await sql.query(`SELECT COUNT(*) AS count FROM ${BUCKET_TABLE}`);
    assert.equal(Number(rows.results![0].count), 1);
    assert.equal(Number((await tokens()).tokens), 999);
  });
});
