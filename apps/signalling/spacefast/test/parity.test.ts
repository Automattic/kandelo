/** One HTTP scenario against the existing PHP file and the real SQL worker. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSignallingHandler } from "../handler.ts";
import { createDatabaseStore } from "../store.ts";
import { mysql } from "./mysql.ts";
async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p;
}
test("PHP and Spacefast implementations have the same HTTP session/room contract", async t => {
  const sql = await mysql(); t.after(() => sql.close());
  const root = await mkdtemp(join(tmpdir(), "kphp-")); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "piplet.php"); await copyFile(fileURLToPath(new URL("../../piplet.php", import.meta.url)), source);
  const phpPort = await freePort(); const php = spawn(join(sql.tools, "bin/php"), ["-S", `127.0.0.1:${phpPort}`, source], { stdio: "ignore" });
  t.after(async () => { php.kill(); await once(php, "exit"); });
  const reference = `http://127.0.0.1:${phpPort}/`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(reference + "?session=probe")).status === 404) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(ready, "PHP reference ready");
  const handler = createSignallingHandler(createDatabaseStore(sql.db));
  const server = httpServer(async (req, res) => {
    const r = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as any, ...(req.method === "POST" ? { body: Readable.toWeb(req) as any, duplex: "half" } : {}) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(r => server.close(() => r())));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const room = "roomtokenroomtokenroom", key = "hostkeyhostkeyhostkeyhost", joinA = "joinaaaaaaaaaaaaaaaaaaaa", joinB = "joinbbbbbbbbbbbbbbbbbbbb";
  const stripCreated = (_k: string, v: any) => _k === "created" ? 0 : v;
  async function compare(query: string, method = "GET", body?: string, hostKey?: string) {
    const init = { method, body, headers: hostKey ? { "X-Kandelo-Host-Key": hostKey } : {} };
    const [a, b] = await Promise.all([fetch(reference + "?" + query, init), fetch(target + "?" + query, init)]);
    assert.equal(b.status, a.status, query);
    for (const h of ["content-type", "cache-control", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "cross-origin-resource-policy", "allow", "retry-after"]) assert.equal(b.headers.get(h), a.headers.get(h), query + ": " + h);
    const [av, bv] = await Promise.all([a.text(), b.text()]);
    if (av) assert.deepEqual(JSON.parse(bv, stripCreated), JSON.parse(av, stripCreated), query);
    else assert.equal(bv, "");
  }
  await compare("", "OPTIONS"); await compare("session=hello");
  for (const name of ["foo3", "Foo", "bad%2Fname", "foo--bar", "a".repeat(65)]) await compare(`session=${name}`);
  await compare("session=hello&role=offer", "POST", "kandelo1:offer"); await compare("session=hello");
  await compare("session=hello&role=answer", "POST", "kandelo1:answer"); await compare("session=hello");
  await compare("session=hello&role=answer", "POST", "kandelo1:late");
  await compare("session=hello&role=offer", "POST", "kandelo1:replacement");
  await compare("session=hello", "DELETE"); await compare("session=hello&role=nope", "POST", "kandelo1:x");
  await compare("session=missing&role=answer", "POST", "kandelo1:x");
  for (const code of ["", "not a code", "kandelo1:".padEnd(65537, "x"), " \t\nkandelo1:trimmed\n"]) await compare("session=hello&role=offer", "POST", code);
  await compare(`room=${room}`); await compare(`room=${room}&role=join&join=${joinA}`, "POST", "kandelo1:a");
  await compare(`room=${room}&role=host`, "POST", '{"name":"x"}');
  for (const name of ["", "x".repeat(65), "Game\u0007 night ✨"]) await compare(`room=${room}&role=host`, "POST", JSON.stringify({ name }), key);
  await compare(`room=${room}`);
  for (const j of [joinA, joinB, joinA]) await compare(`room=${room}&role=join&join=${j}`, "POST", "kandelo1:" + j);
  await compare(`room=${room}&role=host`, "POST", '{"name":"Game night"}', key);
  await compare(`room=${room}&join=${joinA}`);
  await compare(`room=${room}&role=answer&join=${joinA}`, "POST", "kandelo1:forged", "someoneelsesomeoneelse");
  await compare(`room=${room}&role=answer&join=${joinA}`, "POST", "kandelo1:answer", key);
  await compare(`room=${room}&role=refuse&join=${joinA}`, "POST", "late", key);
  await compare(`room=${room}&role=refuse&join=${joinB}`, "POST", "Sorry\u0007, no room", key);
  await compare(`room=${room}&join=${joinA}`); await compare(`room=${room}&join=${joinB}`);
  await compare(`room=${room}&role=host`, "POST", '{"name":"Game night"}', key);
  for (let i = 0; i < 9; i++) await compare(`room=${room}&role=join&join=join${String.fromCharCode(99 + i).repeat(20)}`, "POST", "kandelo1:x");
  await compare(`room=${room}&role=close`, "POST", "", key); await compare(`room=${room}`);
});
