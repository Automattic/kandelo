import assert from "node:assert/strict";
import test from "node:test";

import {
  destroyProgressToMachineProgress,
  initialDestroyProgress,
  subscribeDestroyProgress,
} from "./machine-progress.ts";
import type {
  DestroyProgressEvent,
  MachineProgress,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

test("teardown starts indeterminate, before any count is known", () => {
  // Phase 1 is one awaited call with no granularity, so there is nothing to
  // report until the first draining event lands.
  assert.deepEqual(initialDestroyProgress("Bare shell"), {
    phase: "destroying",
    label: "Bare shell",
    completed: 0,
    unit: "processes",
    status: "loading",
  });
});

test("a draining event becomes a provisional-total machine progress", () => {
  assert.deepEqual(
    destroyProgressToMachineProgress("Bare shell", {
      phase: "draining", completed: 3, total: 7, totalProvisional: true,
    }),
    {
      phase: "destroying",
      label: "Bare shell",
      completed: 3,
      total: 7,
      totalProvisional: true,
      unit: "processes",
      status: "loading",
    },
  );
});

test("a terminating event carries a final total", () => {
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "terminating", completed: 9, total: 9, totalProvisional: false,
  });
  assert.equal(progress.totalProvisional, false);
  assert.equal(progress.total, 9);
});

test("a zero total is reported as indeterminate, not as complete", () => {
  // Review Focus 1: 0 of 0 must not render as a finished bar.
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "draining", completed: 0, total: 0, totalProvisional: true,
  });
  assert.equal(progress.total, undefined);
  assert.equal(progress.completed, 0);
});

test("a kernel without destroy progress degrades to a no-op", () => {
  // Review Focus 5. subscribeDestroyProgress is optional on KernelLike; a
  // kernel that lacks it must leave the phase indeterminate, not throw.
  const published: MachineProgress[] = [];
  const off = subscribeDestroyProgress(
    {}, "Bare shell", () => true, (p) => published.push(p),
  );
  assert.equal(typeof off, "function");
  off();
  assert.deepEqual(published, []);
});

test("drops events from a superseded switch", () => {
  // Review Focus 4. A stale kernel finishing its teardown must not drive the
  // overlay of the switch that replaced it.
  const published: MachineProgress[] = [];
  let emit: ((e: DestroyProgressEvent) => void) | undefined;
  const kernel = {
    subscribeDestroyProgress(cb: (e: DestroyProgressEvent) => void) {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
  let current = true;
  subscribeDestroyProgress(
    kernel, "Bare shell", () => current, (p) => published.push(p),
  );
  emit!({ phase: "draining", completed: 1, total: 4, totalProvisional: true });
  current = false;
  emit!({ phase: "draining", completed: 2, total: 4, totalProvisional: true });
  assert.equal(published.length, 1);
  assert.equal(published[0]!.completed, 1);
});

test("unsubscribing stops delivery", () => {
  const published: MachineProgress[] = [];
  let emit: ((e: DestroyProgressEvent) => void) | undefined;
  const kernel = {
    subscribeDestroyProgress(cb: (e: DestroyProgressEvent) => void) {
      emit = cb;
      return () => { emit = undefined; };
    },
  };
  const off = subscribeDestroyProgress(
    kernel, "Bare shell", () => true, (p) => published.push(p),
  );
  off();
  assert.equal(emit, undefined);
  assert.deepEqual(published, []);
});

test("retains no object references from the event", () => {
  const progress = destroyProgressToMachineProgress("Bare shell", {
    phase: "draining", completed: 1, total: 2, totalProvisional: true,
  });
  for (const value of Object.values(progress)) {
    assert.ok(
      ["string", "number", "boolean"].includes(typeof value),
      `progress field retained a ${typeof value}`,
    );
  }
});
