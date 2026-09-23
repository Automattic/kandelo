import assert from "node:assert/strict";
import test from "node:test";

import { resolveInitArgv } from "./init-boot-identity.ts";

// Review Focus: a pasted `#k1=` link decoded by NewMachinePane/EmptyState
// hands its whole descriptor to `applyBootDescriptor`, which in `live-setup.ts`
// reaches `bootProfile` -> this decision. BOOT IDENTITY COMES FROM THE IMAGE:
// the descriptor's argv must never win, but the drop must be visible rather
// than silent.

test("a caller argv matching the image's own is not reported as ignored", () => {
  const result = resolveInitArgv(["bash", "-l", "-i"], ["bash", "-l", "-i"]);
  assert.deepEqual(result.argv, ["bash", "-l", "-i"]);
  assert.equal(result.ignoredMessage, null);
});

test("no caller argv at all (schema-only placeholder) boots the image's init silently", () => {
  const result = resolveInitArgv([], ["/sbin/dinit", "--container", "default"]);
  assert.deepEqual(result.argv, ["/sbin/dinit", "--container", "default"]);
  assert.equal(result.ignoredMessage, null);
});

test("a pasted link's differing argv is ignored, not honoured, with a visible log line", () => {
  // Every link ShareDialog has ever produced spreads the authoring
  // machine's whole boot block, so this is the common case for old links,
  // not an edge case.
  const requestedArgv = ["bash", "-l", "-i"];
  const imageArgv = ["/sbin/dinit", "--container", "wordpress"];

  const result = resolveInitArgv(requestedArgv, imageArgv);

  // The machine boots the image's own init — the caller's argv never reaches
  // kernel.spawnFromVfs.
  assert.deepEqual(result.argv, imageArgv);
  assert.notDeepEqual(result.argv, requestedArgv);
  // The drop is truthful, not silent: it names both the fact that pid 1
  // comes from the image and what that argv actually is.
  assert.equal(
    result.ignoredMessage,
    "ignoring the boot descriptor's init argv: this machine's pid 1"
      + " comes from its image (/sbin/dinit --container wordpress)",
  );
});

test("a gallery apply's stale carried-over argv is also ignored, not just link argv", () => {
  // descriptorFromGalleryItem no longer assigns boot.argv, so a gallery
  // switch's requestedDescriptor.boot.argv is whatever the PREVIOUS machine
  // happened to carry. This must be ignored exactly like a pasted link's.
  const staleArgv = ["node"];
  const imageArgv = ["bash", "-l", "-i"];

  const result = resolveInitArgv(staleArgv, imageArgv);

  assert.deepEqual(result.argv, imageArgv);
  assert.ok(result.ignoredMessage?.includes("bash -l -i"));
});
