import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserKernel } from "@host/browser-kernel-host";
import { UnconfirmedPersistentKernelQuiescence, withPersistentKernelCleanup } from "./persistent-kernel-lifecycle";

test("successful persistent operations return only after cleanup", async () => {
  const events: string[] = [];
  const result = await withPersistentKernelCleanup(
    async () => { events.push("operation"); return 42; },
    async () => { events.push("cleanup"); },
  );
  assert.equal(result, 42);
  assert.deepEqual(events, ["operation", "cleanup"]);
});

test("persistent operation failure survives successful cleanup unchanged", async () => {
  const failure = new Error("export EIO");
  await assert.rejects(withPersistentKernelCleanup(
    async () => { throw failure; }, async () => {},
  ), error => error === failure);
});

test("cleanup failure survives a successful operation unchanged", async () => {
  const failure = new Error("close failed");
  await assert.rejects(withPersistentKernelCleanup(
    async () => 42, async () => { throw failure; },
  ), error => error === failure);
});

test("ordinary dual failure retains both original errors", async () => {
  const operationError = new Error("export ENOMEM");
  const cleanupError = new Error("sync EIO");
  await assert.rejects(withPersistentKernelCleanup(
    async () => { throw operationError; }, async () => { throw cleanupError; },
  ), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, cleanupError]);
    assert.match(error.message, /export ENOMEM.*sync EIO/);
    return true;
  });
});

test("unconfirmed cleanup retains the kernel ownership brand and both failures", async () => {
  const kernel = {} as BrowserKernel;
  const operationError = new Error("export EIO");
  const destroyError = new Error("OPFS close failed");
  const cleanupError = new UnconfirmedPersistentKernelQuiescence(kernel, { cause: destroyError });
  await assert.rejects(withPersistentKernelCleanup(
    async () => { throw operationError; }, async () => { throw cleanupError; },
  ), error => {
    assert.ok(error instanceof UnconfirmedPersistentKernelQuiescence);
    assert.equal(error.kernel, kernel);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [operationError, cleanupError]);
    assert.equal(cleanupError.cause, destroyError);
    assert.match(error.message, /export EIO.*OPFS close failed/);
    return true;
  });
});

test("even an undefined thrown value is retained in a dual failure", async () => {
  const cleanupError = new Error("close failed");
  await assert.rejects(withPersistentKernelCleanup(
    async () => { throw undefined; }, async () => { throw cleanupError; },
  ), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [undefined, cleanupError]);
    return true;
  });
});
