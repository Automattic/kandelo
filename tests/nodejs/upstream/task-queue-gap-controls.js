// Diagnostic shell primitives only. These are not a task_queue binding.
"use strict";
const observations = [];
function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
}
function observe(name, callback) {
  callback(); observations.push({ name, status: "observed" });
}
if (taskQueueGapMode === "weakref") {
  let detail;
  enqueueJob(() => {
    const weak = (() => new WeakRef({}))();
    gc("shrinking");
    const before = weak.deref() !== undefined;
    drainJobQueue();
    gc("shrinking");
    detail = { before, after: weak.deref() !== undefined };
  });
  drainJobQueue();
  assert(detail.before, "target did not survive before the nested checkpoint");
  print(JSON.stringify({ kind: "task-queue-shell-weakref-observation", ...detail,
    scope: "Raw shell nested checkpoint and kept-object behavior; not Node task_queue" }));
} else if (taskQueueGapMode === "exception") {
  const order = [];
  const sentinel = new Error("TASK_QUEUE_SHELL_EXCEPTION_GAP");
  let caught = false;
  enqueueJob(() => { order.push("throw"); throw sentinel; });
  enqueueJob(() => order.push("after"));
  try { drainJobQueue(); } catch (error) { caught = error === sentinel; }
  print(JSON.stringify({ kind: "task-queue-shell-exception-gap", caught, order,
    scope: "Raw shell queue diagnostic; no Node fatal-exception routing" }));
} else {
  observe("real-engine-fifo-and-jobs-enqueued-during-checkpoint", () => {
    const order = [];
    enqueueJob(() => { order.push("queued"); enqueueJob(() => order.push("nested")); });
    Promise.resolve().then(() => order.push("promise"));
    equal(order, []);
    drainJobQueue();
    equal(order, ["queued", "promise", "nested"]);
  });
  observe("nested-checkpoint-does-not-reenter-current-job", () => {
    const order = [];
    enqueueJob(() => {
      order.push("start");
      enqueueJob(() => order.push("nested"));
      drainJobQueue();
      order.push("end");
    });
    drainJobQueue();
    equal(order, ["start", "end", "nested"]);
  });
  observe("actual-engine-rejection-and-handler-added-events", () => {
    const events = [];
    setPromiseRejectionTrackerCallback((promise, state) => events.push({ promise, state }));
    const reason = {};
    const promise = Promise.reject(reason);
    promise.catch(() => {});
    assert(events.length === 2 && events.every((event) => event.promise === promise), "promise identity");
    equal(events.map((event) => event.state), [0, 1]);
    drainJobQueue();
  });
  print(JSON.stringify({ kind: "task-queue-shell-primitives", observations,
    scope: "Shell queue primitives only; native task_queue/ticks/callback scopes are absent" }));
}
