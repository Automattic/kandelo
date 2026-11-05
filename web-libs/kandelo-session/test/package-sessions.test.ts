import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  parsePackageSessions, resolveSessionOffer, sessionCommand, sessionDefaults,
  validateSessionValues, loadPackageSessions, PACKAGE_SESSIONS_DIR, PACKAGE_SESSION_CLIENTS_DIR,
  sessionPresentation, sessionFieldWarning, sessionProcedureDigest, type SessionOffer,
} from "../src/package-sessions.ts";
import { decodeSessionInvitation, encodeSessionInvitation } from "../src/session-invitation.ts";

const source = (name: string) => readFileSync(new URL(`../../../packages/registry/${name}/sessions.json`, import.meta.url), "utf8");
const chat = parsePackageSessions(source("termchat"));
const doom = parsePackageSessions(source("fbdoom"));
const sha256 = createHash("sha256").update(source("termchat")).digest("hex");
const offer: SessionOffer = { version: 1, package: "termchat", packageVersion: "1.3.1", manifestSha256: sha256, offer: "chat", values: { name: "alice" } };

test("package declarations distinguish offer setup from participant setup", () => {
  const { type, join } = resolveSessionOffer([{ manifest: chat, sha256 }], offer);
  assert.match(sessionCommand(type, null, offer.values), /'alice'/);
  const command = sessionCommand(type, join, offer.values, { name: "bob" });
  assert.match(command, /'bob'/);
  assert.ok(!command.includes("alice"));
  assert.equal(type.attachExisting, true);
  assert.equal(doom.offers[0].attachExisting, false);
});

test("KMS activities declare a bounded display scale without putting it in invitations or commands", () => {
  const manifest = parsePackageSessions(source("freeciv-browser-bundle"));
  assert.equal(manifest.offers[0].launch!.surface, "display");
  assert.equal((manifest.offers[0].launch as any).displayScale, 1.5);
  assert.equal((manifest.joins[0].launch as any).displayScale, 1.5);
  for (const scale of [0, 0.49, 4.01, "1.5", null]) {
    const raw = JSON.parse(source("freeciv-browser-bundle")); raw.offers[0].launch.displayScale = scale;
    assert.throws(() => parsePackageSessions(JSON.stringify(raw)));
  }
  const wrong = JSON.parse(source("termchat")); wrong.offers[0].launch.displayScale = 1.5;
  assert.throws(() => parsePackageSessions(JSON.stringify(wrong)));
  const web = JSON.parse(source("nginx-vfs")); web.joins[0].launch.displayScale = 1.5;
  assert.throws(() => parsePackageSessions(JSON.stringify(web)));
  assert.ok(!JSON.stringify(sessionPresentation(manifest, manifest.offers[0], { values: { name: "host" } })).includes("displayScale"));
});

test("Doom's host selects game mode before launch; guests connect to the host", () => {
  const type = doom.offers[0], join = doom.joins[0];
  const data = [{ id: "iwad", source: "shareware", name: "Doom", size: 1, sha256: "a".repeat(64), delivery: "peer" as const }];
  assert.ok(!sessionCommand(type, null, { mode: "cooperative", players: 2, level: "E1M1" }, {}, data).includes("-deathmatch"));
  assert.ok(sessionCommand(type, null, { mode: "deathmatch", players: 2, level: "E1M1" }, {}, data).includes("'-deathmatch'"));
  assert.ok(sessionCommand(type, null, { mode: "altdeath", players: 2, level: "E1M1" }, {}, data).includes("'-altdeath'"));
  assert.match(sessionCommand(type, join, { mode: "deathmatch", players: 2, level: "E1M1" }, {}, data), /'-connect' 'host'/);
  assert.deepEqual(type.launch.requires, ["/tmp/kandelo-doom-data.bin"]);
});

test("participant values stay literal across the shell boundary", () => {
  const command = structuredClone(chat.offers[0]);
  command.launch.executable = process.execPath;
  command.launch.args = ["-e", "process.stdout.write(process.argv[1])", { field: "offer.name" }];
  const name = "a'; $(echo INJECTED) #";
  assert.equal(execFileSync("sh", ["-c", sessionCommand(command, null, { name })], { encoding: "utf8" }), name);
});

