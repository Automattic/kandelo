/** Execute the shipped PHP identity bridge and its SQL, with line coverage. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mysql } from "../../signalling/spacefast/test/mysql.ts";
import { buildSessionRoute } from "../build-options.mjs";
import { guestBucketKey, SESSION_KEY_TABLE } from "../src/guest-session.ts";
import { createDatabaseRateLimit, BUCKET_TABLE } from "../src/rate-limit.ts";

const execute = promisify(execFile);
const origin = "https://proxy.example";
const guest = (n = "1") => ({ userId: "guest:anon_" + n.repeat(32), isGuest: true, isAuthenticated: false });

test("native PHP issues verified quota sessions; real SQL budgets survive renewal and concurrent clients", { timeout: 60000 }, async t => {
  const sql = await mysql(); t.after(() => sql.close());
  const root = await mkdtemp(join(tmpdir(), "kproxy-php-")); t.after(() => rm(root, { recursive: true, force: true }));
  await buildSessionRoute(root, ["https://kandelo.dev", origin]);
  const source = await realpath(join(root, "functions/cors-proxy-session.php"));
  const broker = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const { statement, values } = JSON.parse(body);
      res.end(JSON.stringify(await sql.query(statement, values)));
    } catch { res.writeHead(503); res.end('{}'); }
  });
  broker.listen(0, "127.0.0.1"); await once(broker, "listening");
  t.after(() => new Promise<void>(r => broker.close(() => r())));
  const brokerUrl = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  const wrapper = join(root, "run.php");
  await writeFile(wrapper, `<?php
$input = json_decode(file_get_contents($argv[1]), true);
$_SERVER = $input['server'];
function sf_auth() { global $input; if ($input['authError'] ?? false) throw new RuntimeException('auth down'); return $input['auth']; }
function sf_json($value, $status=200) { http_response_code($status); echo json_encode($value); finish(); exit; }
function sf_db() { return new TestDb(); }
class TestDb {
  function send($statement, $values=[]) {
    global $input;
    if (str_starts_with($statement, $input['failSql'] ?? 'NEVER')) throw new RuntimeException('SQL unavailable');
    $body = file_get_contents(${JSON.stringify(brokerUrl)}, false, stream_context_create(['http'=>['method'=>'POST','header'=>'Content-Type: application/json','content'=>json_encode(compact('statement','values'))]]));
    if ($body === false) throw new RuntimeException('broker unavailable');
    return json_decode($body, true);
  }
  function execute($statement,$values=[]) { return $this->send($statement,$values); }
  function query($statement,$values=[]) { global $input; if (array_key_exists('keyRows',$input)) return $input['keyRows']; return $this->send($statement,$values)['results']; }
}
function finish() {
  $body = ob_get_clean(); $hits = phpdbg_end_oplog();
  $executable = phpdbg_get_executable(['files'=>[${JSON.stringify(source)}]]);
  echo json_encode(['status'=>http_response_code() ?: 200,'body'=>$body,'hits'=>$hits[${JSON.stringify(source)}] ?? [],'executable'=>$executable[${JSON.stringify(source)}] ?? []]);
}
ob_start(); phpdbg_start_oplog();
require ${JSON.stringify(source)};
finish();
`);
  const hits = new Set<number>(), executable = new Set<number>(); let sequence = 0;
  async function run(overrides: Record<string, unknown> = {}, server: Record<string, unknown> = {}) {
    const input = join(root, `case-${sequence++}.json`);
    await writeFile(input, JSON.stringify({ auth: guest(), ...overrides,
      server: { HTTP_HOST: "proxy.example", HTTPS: "on", REQUEST_METHOD: "GET", HTTP_REFERER: "https://kandelo.dev/app", HTTP_ORIGIN: "https://kandelo.dev", ...server } }));
    const { stdout } = await execute(join(sql.tools, "bin/phpdbg"), ["-qrr", wrapper, input]);
    const result = JSON.parse(stdout);
    for (const line of Object.keys(result.hits)) hits.add(Number(line));
    for (const line of Object.keys(result.executable)) executable.add(Number(line));
    return { status: result.status as number, body: result.body ? JSON.parse(result.body) : undefined };
  }
  function request(token: string) { return new Request(origin + "/cors-proxy", { headers: { "X-Kandelo-Proxy-Session": token } }); }
  let first: string;
  await t.test("guest renewal keeps one budget; another guest and signed-in accounts get their own", async () => {
    const a = await run(); assert.equal(a.status, 200); first = a.body.token;
    assert.ok(!first.includes("guest:"));
    const key = await guestBucketKey(sql.db, request(first)); assert.equal(typeof key, "string");
    const limit = createDatabaseRateLimit(sql.db);
    assert.equal(await limit(request(first)), undefined);
    const renewed = await run(); assert.equal(renewed.status, 200);
    assert.equal(await guestBucketKey(sql.db, request(renewed.body.token)), key);
    const others = [guest("2"), { userId: "account:test-user", isGuest: false, isAuthenticated: true }];
    for (const auth of others) {
      const other = await run({ auth }); assert.equal(other.status, 200);
      assert.notEqual(await guestBucketKey(sql.db, request(other.body.token)), key);
    }
    await sql.query(`UPDATE ${BUCKET_TABLE} SET tokens = 5, updated_at = DATE_ADD(NOW(), INTERVAL 10 SECOND) WHERE client_key = ?`, [key as string]);
    const responses = await Promise.all(Array.from({ length: 16 }, () => createDatabaseRateLimit(sql.db)(request(renewed.body.token))));
    assert.equal(responses.filter(r => r === undefined).length, 5);
    assert.equal(responses.filter(r => r?.status === 429).length, 11);
  });
  await t.test("concurrent bootstrap cannot choose a different signing key or reset the same identity", async () => {
    await sql.query(`DELETE FROM ${SESSION_KEY_TABLE}`);
    const responses = await Promise.all(Array.from({ length: 8 }, () => run()));
    assert.equal((await guestBucketKey(sql.db, request(first)) as Response).status, 401);
    const expected = await guestBucketKey(sql.db, request(responses[0].body.token));
    for (const response of responses) assert.equal(await guestBucketKey(sql.db, request(response.body.token)), expected);
  });
  await t.test("anonymous, missing, malformed and fallback identities fail closed", async () => {
    for (const auth of [{}, { userId: 3 }, { ...guest(), userId: "guest:local" },
      { ...guest(), userId: "guest:forged" }, { userId: "x", isGuest: false, isAuthenticated: false },
      { userId: "", isAuthenticated: true }, { userId: "x".repeat(257), isAuthenticated: true },
      { userId: "guest:anon_" + "1".repeat(32), isAuthenticated: true }]) {
      assert.equal((await run({ auth })).status, 503);
    }
    assert.equal((await run({ authError: true })).status, 503);
  });
  await t.test("database/key failures never return a token or exception details", async () => {
    for (const overrides of [{ failSql: "CREATE" }, { failSql: "INSERT" }, { failSql: "SELECT" },
      { keyRows: [] }, { keyRows: [{ secret: 3 }] }, { keyRows: [{ secret: "bad" }] }]) {
      assert.deepEqual(await run(overrides), { status: 503, body: { error: "Proxy session unavailable" } });
    }
  });
  await t.test("Referer/Origin rules and preflight protect session issuance too", async () => {
    for (const server of [{ HTTP_REFERER: null }, { HTTP_REFERER: "not a URL" },
      { HTTP_REFERER: "file:///x" }, { HTTP_REFERER: "https://user@kandelo.dev/" },
      { HTTP_REFERER: "https://:pass@kandelo.dev/" }, { HTTP_REFERER: "https://kandelo.dev/#fragment" },
      { HTTP_REFERER: "https://evil.example/" }, { HTTP_ORIGIN: "https://evil.example" },
      { HTTP_REFERER: "https://proxy.example/" }, { HTTP_REFERER: "https://kandelo.dev:444/" }]) {
      assert.equal((await run({}, server)).status, 403);
    }
    assert.equal((await run({}, { REQUEST_METHOD: "OPTIONS", HTTP_REFERER: null })).status, 204);
    assert.equal((await run({}, { REQUEST_METHOD: "OPTIONS" })).status, 204);
    assert.equal((await run({}, { REQUEST_METHOD: "OPTIONS", HTTP_ORIGIN: null })).status, 403);
    assert.equal((await run({}, { REQUEST_METHOD: "OPTIONS", HTTP_REFERER: "https://proxy.example/" })).status, 403);
    assert.equal((await run({}, { REQUEST_METHOD: "POST" })).status, 405);
    assert.equal((await run({}, { HTTP_ORIGIN: null })).status, 200);
    assert.equal((await run({}, { HTTP_REFERER: "https://kandelo.dev:443/" })).status, 200);
    assert.equal((await run({}, { HTTP_REFERER: "http://kandelo.dev:80/" })).status, 403);
    // Same-origin default for a combined app, without a baked allowlist.
    await buildSessionRoute(root, []);
    assert.equal((await run({}, { HTTP_REFERER: origin + "/", HTTP_ORIGIN: origin })).status, 200);
    assert.equal((await run({}, { HTTPS: "off", HTTP_REFERER: "http://proxy.example/", HTTP_ORIGIN: "http://proxy.example" })).status, 200);
  });
  const missing = [...executable].filter(line => !hits.has(line));
  assert.ok(executable.size > 30, "PHP coverage must include the actual session route");
  assert.deepEqual(missing, [], `Uncovered executable PHP lines: ${missing.join(", ")}\n${await readFile(source, "utf8")}`);
  t.diagnostic(`PHP session bridge: ${executable.size}/${executable.size} executable lines covered`);
});
