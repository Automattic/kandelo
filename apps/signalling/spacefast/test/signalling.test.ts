import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { createDatabaseStore, TABLE, MAX_STORE_BYTES, HttpError, type Database } from "../store.ts";
import route, { createSignallingHandler } from "../handler.ts";
import { mysql } from "./mysql.ts";
let sql: Awaited<ReturnType<typeof mysql>>;
let handler: ReturnType<typeof createSignallingHandler>;
before(async () => { sql = await mysql(); });
after(async () => { await sql?.close(); });
beforeEach(async () => { await sql.query(`DROP TABLE IF EXISTS ${TABLE}`); handler = createSignallingHandler(createDatabaseStore(sql.db)); });
const ROOM = "roomtokenroomtokenroom";
const KEY = "hostkeyhostkeyhostkeyhost";
const JOIN = "joinaaaaaaaaaaaaaaaaaaaa";
function request(query: string, method = "GET", body?: string, key?: string) {
  return handler(new Request("https://app.example/__kandelo_signalling?" + query, { method, body, headers: key ? { "X-Kandelo-Host-Key": key } : {} }));
}
const host = (name = "Friday game night", key = KEY) => request(`room=${ROOM}&role=host`, "POST", JSON.stringify({ name }), key);
const join = (token = JOIN, code = "kandelo1:offer") => request(`room=${ROOM}&role=join&join=${token}`, "POST", code);
const answer = (role = "answer", value = "kandelo1:answer", token = JOIN, key = KEY) => request(`room=${ROOM}&role=${role}&join=${token}`, "POST", value, key);

test("named sessions: offer, answer once, re-offer and errors", async () => {
  assert.equal((await request("session=foo")).status, 404);
  assert.equal((await request("session=foo&role=offer", "POST", "kandelo1:offer")).status, 201);
  const s = await (await request("session=foo")).json(); assert.equal(s.offer, "kandelo1:offer"); assert.equal(s.answer, null); assert.ok(s.created > 0);
  assert.equal((await request("session=foo&role=answer", "POST", "kandelo1:answer")).status, 200);
  assert.equal((await request("session=foo&role=answer", "POST", "kandelo1:late")).status, 409);
  assert.equal((await request("session=foo&role=offer", "POST", "kandelo1:new")).status, 201);
  assert.equal((await (await request("session=foo")).json()).answer, null);
  assert.equal((await request("session=missing&role=answer", "POST", "kandelo1:x")).status, 404);
  assert.equal((await request("session=foo&role=nope", "POST", "kandelo1:x")).status, 422);
});

test("rooms: host, several joins, answer/refuse, ownership and close", async () => {
  assert.equal((await join()).status, 404); assert.equal((await host()).status, 200);
  assert.deepEqual(await (await request(`room=${ROOM}`)).json(), { room: ROOM, name: "Friday game night" });
  assert.equal((await join()).status, 201); assert.equal((await join()).status, 409);
  const other = "joinbbbbbbbbbbbbbbbbbbbb"; assert.equal((await join(other)).status, 201);
  assert.deepEqual((await (await host()).json()).joins, [{ join: JOIN, offer: "kandelo1:offer" }, { join: other, offer: "kandelo1:offer" }]);
  assert.deepEqual(await (await request(`room=${ROOM}&join=${JOIN}`)).json(), { answer: null, refused: null });
  assert.equal((await host("Taken over", "someoneelsesomeoneelse")).status, 403);
  assert.equal((await answer("answer", "kandelo1:forged", JOIN, "someoneelsesomeoneelse")).status, 403);
  assert.equal((await answer()).status, 200); assert.equal((await answer()).status, 409);
  assert.equal((await answer("refuse", "the session is full", other)).status, 200);
  assert.deepEqual(await (await request(`room=${ROOM}&join=${other}`)).json(), { answer: null, refused: "the session is full" });
  assert.deepEqual((await (await host()).json()).joins, []);
  const data = await sql.query(`SELECT payload FROM ${TABLE}`); assert.ok(!String(data.results![0].payload).includes(KEY));
  assert.equal((await request(`room=${ROOM}&role=close`, "POST", "", "someoneelsesomeoneelse")).status, 403);
  assert.equal((await request(`room=${ROOM}&role=close`, "POST", "", KEY)).status, 200);
  assert.equal((await request(`room=${ROOM}`)).status, 404);
});