test("rejects unknown fields, broken type references and incompatible package procedures", () => {
  for (const mutate of [
    (m: any) => { m.version = 2; },
    (m: any) => { m.script = "evil"; },
    (m: any) => { m.offers[0].launch.executable = "../termchat"; },
    (m: any) => { m.offers[0].launch.args = [{ field: "join.name" }]; },
    (m: any) => { m.offers[0].join = "missing"; },
    (m: any) => { m.joins[0].launch.args = [{ options: "join.name" }]; },
    (m: any) => { m.offers.push(m.offers[0]); },
    (m: any) => { m.offers[0].fields[0].maxLength = 1000000; },
  ]) {
    const value = JSON.parse(source("termchat")); mutate(value);
    assert.throws(() => parsePackageSessions(JSON.stringify(value)));
  }
  assert.throws(() => resolveSessionOffer([{ manifest: chat, sha256: "f".repeat(64) }], offer));
  assert.throws(() => resolveSessionOffer([], offer));
  assert.throws(() => validateSessionValues(chat.joins[0].fields, { name: "\n" }));
  assert.throws(() => validateSessionValues(chat.joins[0].fields, { name: "bob", script: "x" }));
  assert.throws(() => validateSessionValues(doom.offers[0].fields, { mode: "unknown" }));
  assert.deepEqual(sessionDefaults(doom.offers[0].fields), { mode: "cooperative", players: 2, level: "E1M1" });
});

test("invitation codec is bounded, versioned, canonical and contains no join commands", () => {
  const encoded = encodeSessionInvitation(offer);
  assert.deepEqual(decodeSessionInvitation(encoded), offer);
  assert.equal(decodeSessionInvitation("#k1=unrelated"), null);
  assert.throws(() => decodeSessionInvitation("#ks1=" + "a".repeat(20000)));
  assert.throws(() => decodeSessionInvitation(encoded + "="));
  assert.throws(() => encodeSessionInvitation({ ...offer, values: { name: "a".repeat(129) } }));
  assert.throws(() => encodeSessionInvitation({ ...offer, command: "evil" } as SessionOffer));
});

test("preboot display details are bounded, contain no commands, and must match the installed procedure", () => {
  const presentation = sessionPresentation(chat, chat.offers[0], offer);
  const displayed = { ...offer, presentation };
  assert.deepEqual(decodeSessionInvitation(encodeSessionInvitation(displayed)), displayed);
  assert.equal(presentation.title, "Terminal chat");
  assert.deepEqual(presentation.settings, [{ id: "name", label: "Your name", value: "alice" }]);
  assert.equal(presentation.join.fields[0].default, "guest");
  assert.ok(!JSON.stringify(presentation).includes("executable"));
  const installed = [{ manifest: chat, sha256 }];
  resolveSessionOffer(installed, displayed);
  const changed = structuredClone(displayed); changed.presentation.title = "Other activity";
  assert.throws(() => resolveSessionOffer(installed, changed), /display details/);
  for (const mutate of [
    (p: any) => { p.join.launch = { executable: "/evil" }; },
    (p: any) => { p.join.fields[0].maxLength = 9999; },
    (p: any) => { p.settings.push(p.settings[0]); },
    (p: any) => { p.description = "x".repeat(2049); },
    (p: any) => { p.dependencies = [{ id: "data", title: "Data", hint: "Hint", source: { title: "Source", url: "javascript:evil()" } }]; },
  ]) {
    const bad = structuredClone(presentation); mutate(bad);
    assert.throws(() => encodeSessionInvitation({ ...offer, presentation: bad }));
  }
  // Old links remain supported without a presentation snapshot.
  resolveSessionOffer(installed, offer);
});

