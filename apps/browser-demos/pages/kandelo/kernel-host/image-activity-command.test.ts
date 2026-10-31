import assert from "node:assert/strict";
import { test } from "node:test";
import { retryImageActivityCleanup, runImageActivityCommand } from "./image-activity-command";
import type { KernelHost, KernelOwnedJobRead } from "../../../../../web-libs/kandelo-session/src/kernel-host";

function fixture(read: (cancel: boolean) => KernelOwnedJobRead) {
  const started: unknown[][] = [];
  const released: string[] = [];
  const cancelled: string[] = [];
  const host = {
    startOwnedJob: async (...args: unknown[]) => { started.push(args); },
    readOwnedJob: async (id: string, _offset: number, limit: number, cancel = false) => { assert(limit >= 1); if (cancel) cancelled.push(id); return read(cancel); },
    releaseOwnedJob: async (id: string) => { released.push(id); },
  } as unknown as KernelHost;
  host.captureOwnedJobs = () => ({ closed: () => false, start: host.startOwnedJob.bind(host), read: host.readOwnedJob.bind(host), release: host.releaseOwnedJob.bind(host) });
  return { host, started, released, cancelled };
}

const complete: KernelOwnedJobRead = { expired: false, pid: 101, status: "completed", exitCode: 0, terminationObserved: true, chunks: [], next: 0, hasMore: false, truncated: false };

test("service preparation runs as the declared terminal account and releases the observed command family", async () => {
  const state = fixture(() => complete);
  const account = { uid: 1000, gid: 1000, env: ["HOME=/home/maker"] };
  await runImageActivityCommand(state.host, "/usr/local/bin/kandelo-service start web-php", account, () => {});
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.started[0].slice(1), ["/bin/sh", ["sh", "-c", "/usr/local/bin/kandelo-service start web-php"], { ...account, timeoutMs: 110000 }]);
  assert.equal(state.released.length, 1);
  assert.equal(state.cancelled.length, 0);
});

test("a guest service failure surfaces its actual output and does not report success", async () => {
  const state = fixture(() => ({ ...complete, exitCode: 1, chunks: [{ stream: "stderr", bytes: new TextEncoder().encode("backend change refused") }] }));
  await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => {}), /backend change refused/);
  assert.equal(state.released.length, 1);
});

test("superseding a preparation cancels only its owned family before releasing it", async () => {
  const state = fixture(() => complete);
  let assertions = 0;
  await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => { if (++assertions > 2) throw new Error("superseded"); }), /superseded/);
  assert.equal(state.cancelled.length, 1);
  assert.equal(state.released.length, 1);
});

test("an unconfirmed cancellation retains its worker-owned record instead of falsely releasing it", async () => {
  let finished = false;
  const state = fixture(() => finished ? complete : ({ ...complete, status: "cancelling", exitCode: null, terminationObserved: false }));
  let assertions = 0;
  await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => { if (++assertions > 2) throw new Error("superseded"); }), /superseded/);
  assert.equal(state.cancelled.length, 1);
  assert.equal(state.released.length, 0);
  finished = true;
  await retryImageActivityCleanup();
  assert.equal(state.released.length, 1);
});

test("an uncertain start failure still cancels and retires the original owner", async () => {
  const state = fixture(() => complete);
  state.host.startOwnedJob = async () => { throw new Error("start acknowledgement lost"); };
  await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => {}), /acknowledgement lost/);
  assert.equal(state.cancelled.length, 1);
  assert.equal(state.released.length, 1);
});

test("failed release retains cleanup authority until a later retry succeeds", async () => {
  const state = fixture(() => complete);
  let attempts = 0;
  state.host.releaseOwnedJob = async () => { if (++attempts === 1) throw new Error("temporarily unavailable"); };
  await runImageActivityCommand(state.host, "service-command", {}, () => {});
  assert.equal(attempts, 1);
  await retryImageActivityCleanup();
  assert.equal(attempts, 2);
});

test("pending cleanup is bounded and confirmed owner retirement frees its admission slots", async () => {
  const state = fixture(() => ({ ...complete, status: "cancelling", exitCode: null, terminationObserved: false }));
  let closed = false;
  const capture = state.host.captureOwnedJobs!.bind(state.host);
  state.host.captureOwnedJobs = () => ({ ...capture(), closed: () => closed });
  for (let index = 0; index < 8; index++) {
    let assertions = 0;
    await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => { if (++assertions > 2) throw new Error("superseded"); }), /superseded/);
  }
  await assert.rejects(runImageActivityCommand(state.host, "service-command", {}, () => {}), /no command slot/);
  assert.equal(state.started.length, 8);
  assert.equal(state.released.length, 0);
  closed = true;
  await retryImageActivityCleanup();
  const next = fixture(() => complete);
  await runImageActivityCommand(next.host, "service-command", {}, () => {});
  assert.equal(next.started.length, 1);
});