test("validates methods, names, tokens, codes, text and header authority", async () => {
  for (const name of ["Foo", "foo3", "foo_bar", "foo--bar", "-foo", "foo-", "a".repeat(65), "foo%0A", "foo%2Fbar", "x&session[]=foo"]) assert.equal((await request(`session=${name}`)).status, 422, name);
  assert.equal((await request("session=constructor&role=offer", "POST", "kandelo1:x")).status, 201);
  for (const token of ["short", "Roomtokenroomtokenroom", "a".repeat(65), ROOM + "%0A", "x&room[]=foo"]) assert.equal((await request(`room=${token}`)).status, 422);
  for (const q of ["session=foo", `room=${ROOM}`]) {
    const r = await request(q, "DELETE"); assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "GET, POST, OPTIONS");
  }
  for (const value of ["", "a".repeat(65537)]) assert.equal((await request("session=foo&role=offer", "POST", value)).status, 413);
  assert.equal((await request("session=foo&role=offer", "POST", "not a code")).status, 422);
  assert.equal((await request("session=foo&role=offer", "POST", "kandelo1:".padEnd(65536, "a"))).status, 201);
  assert.equal((await request(`room=${ROOM}&role=host`, "POST", "{}" )).status, 401);
  assert.equal((await request(`room=${ROOM}&role=host`, "POST", "broken", KEY)).status, 422);
  assert.equal((await request(`room=${ROOM}&role=host`, "POST", "{}", KEY)).status, 422);
  for (const name of ["", "n".repeat(65), "\u0007"]) assert.equal((await host(name)).status, 422);
  assert.equal((await host("Game\u0007 night ✨")).status, 200);
  assert.equal((await (await request(`room=${ROOM}`)).json()).name, "Game night ✨");
  assert.equal((await request(`room=${ROOM}&role=nope`, "POST", "", KEY)).status, 422);
  assert.equal((await request(`room=${ROOM}&join=bad`)).status, 422);
  assert.equal((await request(`room=${ROOM}&join=${JOIN}`)).status, 404);
  assert.equal((await answer()).status, 404);
  await join();
  for (const value of ["", "\u0007", "x".repeat(257)]) assert.equal((await answer("refuse", value)).status, 422);
});

test("CORS, no-store and OPTIONS independent of storage", async () => {
  const r = await request("session=foo"); assert.equal(r.headers.get("access-control-allow-origin"), "*"); assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal((await route(new Request("https://app.example", { method: "OPTIONS" }), { env: {} })).status, 204);
  assert.equal((await route(new Request("https://app.example"), { env: {} })).status, 503);
  assert.equal((await request("", "OPTIONS")).status, 204);
});

test("one winner when independent workers race to answer a session", async () => {
  await request("session=race&role=offer", "POST", "kandelo1:offer");
  const requests = Array.from({ length: 8 }, (_, i) => createSignallingHandler(createDatabaseStore(sql.db))(new Request("https://app.example/?session=race&role=answer", { method: "POST", body: `kandelo1:${i}` })));
  const statuses = (await Promise.all(requests)).map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409]);
});

test("concurrent joins preserve eight slots and concurrent answer/refuse has one winner", async () => {
  await host();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => join("join" + String.fromCharCode(97 + i).repeat(20))));
  assert.equal(responses.filter(r => r.status === 201).length, 8); assert.equal(responses.filter(r => r.status === 503).length, 4);
  const waiting = (await (await host()).json()).joins; assert.equal(waiting.length, 8);
  const statuses = (await Promise.all([answer("answer", "kandelo1:x", waiting[0].join), answer("refuse", "no", waiting[0].join)])).map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 409]); assert.equal((await join("join" + "z".repeat(20))).status, 201);
});