test("all shipped activities fit in bounded invitations with participant and dependency display details", () => {
  const packages = ["fbdoom", "tyrquake", "termchat", "freeciv-browser-bundle", "netcat", "php", "python-browser-bundle", "nginx-vfs", "nginx-php-vfs", "nginx-python-vfs", "lamp", "wordpress", "ruby-todo-vfs", "redis-vfs"];
  for (const name of packages) {
    const manifest = parsePackageSessions(source(name));
    for (const type of manifest.offers) {
      const base: SessionOffer = { version: 1, package: manifest.package, packageVersion: manifest.packageVersion,
        manifestSha256: "a".repeat(64), offer: type.id, values: sessionDefaults(type.fields),
        dependencies: (manifest.dependencies ?? []).map(d => ({ id: d.id, name: d.sources[0].title.slice(0, 128),
          source: d.sources[0].id, size: d.sources[0].size, sha256: d.sources[0].sha256, delivery: "hint" })) };
      const displayed = { ...base, presentation: sessionPresentation(manifest, type, base) };
      assert.deepEqual(decodeSessionInvitation(encodeSessionInvitation(displayed)), displayed, name);
      assert.ok(!JSON.stringify(displayed.presentation).includes('"args"'), name);
    }
  }
});

test("warnings belong to the selected source, option and level, including invitation previews", () => {
  const raw = JSON.parse(source("fbdoom"));
  raw.offers[0].fields[0].options[1].warning = "Choice-specific note";
  raw.offers[0].fields.at(-1).levelWarnings = { shareware: { E1M2: "Map-specific note" } };
  raw.dependencies[0].fileWarning = "Local-file note";
  const manifest = parsePackageSessions(JSON.stringify(raw)), type = manifest.offers[0];
  const mode = type.fields[0], level = type.fields.at(-1)!;
  assert.equal(sessionFieldWarning(mode, "cooperative"), undefined);
  assert.equal(sessionFieldWarning(mode, "deathmatch"), "Choice-specific note");
  assert.equal(sessionFieldWarning(level, "E1M2", "shareware"), "Map-specific note");
  assert.equal(sessionFieldWarning(level, "E1M1", "shareware"), undefined);
  assert.equal(sessionFieldWarning(level, "E1M2", "freedoom1"), undefined);
  const setup = { values: { mode: "cooperative", players: 2, level: "E1M1" }, dependencies: [{ id: "iwad", source: "shareware" } as any] };
  assert.equal(sessionPresentation(manifest, type, setup).warnings, undefined);
  assert.deepEqual(sessionPresentation(manifest, type, { ...setup, values: { ...setup.values, mode: "deathmatch", level: "E1M2" } }).warnings, ["Choice-specific note", "Map-specific note"]);
  assert.deepEqual(sessionPresentation(manifest, type, { ...setup, dependencies: [{ id: "iwad" } as any] }).warnings, ["Local-file note"]);
  const quake = parsePackageSessions(source("tyrquake"));
  assert.deepEqual(sessionPresentation(quake, quake.offers[0], { values: sessionDefaults(quake.offers[0].fields), dependencies: [{ id: "data", source: "openquartz" } as any] }).warnings, ["Deathmatch maps only."]);
  // Participant option warnings also survive the command-free preview schema.
  const participant = structuredClone(chat);
  participant.joins[0].fields = [{ id: "role", label: "Role", type: "choice", default: "player", options: [
    { value: "player", label: "Player", args: [] }, { value: "observer", label: "Observer", args: [], warning: "Cannot play" },
  ] }];
  const preview = sessionPresentation(participant, participant.offers[0], offer);
  assert.deepEqual(decodeSessionInvitation(encodeSessionInvitation({ ...offer, presentation: preview }))?.presentation, preview);
  assert.equal(sessionFieldWarning(preview.join.fields[0], "player"), undefined);
  assert.equal(sessionFieldWarning(preview.join.fields[0], "observer"), "Cannot play");
});

test("warning declarations reject unknown sources/maps and oversized or executable payloads", () => {
  for (const mutate of [
    (m: any) => { m.offers[0].fields.at(-1).levelWarnings = { missing: { E1M2: "Note" } }; },
    (m: any) => { m.offers[0].fields.at(-1).levelWarnings = { shareware: { MAP01: "Note" } }; },
    (m: any) => { m.offers[0].fields[0].options[0].warning = "x".repeat(257); },
    (m: any) => { m.dependencies[0].sources[0].warning = { command: "evil" }; },
    (m: any) => { m.dependencies[0].fileWarning = "\n"; },
    (m: any) => { m.offers[0].existingWarning = "x".repeat(257); },
  ]) { const raw = JSON.parse(source("fbdoom")); mutate(raw); assert.throws(() => parsePackageSessions(JSON.stringify(raw))); }
  assert.throws(() => encodeSessionInvitation({ ...offer, presentation: { ...sessionPresentation(chat, chat.offers[0], offer), warnings: ["x".repeat(257)] } }));
  const displayed = { ...offer, presentation: { ...sessionPresentation(chat, chat.offers[0], offer), warnings: ["Wrong warning"] } };
  assert.throws(() => resolveSessionOffer([{ manifest: chat, sha256 }], displayed), /display details/);
});

