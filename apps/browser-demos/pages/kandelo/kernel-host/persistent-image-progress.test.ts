import assert from "node:assert/strict";
import test from "node:test";
import { persistentImageProgress, runWithPersistentImageProgress, type PersistentImageProgress } from "./persistent-image-progress";
import { syslogRows } from "../panes/syslog-progress";
import type { DmesgLine } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { ImageCodecProgress } from "./persistent-image-codec-protocol";

test("persistent write and verification update separate rows and retain raw records", async () => {
  const reports: ImageCodecProgress[] = [
    { phase: "write", bytes: 1, total: 100 },
    { phase: "write", bytes: 100, total: 100 },
    { phase: "verify", bytes: 1, total: 100 },
    { phase: "verify", bytes: 100, total: 100 },
  ];
  const updates: PersistentImageProgress[] = [];
  assert.equal(await runWithPersistentImageProgress(async update => { for (const report of reports) update(report); return "verified"; }, progress => { updates.push(progress); }), "verified");
  const lines: DmesgLine[] = updates.map((progress, index) => ({ t: index, level: "info", facility: "image", msg: `persistent image ${progress.phase}: ${progress.bytes}/${progress.total}`,
    progress: persistentImageProgress("boot-1", progress) }));
  assert.equal(lines[0].progress?.status, "loading");
  assert.equal(lines[1].progress?.status, "loading");
  assert.equal(lines[2].progress?.status, "complete");
  assert.equal(lines[0].progress?.label, "Writing persistent image");
  assert.equal(lines[3].progress?.label, "Verifying persistent image");
  assert.deepEqual(syslogRows(lines, false), [lines[2], lines[5]]);
  assert.deepEqual(syslogRows(lines, true), lines);
  assert.notEqual(lines[0].progress?.id, persistentImageProgress("boot-2", { phase: "write", bytes: 1, total: 100, status: "loading" }).id);
});

for (const phase of ["write", "verify"] as const) {
  test(`persistent ${phase} stays unfinished at the byte total and records a finalization failure`, async () => {
    const failure = new Error(phase === "write" ? "final header flush failed" : "handle closure unproven");
    const updates: PersistentImageProgress[] = [];
    await assert.rejects(runWithPersistentImageProgress(async update => {
      update({ phase: "write", bytes: 100, total: 100 });
      if (phase === "verify") update({ phase: "verify", bytes: 100, total: 100 });
      assert.equal(updates.at(-1)?.status, "loading");
      throw failure;
    }, progress => { updates.push(progress); }), error => error === failure);
    const final = persistentImageProgress("boot", updates.at(-1)!);
    assert.equal(final.status, "error");
    assert.equal(final.id, `boot/persistent-image/${phase}`);
    assert.equal(final.completed, 100);
  });
}

test("a failing error reporter preserves the original persistent image failure", async () => {
  const failure = new Error("handle closure unproven");
  const reporterFailure = new Error("reporter failed");
  await assert.rejects(runWithPersistentImageProgress(async update => {
    update({ phase: "verify", bytes: 100, total: 100 });
    throw failure;
  }, progress => {
    if (progress.status === "error") throw reporterFailure;
  }), error => error === failure);
});