test("database clock expires sessions, rooms and joins and prunes them globally", async () => {
  await request("session=old&role=offer", "POST", "kandelo1:old"); await host(); await join();
  const row = (await sql.query(`SELECT payload, expiry FROM ${TABLE}`)).results![0];
  const payload = JSON.parse(String(row.payload)); const expiry = JSON.parse(String(row.expiry));
  payload.sessions.old.created -= 601; expiry.sessions.old.created -= 601;
  payload.rooms[ROOM].joins[JOIN].created -= 121; expiry.rooms[ROOM].joins[JOIN].created -= 121;
  await sql.query(`UPDATE ${TABLE} SET payload = ?, expiry = ?`, [JSON.stringify(payload), JSON.stringify(expiry)]);
  assert.equal((await request("session=old")).status, 404); assert.equal((await request(`room=${ROOM}&join=${JOIN}`)).status, 404);
  assert.equal((await join()).status, 201);
  const stored = String((await sql.query(`SELECT payload FROM ${TABLE}`)).results![0].payload); assert.ok(!stored.includes('"old"'));
  payload.rooms[ROOM].touched -= 61; expiry.rooms[ROOM].touched -= 61;
  await sql.query(`UPDATE ${TABLE} SET payload = ?, expiry = ?`, [JSON.stringify(payload), JSON.stringify(expiry)]);
  assert.equal((await request(`room=${ROOM}`)).status, 404);
  assert.equal((await answer()).status, 404);
  assert.equal((await host("New owner", "someoneelsesomeoneelse")).status, 200);
});

test("global session and room ceilings allow replacements, not extra entries", async () => {
  await host(); const { results } = await sql.query(`SELECT payload, expiry FROM ${TABLE}`); const p = JSON.parse(String(results![0].payload)); const e = JSON.parse(String(results![0].expiry));
  for (let i = 0; i < 256; i++) { const key = "entry-" + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26); p.sessions[key] = { offer: "kandelo1:x", answer: null, created: Math.floor(Date.now() / 1000) }; e.sessions[key] = { created: p.sessions[key].created }; }
  for (let i = 0; i < 255; i++) { const key = "room" + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26).repeat(10); p.rooms[key] = p.rooms[ROOM]; e.rooms[key] = e.rooms[ROOM]; }
  await sql.query(`UPDATE ${TABLE} SET payload = ?, expiry = ?`, [JSON.stringify(p), JSON.stringify(e)]);
  assert.equal((await request("session=new&role=offer", "POST", "kandelo1:x")).status, 503);
  assert.equal((await request("session=entry-aa&role=offer", "POST", "kandelo1:new")).status, 201);
  const newRoom = "newroom".repeat(4); assert.equal((await request(`room=${newRoom}&role=host`, "POST", '{"name":"new"}', KEY)).status, 503);
  assert.equal((await host()).status, 200);
});

test("8 MiB ceiling is atomic; large unrelated codes never cross a normal read", async () => {
  await host();
  const { results } = await sql.query(`SELECT payload, expiry FROM ${TABLE}`); const p = JSON.parse(String(results![0].payload)); const e = JSON.parse(String(results![0].expiry));
  for (let i = 0; i < 63; i++) { const name = "fill-" + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26); p.sessions[name] = { offer: "kandelo1:".padEnd(65536, "x"), answer: "kandelo1:".padEnd(65536, "y"), created: Math.floor(Date.now() / 1000) }; e.sessions[name] = { created: p.sessions[name].created }; }
  await sql.query(`UPDATE ${TABLE} SET payload = ?, expiry = ?`, [JSON.stringify(p), JSON.stringify(e)]);
  assert.equal((await host()).status, 200);
  let full = false;
  for (let i = 0; i < 8; i++) { const r = await join("join" + String.fromCharCode(97 + i).repeat(20), "kandelo1:".padEnd(65536, "z")); if (r.status === 503) { full = true; break; } assert.equal(r.status, 201); }
  assert.ok(full); const bytes = Number((await sql.query(`SELECT OCTET_LENGTH(payload) AS bytes FROM ${TABLE}`)).results![0].bytes); assert.ok(bytes <= MAX_STORE_BYTES);
  assert.deepEqual(await (await request(`room=${ROOM}`)).json(), { room: ROOM, name: "Friday game night" });
});

test("database failures fail closed without exposing SQL or state", async () => {
  const db: Database = { prepare() { return { all: async () => { throw new Error("private SQL"); }, bind: () => ({ all: async () => { throw new Error("private SQL"); } }) }; } };
  const r = await route(new Request("https://app.example/?session=foo"), { env: { DB: db } }); assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "the signalling server failed" });
});