test("integer setup fields enforce their declared bounds and preserve numeric arguments", () => {
  const raw = JSON.parse(source("termchat"));
  raw.offers[0].fields = [{ id: "port", label: "Port", type: "integer", default: 5877, min: 1024, max: 65535 }];
  raw.offers[0].launch.args = ["-t", { field: "offer.port" }];
  const manifest = parsePackageSessions(JSON.stringify(raw));
  assert.match(sessionCommand(manifest.offers[0], null, { port: 5877 }), /'-t' '5877'/);
  for (const port of [0, 65536, 1.5, NaN, "5877"]) {
    assert.throws(() => validateSessionValues(manifest.offers[0].fields, { port }));
  }
});

test("catalog comes from installed VFS metadata, including lazy program packages", async () => {
  const installed = await loadPackageSessions({
    readVfsDir: async path => { if (path === PACKAGE_SESSION_CLIENTS_DIR) return null; assert.equal(path, PACKAGE_SESSIONS_DIR); return [{ name: "termchat.json" }]; },
    readFile: async path => { assert.equal(path, `${PACKAGE_SESSIONS_DIR}/termchat.json`); return new TextEncoder().encode(source("termchat")); },
  });
  assert.equal(installed[0].sha256, sha256);
  assert.deepEqual(await loadPackageSessions({ readVfsDir: async () => null, readFile: async () => { throw new Error("unexpected read"); } }), []);
  await assert.rejects(loadPackageSessions({ readVfsDir: async () => [{ name: "wrong.json" }], readFile: async () => new TextEncoder().encode(source("termchat")) }));
});


test("dependency declarations restrict paths, sources and invitation content", () => {
  const declaration = doom.dependencies![0];
  assert.equal(declaration.sources[0].size, 4196020);
  for (const mutate of [
    (d: any) => { d.path = "/etc/passwd"; },
    (d: any) => { d.path = "/tmp/.."; },
    (d: any) => { d.id = ["data"]; },
    (d: any) => { d.sources[0].sha256 = ["a".repeat(64)]; },
    (d: any) => { d.path = "/tmp/../passwd"; },
    (d: any) => { d.sources[0].url = "javascript:evil"; },
    (d: any) => { d.sources[0].size = 65 * 1048576; },
    (d: any) => { d.sources[0].sha256 = "x"; },
    (d: any) => { d.script = "evil"; },
  ]) {
    const raw = structuredClone(doom); mutate(raw.dependencies![0]);
    assert.throws(() => parsePackageSessions(JSON.stringify(raw)));
  }
  const invited: SessionOffer = { version: 1, package: doom.package, packageVersion: doom.packageVersion, manifestSha256: "a".repeat(64), offer: "game", values: { mode: "cooperative", players: 2, level: "E1M1" }, dependencies: [{ id: declaration.id, name: "Shareware", source: "shareware", size: declaration.sources[0].size, sha256: declaration.sources[0].sha256, delivery: "hint" }] };
  const installed = [{ manifest: doom, sha256: invited.manifestSha256 }];
  assert.deepEqual(decodeSessionInvitation(encodeSessionInvitation(invited)), invited);
  assert.equal(resolveSessionOffer(installed, invited).type.id, "game");
  assert.throws(() => resolveSessionOffer(installed, { ...invited, dependencies: [] }));
  assert.throws(() => resolveSessionOffer(installed, { ...invited, dependencies: [{ ...invited.dependencies![0], sha256: "b".repeat(64) }] }));
  assert.throws(() => encodeSessionInvitation({ ...invited, dependencies: [{ ...invited.dependencies![0], path: "/evil" } as any] }));
});

import { SessionDependencyPeer } from "../src/session-dependency-peer";
import { dependencyDigest, verifyDependency, fetchDependency } from "../src/session-dependencies";

