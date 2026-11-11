"use strict";
const { internalBinding } = require("internal/test/binding");
const { writeSync } = require("node:fs");
const queue = internalBinding("task_queue");
const observations = [];
function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
}
function check(name, callback) {
  callback(); observations.push({ name, status: "pass" });
}
check("actual-binding-layout-and-native-method-lengths", () => {
  assert(queue.tickInfo instanceof Uint8Array && queue.tickInfo.length === 2, "tickInfo");
  for (const name of ["enqueueMicrotask", "runMicrotasks", "setTickCallback", "setPromiseRejectCallback"])
    assert(typeof queue[name] === "function" && queue[name].length === 0, name);
  equal(queue.promiseRejectEvents, { kPromiseRejectWithNoHandler: 0, kPromiseHandlerAddedAfterReject: 1 });
});
check("real-engine-fifo-and-jobs-enqueued-during-checkpoint", () => {
  const order = [];
  queue.enqueueMicrotask(() => { order.push("queued"); queue.enqueueMicrotask(() => order.push("nested")); });
  Promise.resolve().then(() => order.push("promise"));
  equal(order, []);
  queue.runMicrotasks();
  equal(order, ["queued", "promise", "nested"]);
});
check("nested-checkpoint-does-not-reenter-current-job", () => {
  const order = [];
  queue.enqueueMicrotask(() => {
    order.push("start");
    queue.enqueueMicrotask(() => order.push("nested"));
    queue.runMicrotasks();
    order.push("end");
  });
  queue.runMicrotasks();
  equal(order, ["start", "end", "nested"]);
});
check("nested-checkpoint-keeps-current-job-weakref-target-alive", () => {
  let detail;
  queue.enqueueMicrotask(() => {
    const weak = (() => new WeakRef({}))();
    gc();
    const before = weak.deref() !== undefined;
    queue.runMicrotasks();
    gc();
    detail = { before, after: weak.deref() !== undefined };
  });
  queue.runMicrotasks();
  assert(detail.before && detail.after, "current job target must remain alive");
});
check("microtask-exception-enters-original-node-fatal-policy", () => {
  const order = [];
  const sentinel = new Error("TASK_QUEUE_NATIVE_EXCEPTION_REFERENCE");
  let caught = false;
  function listener(error, origin) {
    assert(error === sentinel && origin === "uncaughtException", "original exception and origin");
    order.push("uncaughtException");
  }
  process.on("uncaughtException", listener);
  try {
    queue.enqueueMicrotask(() => { order.push("throw"); throw sentinel; });
    queue.enqueueMicrotask(() => order.push("after"));
    try { queue.runMicrotasks(); } catch (error) { caught = true; }
    assert(!caught, "runMicrotasks is not a synchronous rethrow");
    equal(order, ["throw", "uncaughtException", "after"]);
  } finally {
    process.removeListener("uncaughtException", listener);
  }
});
// Replaces the already bootstrapped native environment's rejection callback;
// run last and finish through synchronous output, without outstanding promises.
check("actual-native-rejection-event-promise-and-reason-identity", () => {
  const events = [];
  queue.setPromiseRejectCallback((type, promise, value) => events.push({ type, promise, value }));
  const reason = {};
  const promise = Promise.reject(reason);
  promise.catch(() => {});
  assert(events.length === 2 && events.every((event) => event.promise === promise), "promise identity");
  equal(events.map((event) => event.type), [0, 1]);
  assert(events[0].value === reason && events[1].value === undefined, "reason identity");
  queue.runMicrotasks();
});
writeSync(1, JSON.stringify({ kind: "task-queue-native-reference", version: process.version,
  exitCodes: internalBinding("errors").exitCodes,
  exitCodesDescriptor: Object.getOwnPropertyDescriptor(internalBinding("errors"), "exitCodes"),
  exitCodeEntryDescriptor: Object.getOwnPropertyDescriptor(internalBinding("errors").exitCodes, "kGenericUserError"),
  cases: observations.length, failures: 0, observations,
  limits: ["Already bootstrapped pinned native runtime; not guest startup or full queue/async conformance"] }) + "\n");