test("malformed UTF-8, absent bodies, streaming caps and corrupt host hashes fail closed", async () => {
  const endpoint = "https://app.example/?session=foo&role=offer";
  assert.equal((await handler(new Request(endpoint, { method: "POST" }))).status, 413);
  assert.equal((await handler(new Request(endpoint, { method: "POST", body: new Uint8Array([0xff]) }))).status, 422);
  assert.equal((await request("session=foo&role=offer", "POST", "\ufeffkandelo1:x")).status, 422);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65536)); c.enqueue(new Uint8Array(1)); } });
  assert.equal((await handler(new Request(endpoint, { method: "POST", body: stream, duplex: "half" } as RequestInit))).status, 413);
  await host();
  await sql.query(`UPDATE ${TABLE} SET payload = JSON_SET(payload, ?, ?)`, [`$.rooms.${ROOM}.key`, "broken"]);
  assert.equal((await host()).status, 403);
});

function wrapDb(transform: (sql: string, result: any) => any): Database {
  return { prepare(query) { const p = sql.db.prepare(query); return { all: async () => transform(query, await p.all()), bind: (...values) => ({ all: async () => transform(query, await p.bind(...values).all()) }) }; } };
}

test("invalid broker replies cannot silently acknowledge a write", async () => {
  for (const value of [undefined, -1, 1.5, "bad", Number.MAX_SAFE_INTEGER + 1, 2]) {
    const store = createDatabaseStore(wrapDb((q, r) => q.startsWith("UPDATE") ? { ...r, meta: { changes: value } } : r));
    await assert.rejects(store.mutate("sessions", "foo", (_e, now) => ({ entry: { offer: "kandelo1:x", answer: null, created: now }, result: true })), /Invalid signalling/);
  }
  for (const bad of [undefined, {}, { revision: 12 }, { revision: "r", now: "bad" }]) {
    const store = createDatabaseStore(wrapDb((q, r) => q.startsWith("SELECT revision, UNIX") ? { results: bad ? [bad] : [] } : r));
    await assert.rejects(store.read("sessions", "foo"), /signalling database/);
  }
  for (const expiry of [null, {}, { sessions: {} }]) {
    const store = createDatabaseStore(wrapDb((q, r) => q.startsWith("SELECT revision, UNIX") ? { ...r, results: r.results.map((row: any) => ({ ...row, expiry })) } : r));
    await assert.rejects(store.mutate("sessions", "foo", () => { throw new Error("must not mutate"); }), /Corrupt signalling/);
  }
});

test("failed initialization recovers and excessive contention returns retryable busy", async () => {
  let fail = true;
  const recovering = createDatabaseStore(wrapDb((q, r) => { if (fail && q.startsWith("CREATE")) { fail = false; return { success: false }; } return r; }));
  await assert.rejects(recovering.read("sessions", "foo"), /query failed/);
  assert.equal((await recovering.read("sessions", "foo")).entry, null);
  const busy = createDatabaseStore(wrapDb((q, r) => q.startsWith("UPDATE") ? { ...r, meta: { changes: 0 } } : q.startsWith("SELECT revision, OCTET") ? { results: [{ revision: "other", bytes: 1 }] } : r));
  await assert.rejects(busy.mutate("sessions", "foo", (_e, now) => ({ entry: { offer: "kandelo1:x", answer: null, created: now }, result: true })), (e: any) => e instanceof HttpError && e.status === 503 && e.retryAfter === "1");
});

test("binding accepts decoded JSON/numeric results and route reuses its store safely", async () => {
  const db = wrapDb((q, r) => q.startsWith("SELECT revision, UNIX") ? { ...r, results: r.results.map((row: any) => ({ ...row, now: Number(row.now), entry: typeof row.entry === "string" ? JSON.parse(row.entry) : row.entry, ...(row.expiry ? { expiry: JSON.parse(row.expiry) } : {}) })) } : r);
  for (let i = 0; i < 2; i++) {
    const r = await route(new Request("https://app.example/?session=foo&role=offer", { method: "POST", body: "kandelo1:x" }), { env: { DB: db } }); assert.equal(r.status, 201);
  }
  const r = await route(new Request("https://app.example/?session=foo"), { env: { DB: db } }); assert.equal((await r.json()).offer, "kandelo1:x");
});