function dependencyWires() {
  class Wire extends EventTarget {
    binaryType = "arraybuffer"; bufferedAmount = 0;
    peer!: Wire;
    corrupt = false;
    send(data: string | ArrayBuffer) {
      const copy = typeof data === "string" ? data : data.slice(0);
      if (this.corrupt && copy instanceof ArrayBuffer) new Uint8Array(copy)[0] ^= 1;
      queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent("message", { data: copy })));
    }
  }
  const a = new Wire(), b = new Wire(); a.peer = b; b.peer = a;
  return { a, b };
}

test("dependency peers transfer exact bytes with bounded requested chunks, reject corrupt/unshared files, and cancel", async () => {
  const bytes = Uint8Array.from({ length: 32775 }, (_, i) => i % 251);
  const content = { id: "data", name: "data.bin", size: bytes.length, sha256: await dependencyDigest(bytes), delivery: "peer" as const };
  const { a, b } = dependencyWires();
  const sender = new SessionDependencyPeer(a as unknown as RTCDataChannel, () => new Map([[content.sha256, bytes]]));
  const receiver = new SessionDependencyPeer(b as unknown as RTCDataChannel, () => new Map());
  const progress: number[] = [];
  try {
    assert.deepEqual(await receiver.receive(content, new AbortController().signal, n => progress.push(n)), bytes);
    assert.deepEqual(progress, [16384, 32768, 32775]);
    a.corrupt = true;
    await assert.rejects(receiver.receive(content, new AbortController().signal, () => {}), /fingerprint/);
    a.corrupt = false;
    await assert.rejects(receiver.receive({ ...content, sha256: "f".repeat(64) }, new AbortController().signal, () => {}), /did not provide/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(receiver.receive(content, cancelled.signal, () => {}), /cancelled/);
  } finally { sender.dispose(); receiver.dispose(); }
  await assert.rejects(verifyDependency(bytes.slice(1), content), /fingerprint/);
});

test("dependency receiver releases pending requests when its connection closes", async () => {
  const { a } = dependencyWires();
  const receiver = new SessionDependencyPeer(a as unknown as RTCDataChannel, () => new Map());
  const receiving = receiver.receive({ id: "data", name: "data", sha256: "a".repeat(64), size: 1, delivery: "peer" }, new AbortController().signal, () => {});
  receiver.dispose();
  await assert.rejects(receiving, /closed/);
});

test("download readers enforce the byte limit even when Content-Length is missing", async () => {
  const original = globalThis.fetch;
  const bytes = new Uint8Array([1, 2, 3]);
  const source = { url: "https://example.test/data", size: 3, sha256: await dependencyDigest(bytes) };
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.credentials, "omit"); assert.equal(options?.referrerPolicy, "no-referrer");
      return new Response(bytes);
    };
    assert.deepEqual(await fetchDependency(source, new AbortController().signal), bytes);
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
    await assert.rejects(fetchDependency(source, new AbortController().signal), /exceeds/);
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2]));
    await assert.rejects(fetchDependency(source, new AbortController().signal), /incomplete/);
  } finally { globalThis.fetch = original; }
});


test("every shipped network activity parses, quotes its launch and exposes bounded data choices", () => {
  for (const pkg of ["fbdoom", "termchat", "tyrquake", "freeciv-browser-bundle", "netcat", "python-browser-bundle", "php"]) {
    const m = parsePackageSessions(source(pkg));
    assert.equal(m.package, pkg);
    const dependencies = (m.dependencies ?? []).map(d => ({ id: d.id, name: d.title, source: d.sources[0].id, size: d.sources[0].size, sha256: d.sources[0].sha256, delivery: "hint" as const }));
    for (const type of m.offers) {
      const join = m.joins.find(j => j.id === type.join)!;
      const values = sessionDefaults(type.fields);
      assert.ok(sessionCommand(type, null, values, {}, dependencies).startsWith("cd '/' && '/"));
      if (join.launch.surface !== "web") assert.ok(sessionCommand(type, join, values, sessionDefaults(join.fields), dependencies).startsWith("cd '/' && '/"));
    }
  }
});

