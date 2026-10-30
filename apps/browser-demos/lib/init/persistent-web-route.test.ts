import assert from "node:assert/strict";
import test from "node:test";
import { persistentWebRouteLock, persistentWebRouteName } from "./persistent-web-route";

test("persistent routes derive from the computer and deployment, not the boot session", async () => {
  const first = await persistentWebRouteName("/demo/", "computer-one");
  assert.match(first, /^p-[a-f0-9]{64}$/);
  assert.equal(await persistentWebRouteName("/demo/", "computer-one"), first);
  assert.notEqual(await persistentWebRouteName("/other/", "computer-one"), first);
  assert.notEqual(await persistentWebRouteName("/demo/", "computer-two"), first);
  assert.equal(persistentWebRouteLock("/demo/", first), `kandelo-http-route:/demo/${first}`);
});

test("persistent routing rejects invalid computer identities", async () => {
  for (const name of ["", "../computer", "a".repeat(129), "computer/one"]) {
    await assert.rejects(persistentWebRouteName("/demo/", name), /invalid persistent computer name/);
  }
});
