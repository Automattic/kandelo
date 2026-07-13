import assert from "node:assert/strict";
import test from "node:test";
import {
  withRejectingTimeout,
  type TimeoutScheduler,
} from "./timeout.js";

function controlledScheduler(): {
  scheduler: TimeoutScheduler;
  fire: () => void;
  clearCount: () => number;
} {
  let callback: (() => void) | undefined;
  let clears = 0;
  const handle = Symbol("timeout") as unknown as ReturnType<typeof setTimeout>;
  return {
    scheduler: {
      setTimeout(nextCallback) {
        callback = nextCallback;
        return handle;
      },
      clearTimeout(receivedHandle) {
        assert.equal(receivedHandle, handle);
        clears++;
      },
    },
    fire: () => callback?.(),
    clearCount: () => clears,
  };
}

test("clears the timeout when the operation completes", async () => {
  const controlled = controlledScheduler();
  const result = await withRejectingTimeout(
    Promise.resolve("done"),
    100,
    "too slow",
    controlled.scheduler,
  );

  assert.equal(result, "done");
  assert.equal(controlled.clearCount(), 1);
});

test("rejects at the deadline and clears the timeout", async () => {
  const controlled = controlledScheduler();
  const pending = new Promise<never>(() => {});
  const result = withRejectingTimeout(
    pending,
    100,
    "benchmark round timed out",
    controlled.scheduler,
  );
  controlled.fire();

  await assert.rejects(result, /benchmark round timed out/);
  assert.equal(controlled.clearCount(), 1);
});