test("dependency source arguments come from identified data; display and hosting requirements are closed", () => {
  const q = parsePackageSessions(source("tyrquake"));
  const type = q.offers[0];
  assert.throws(() => sessionCommand(type, null, sessionDefaults(type.fields)), /missing launch dependency/);
  for (const mutate of [
    (m: any) => { m.offers[0].launch.display = "foreign"; },
    (m: any) => { m.offers[0].requiresHost = "true"; },
    (m: any) => { m.offers[0].launch.args = [{ field: "dependency.foreign.source" }]; },
  ]) {
    const m = JSON.parse(source("tyrquake")); mutate(m);
    assert.throws(() => parsePackageSessions(JSON.stringify(m)));
  }
});


test("service declarations share existing servers and require an installed host", async () => {
  for (const pkg of ["nginx-vfs", "nginx-php-vfs", "nginx-python-vfs", "wordpress", "lamp", "ruby-todo-vfs", "redis-vfs"]) {
    const m = parsePackageSessions(source(pkg));
    assert.equal(m.offers[0].launch, undefined);
    assert.equal(m.offers[0].attachExisting, true);
    assert.equal(m.offers[0].requiresHost, true);
    assert.equal(m.joins[0].computer, "default");
    assert.throws(() => sessionCommand(m.offers[0], null, {}), /existing service/);
    if (m.joins[0].launch.surface !== "web") assert.match(sessionCommand(m.offers[0], m.joins[0], {}), /'host'/);
    else assert.equal(m.joins[0].launch.host, "network.host");
    const installed = await loadPackageSessions({
      readVfsDir: async () => [{ name: `${pkg}.json` }],
      readFile: async () => new TextEncoder().encode(source(pkg)),
      stat: async () => null,
    });
    assert.deepEqual(installed[0].unavailableOffers, m.offers.map(offer => offer.id));
  }
});


test("client definitions resolve invitations without advertising server installation", async () => {
  const bytes = new TextEncoder().encode(source("nginx-vfs"));
  const client = await loadPackageSessions({
    readVfsDir: async path => path === PACKAGE_SESSION_CLIENTS_DIR ? [{ name: "nginx-vfs.json" }] : null,
    readFile: async () => bytes,
  });
  assert.equal(client[0].clientOnly, true);
  const both = await loadPackageSessions({ readVfsDir: async () => [{ name: "nginx-vfs.json" }], readFile: async () => bytes });
  assert.equal(both.length, 1);
  assert.equal(both[0].clientOnly, false);
  await assert.rejects(loadPackageSessions({
    readVfsDir: async () => [{ name: "nginx-vfs.json" }],
    readFile: async path => path.startsWith(PACKAGE_SESSION_CLIENTS_DIR) ? bytes : new TextEncoder().encode(source("nginx-vfs").replace("nginx website", "different website")),
  }), /conflicting/);
});

test("website activities declare bounded local or Kandelo preview destinations", () => {
  const value = JSON.parse(source("nginx-vfs"));
  assert.deepEqual(parsePackageSessions(JSON.stringify(value)).joins[0].launch, { surface: "web", host: "network.host", port: 8080, path: "/" });
  assert.throws(() => sessionCommand(value.offers[0], value.joins[0], {}), /opens a preview/);
  for (const mutation of [
    { host: "https://outside.example" }, { port: 0 }, { port: 65536 }, { path: "//outside.example" }, { executable: "/bin/sh" },
  ]) {
    const invalid = structuredClone(value); Object.assign(invalid.joins[0].launch, mutation);
    assert.throws(() => parsePackageSessions(JSON.stringify(invalid)));
  }
});

import { readGameLevels, levelArguments } from "../src/game-levels";
import { validateSessionLevels } from "../src/package-sessions";

function wadFixture(names: string[]) {
  const bytes = new Uint8Array(12 + names.length * 16);
  bytes.set(new TextEncoder().encode("IWAD"));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, names.length, true); view.setUint32(8, 12, true);
  names.forEach((name, i) => bytes.set(new TextEncoder().encode(name), 12 + i * 16 + 8));
  return bytes;
}
function pakFixture(maps: Array<{ name: string; entities: string }>) {
  const bodies = maps.map(map => {
    const text = new TextEncoder().encode(map.entities);
    const body = new Uint8Array(12 + text.length), view = new DataView(body.buffer);
    view.setUint32(0, 29, true); view.setUint32(4, 12, true); view.setUint32(8, text.length, true); body.set(text, 12);
    return body;
  });
  const offset = 12 + bodies.reduce((sum, body) => sum + body.length, 0);
  const bytes = new Uint8Array(offset + maps.length * 64), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("PACK")); view.setUint32(4, offset, true); view.setUint32(8, maps.length * 64, true);
  let start = 12;
  maps.forEach((map, i) => {
    bytes.set(bodies[i], start); bytes.set(new TextEncoder().encode(map.name), offset + i * 64);
    view.setUint32(offset + i * 64 + 56, start, true); view.setUint32(offset + i * 64 + 60, bodies[i].length, true); start += bodies[i].length;
  });
  return bytes;
}

