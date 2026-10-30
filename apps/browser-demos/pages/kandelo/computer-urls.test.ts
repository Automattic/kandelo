import assert from "node:assert/strict";
import test from "node:test";
import { computerUrl, galleryItemUrl } from "./url-state";
import { browserComputerStorageName, browserComputerIdForStorageName, browserJournalBelongsToComputer, browserReplacementJournalName } from "../../../../host/src/browser-computer-storage";

const id = "11111111-1111-4111-8111-111111111111";

test("computer URLs identify one local computer without retaining template or script selections", () => {
  const url = new URL(computerUrl(id, "https://example.com/kandelo/?vfs=https://example.com/a.vfs&profile=shell&experimentalPersistence=old&experimentalPersistenceMode=fixed&experimentalPersistenceIntegrity=sha256&memoryProfile=constrained#k1=script"));
  assert.equal(url.pathname, "/kandelo/");
  assert.deepEqual([...url.searchParams], [["memoryProfile", "constrained"], ["computer", id]]);
  assert.equal(url.hash, "");
});

test("template links never reopen or reveal the current local computer", () => {
  const url = new URL(galleryItemUrl({ id: "wordpress-mariadb", vfsImageUrl: "https://example.com/lamp.vfs.zst" }, `https://example.com/?computer=${id}#k1=old`));
  assert.equal(url.searchParams.has("computer"), false);
  assert.equal(url.searchParams.get("profile"), "wordpress-mariadb");
  assert.equal(url.searchParams.get("vfs"), "https://example.com/lamp.vfs.zst");
  assert.equal(url.hash, "");
});

test("replacement journals stay inside their owning machine namespace", () => {
  const name = browserComputerStorageName(id);
  const replacement = browserReplacementJournalName(name);
  assert.equal(browserComputerIdForStorageName(name), id);
  assert.equal(browserComputerIdForStorageName(replacement), id);
  assert.equal(browserJournalBelongsToComputer(name, replacement), true);
  assert.equal(browserJournalBelongsToComputer(name, `j-${crypto.randomUUID()}`), false);
  assert.equal(browserJournalBelongsToComputer(browserComputerStorageName(crypto.randomUUID()), replacement), false);
  assert.throws(() => browserComputerStorageName("../other"));
  assert.equal(browserComputerIdForStorageName(`${name}_other`), null);
});