test("non-Error storage rejections remain generic service failures", async () => {
  const fail = async () => { throw "private broker response"; };
  const r = await createSignallingHandler({ read: fail, mutate: fail })(new Request("https://app.example/?session=foo"));
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "the signalling server failed" });
});

function boundedDb(transform: (query: string, result: any) => any = (_q, r) => r): Database {
  return { prepare(query) {
    const p = sql.db.prepare(query);
    return { all: async () => transform(query, await p.all()), bind: (...values) => {
      assert.ok(Buffer.byteLength(JSON.stringify({ sql: query, params: values })) <= 65536, "Spacefast broker operation <= 64 KiB");
      return { all: async () => transform(query, await p.bind(...values).all()) };
    } };
  } };
}

test("64 KiB codes and eight maximum offers fit the real 64 KiB broker envelope", async () => {
  const store = createDatabaseStore(boundedDb()); handler = createSignallingHandler(store);
  const max = "kandelo1:".padEnd(65536, "x");
  assert.equal((await request("session=large&role=offer", "POST", max)).status, 201);
  const raced = await Promise.all(Array.from({ length: 3 }, () => request("session=large&role=answer", "POST", max)));
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409, 409]);
  assert.equal((await (await request("session=large")).json()).answer.length, 65536);
  const escaped = "kandelo1:" + "\\".repeat(12000);
  assert.equal((await request("session=escaped&role=offer", "POST", escaped)).status, 201);
  assert.equal((await (await request("session=escaped")).json()).offer, escaped);
  await host();
  for (let i = 0; i < 8; i++) assert.equal((await join("join" + String.fromCharCode(97 + i).repeat(20), max)).status, 201);
  const waiting = await (await host()).json(); assert.equal(waiting.joins.length, 8); assert.ok(waiting.joins.every((j: any) => j.offer.length === 65536));
  assert.equal((await answer("answer", max, waiting.joins[0].join)).status, 200);
  await store.mutate("rooms", ROOM, entry => ({ entry, result: true }));
  assert.equal(Number((await sql.query(`SELECT COUNT(*) AS n FROM ${TABLE}_staging`)).results![0].n), 0);
});

test("partial or unacknowledged chunks never replace committed state", async () => {
  await request("session=large&role=offer", "POST", "kandelo1:original");
  for (const mode of ["failed", "zero"]) {
    let once = false;
    const db = boundedDb((q, r) => {
      if (!once && q.startsWith(`UPDATE ${TABLE}_staging`)) { once = true; return mode === "failed" ? { success: false } : { meta: { changes: 0 } }; }
      return r;
    });
    const h = createSignallingHandler(createDatabaseStore(db));
    assert.equal((await h(new Request("https://app.example/?session=large&role=offer", { method: "POST", body: "kandelo1:".padEnd(65536, "x") }))).status, 503);
    assert.equal((await (await request("session=large")).json()).offer, "kandelo1:original");
    assert.equal(Number((await sql.query(`SELECT COUNT(*) AS n FROM ${TABLE}_staging`)).results![0].n), 0);
  }
});

test("staging cleanup failure cannot hide an acknowledged commit", async () => {
  const db = boundedDb((q, r) => { if (q.startsWith(`DELETE FROM ${TABLE}_staging WHERE id`)) throw new Error("cleanup unavailable"); return r; });
  const h = createSignallingHandler(createDatabaseStore(db));
  assert.equal((await h(new Request("https://app.example/?session=large&role=offer", { method: "POST", body: "kandelo1:".padEnd(65536, "x") }))).status, 201);
  assert.equal((await (await request("session=large")).json()).offer.length, 65536);
});

test("atomic entry deletion removes its expiry metadata and cannot resurrect a join", async () => {
  await host(); await join();
  const store = createDatabaseStore(boundedDb());
  await store.mutate("rooms", ROOM, entry => { const room = entry as import("../store.ts").Room; delete room.joins[JOIN]; return { entry: room, result: true }; });
  assert.equal((await request(`room=${ROOM}&join=${JOIN}`)).status, 404);
  const index = JSON.parse(String((await sql.query(`SELECT expiry FROM ${TABLE}`)).results![0].expiry)); assert.deepEqual(index.rooms[ROOM].joins, {});
});