test("bounded WAD inspection finds real map sequences, handles views and rejects malformed directories", () => {
  const bytes = wadFixture(["E1M2", "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "MAP01", "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "E1M9", "NOTAMAP"]);
  const backing = new Uint8Array(bytes.length + 16); backing.set(bytes, 8);
  assert.deepEqual(readGameLevels(backing.subarray(8, 8 + bytes.length), "doom-wad"), ["E1M2", "MAP01"]);
  for (const mutate of [
    (view: DataView) => view.setUint32(8, 0xffffffff, true),
    (view: DataView) => view.setUint32(4, 0xffffffff, true),
    (view: DataView) => view.setUint32(12, 0xffffffff, true),
    (view: DataView) => view.setUint32(16, 0xffffffff, true),
  ]) { const broken = bytes.slice(); mutate(new DataView(broken.buffer)); assert.throws(() => readGameLevels(broken, "doom-wad")); }
  assert.throws(() => readGameLevels(wadFixture(["E1M1"]), "doom-wad"));
  assert.throws(() => readGameLevels(new Uint8Array(4), "doom-wad"));
});

test("PAK inspection excludes brush models and unsafe map names, bounds BSP entity reads", () => {
  const entities = '{"classname" "worldspawn"}\n{"classname" "info_player_start"}';
  const bytes = pakFixture([{ name: "maps/start.bsp", entities }, { name: "maps/e1m2.bsp", entities },
    { name: "maps/b_batt0.bsp", entities: '{"classname" "worldspawn"}' }, { name: "maps/../evil.bsp", entities }]);
  assert.deepEqual(readGameLevels(bytes, "quake-pak"), ["e1m2", "start"]);
  const broken = bytes.slice(); new DataView(broken.buffer).setUint32(8, 65, true);
  assert.throws(() => readGameLevels(broken, "quake-pak"));
  const invalidBsp = pakFixture([{ name: "maps/start.bsp", entities }]);
  new DataView(invalidBsp.buffer).setUint32(16, 0xffffffff, true);
  assert.throws(() => readGameLevels(invalidBsp, "quake-pak"));
});

test("level arguments preserve native Doom episode/map semantics and reject Quake command injection", () => {
  assert.deepEqual(levelArguments("doom-wad", "E2M3"), ["-warp", "2", "3"]);
  assert.deepEqual(levelArguments("doom-wad", "MAP07"), ["-warp", "7"]);
  assert.deepEqual(levelArguments("quake-pak", "e1m2"), ["e1m2"]);
  for (const level of ["start; quit", "../start", "start\nquit", "+quit", "a".repeat(33)]) assert.throws(() => levelArguments("quake-pak", level));
  const type = doom.offers[0];
  assert.throws(() => validateSessionLevels(type.fields, { ...sessionDefaults(type.fields), level: "MAP01" }, [{ id: "iwad", source: "shareware" } as any]));
  const raw = JSON.parse(source("fbdoom")); raw.offers[0].fields.at(-1).sources.untrusted = ["E1M1"];
  assert.throws(() => parsePackageSessions(JSON.stringify(raw)));
});

test("level selection is host setup and command construction enforces the selected source catalog", () => {
  const raw = JSON.parse(source("fbdoom"));
  raw.joins[0].fields.push(structuredClone(raw.offers[0].fields.find((field: any) => field.type === "level")));
  assert.throws(() => parsePackageSessions(JSON.stringify(raw)), /host setup/);
  assert.throws(() => sessionCommand(doom.offers[0], null, { ...sessionDefaults(doom.offers[0].fields), level: "MAP01" }, {}, [{ id: "iwad", source: "shareware" } as any]), /unavailable/);
});

