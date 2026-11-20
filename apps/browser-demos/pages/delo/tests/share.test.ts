import assert from "node:assert/strict";
import test from "node:test";

import { createDeloDraft } from "../src/draft";
import { planDeloAdd, planDeloEnable, planDeloRemove } from "../src/packages";
import { parseDeloRegistry } from "../src/registry";
import { sessionInvitation } from "../../../lib/network-session";
import { DELO_SHARE_PARAM, deloShareUrl, draftFromShare, sharedDraftName, withDeloSession, withoutDeloSession } from "../src/share";

const pkg = (name: string, use: string[], provide: string[]) => ({
  name,
  type: "binary",
  description: name,
  files: [{ to: `/etc/${name}`, content: name }],
  use,
  provide,
});

const REGISTRY = parseDeloRegistry(JSON.stringify({
  schema: 1,
  entries: [
    pkg("foo", [], ["init", "shell"]),
    pkg("bar", ["baz"], []),
    pkg("baz", [], []),
    { name: "theme", type: "option", description: "theme", use: ["baz"] },
    { name: "qux", type: "pipeline", description: "qux", use: ["bar"], files: [{ to: "/etc/qux", content: "qux" }] },
  ],
}));

const LANDING = "https://foo.test/pages/delo/?qux=1#quux";

const codeOf = (href: string) => new URL(href).searchParams.get(DELO_SHARE_PARAM)!;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("a share link rebuilds the same draft from the registry", () => {
  let draft = createDeloDraft("corge");
  draft = { ...draft, pipeline: { ...draft.pipeline, name: "grault", description: "garply" } };
  draft = { ...draft, ...planDeloAdd(REGISTRY, draft, "foo").configuration };
  draft = { ...draft, ...planDeloAdd(REGISTRY, draft, "qux").configuration };
  draft = { ...draft, ...planDeloEnable(REGISTRY, draft, "theme").configuration };
  draft = { ...draft, ...planDeloRemove(REGISTRY, draft, "bar").configuration };
  const url = new URL(deloShareUrl(REGISTRY, draft, LANDING));
  assert.equal(`${url.origin}${url.pathname}${url.hash}`, "https://foo.test/pages/delo/");
  assert.deepEqual([...url.searchParams.keys()], [DELO_SHARE_PARAM]);
  assert.deepEqual(draftFromShare(REGISTRY, codeOf(url.href)), { draft, warnings: [] });
});

test("a shared first process of null stays null", () => {
  const code = encode({ version: 3, name: "corge", pipelineName: "corge-pipeline", pipelineDescription: "", added: [], use: ["foo"], enable: [], firstProcess: null });
  assert.equal(draftFromShare(REGISTRY, code).draft.firstProcess, null);
});

test("refuses to share a pipeline its names do not rebuild", () => {
  const draft = createDeloDraft("corge");
  const written = { ...draft, pipeline: { ...draft.pipeline, files: [{ to: "/etc/grault", content: "grault" }] } };
  assert.throws(() => deloShareUrl(REGISTRY, written, LANDING), /corge has a pipeline the registered names it was made from do not rebuild/);
});

test("refuses a malformed, oversized, or unknown share", () => {
  const valid = { version: 3, name: "corge", pipelineName: "corge-pipeline", pipelineDescription: "", added: [], use: [], enable: [], firstProcess: null };
  assert.throws(() => draftFromShare(REGISTRY, "%%%"), /not a delo share link/);
  assert.throws(() => draftFromShare(REGISTRY, "a".repeat(4097)), /exceeds 4096 characters/);
  for (const value of [[], { ...valid, version: 1 }, { ...valid, name: "co rge" }, { ...valid, use: "foo" }, { ...valid, grault: 1 }]) {
    assert.throws(() => draftFromShare(REGISTRY, encode(value)), /the share link is invalid/);
  }
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...valid, use: ["garply"] })), /garply is not a registered binary or pipeline/);
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...valid, added: ["foo"] })), /foo is not a registered pipeline/);
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...valid, enable: ["waldo"] })), /waldo is not an option/);
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...valid, firstProcess: "foo" })), /the shared first process foo is not installed/);
  const current = { ...valid, version: 3, pipelineName: "corge-pipeline", pipelineDescription: "" };
  for (const value of [{ ...current, pipelineName: 1 }, { ...current, pipelineDescription: "a".repeat(501) }, { ...current, version: 2 }]) {
    assert.throws(() => draftFromShare(REGISTRY, encode(value)), /the share link is invalid/);
  }
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...current, pipelineName: "qux" })), /pipeline name is refused: qux is already the name of a registry entry/);
  assert.throws(() => draftFromShare(REGISTRY, encode({ ...current, pipelineName: "Qux" })), /pipeline name is refused: a pipeline name holds lowercase letters/);
});

test("a shared draft keeps its name, or takes the next free -shared name", () => {
  assert.equal(sharedDraftName("foo", ["bar"]), "foo");
  assert.equal(sharedDraftName("foo", ["Foo"]), "foo-shared");
  assert.equal(sharedDraftName("foo", ["foo", "foo-shared"]), "foo-shared-2");
  assert.equal(sharedDraftName("foo", ["foo", "foo-shared", "FOO-SHARED-2"]), "foo-shared-3");
  const long = "a".repeat(120);
  assert.equal(sharedDraftName(long, [long]), `${"a".repeat(113)}-shared`);
  assert.equal(sharedDraftName(long, [long, `${"a".repeat(113)}-shared`]).length, 120);
});

test("a session link keeps the delo page and its parameters, and names the session", () => {
  const room = "abcdefghijklmnopqrstuvwx";
  const share = deloShareUrl(REGISTRY, createDeloDraft("corge"), LANDING);
  const link = new URL(withDeloSession(share, room, "grault"));
  assert.equal(link.pathname, "/pages/delo/");
  assert.equal(link.searchParams.get(DELO_SHARE_PARAM), new URL(share).searchParams.get(DELO_SHARE_PARAM));
  assert.deepEqual(sessionInvitation(link.href), { room, name: "grault" });
  const computer = new URL(withDeloSession("https://foo.test/pages/delo/computer/?computer=garply", room, "grault"));
  assert.equal(computer.searchParams.get("computer"), "garply");
  assert.deepEqual(sessionInvitation(computer.href), { room, name: "grault" });
  assert.equal(withoutDeloSession(computer.href), "https://foo.test/pages/delo/computer/?computer=garply");
});