test("join contracts tolerate host-only edits but still reject different commands and unverified old links", async () => {
  const old = parsePackageSessions(source("redis-vfs"));
  delete old.offers[0].warning;
  const current = parsePackageSessions(source("redis-vfs"));
  const digest = await sessionProcedureDigest(old, old.offers[0]);
  assert.equal(await sessionProcedureDigest(current, current.offers[0]), digest);
  const installed = [{ manifest: current, sha256: "b".repeat(64), procedureSha256: { service: digest } }];
  const previous: SessionOffer = { version: 1, package: old.package, packageVersion: old.packageVersion,
    manifestSha256: "a".repeat(64), procedureSha256: digest, offer: "service", values: {},
    presentation: sessionPresentation(old, old.offers[0], { values: {} }) };
  const resolved = resolveSessionOffer(installed, previous);
  assert.equal(resolved.type.warning, current.offers[0].warning);
  assert.throws(() => resolveSessionOffer(installed, { ...previous, procedureSha256: undefined }), /fresh invitation/);
  const changed = structuredClone(current);
  changed.joins[0].launch = { surface: "web", host: "network.host", port: 9000, path: "/" };
  assert.notEqual(await sessionProcedureDigest(changed, changed.offers[0]), digest);
  assert.throws(() => resolveSessionOffer([{ ...installed[0], procedureSha256: { service: "c".repeat(64) } }], previous), /different activity procedures/);
  assert.throws(() => resolveSessionOffer(installed, { ...previous, values: { execute: "evil" } }), /unknown field/);
  const lamp = parsePackageSessions(source("lamp"));
  const sql = await sessionProcedureDigest(lamp, lamp.offers[1]);
  const renamed = structuredClone(lamp); renamed.offers[0].description = "Different host website description";
  assert.equal(await sessionProcedureDigest(renamed, renamed.offers[1]), sql);
  renamed.joins[1].launch = { surface: "terminal", executable: "/bin/sh", args: ["-c", "evil"], cwd: "/", requires: [] };
  assert.notEqual(await sessionProcedureDigest(renamed, renamed.offers[1]), sql);
});

import { SessionActivityPeer, activityOffersMessage, MAX_ACTIVITY_OFFERS_BYTES } from "../src/session-activity-peer";

test("activity discovery publishes host-owned snapshots and live updates, rejects guest advertisements, and retires listeners", async () => {
  const { a, b } = dependencyWires();
  Object.assign(a, { readyState: "open" }); Object.assign(b, { readyState: "open" });
  let offers = [offer];
  const errors: string[] = [];
  let notify!: () => void;
  let next = new Promise<void>(resolve => { notify = resolve; });
  const received: SessionOffer[][] = [];
  const host = new SessionActivityPeer(a as unknown as RTCDataChannel, true, () => offers, () => assert.fail("guest cannot advertise"), error => errors.push(error));
  const guest = new SessionActivityPeer(b as unknown as RTCDataChannel, false, () => [], value => { received.push(value); notify(); }, error => errors.push(error));
  try {
    await next;
    assert.deepEqual(received, [[offer]]);
    next = new Promise<void>(resolve => { notify = resolve; });
    offers = []; host.publish(); await next;
    assert.deepEqual(received, [[offer], []]);
    b.send(activityOffersMessage([offer]));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.match(errors[0], /Only the host/);
    guest.dispose(); host.publish();
    assert.equal(received.length, 2);
  } finally { host.dispose(); guest.dispose(); }
  assert.throws(() => activityOffersMessage([offer, offer]), /Duplicate/);
  assert.throws(() => activityOffersMessage([{ ...offer, presentation: { title: "x".repeat(MAX_ACTIVITY_OFFERS_BYTES) } } as SessionOffer]), /display/);
  const pair = dependencyWires(); Object.assign(pair.b, { readyState: "open" });
  const invalid: string[] = [];
  const receiver = new SessionActivityPeer(pair.b as unknown as RTCDataChannel, false, () => [], () => assert.fail("invalid data accepted"), error => invalid.push(error));
  pair.b.dispatchEvent(new MessageEvent("message", { data: "x".repeat(MAX_ACTIVITY_OFFERS_BYTES + 1) }));
  assert.match(invalid[0], /size/); receiver.dispose();
});
