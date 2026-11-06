import assert from "node:assert/strict";
import test from "node:test";
import { syslogRows } from "./syslog-progress";
import type { DmesgLine } from "../../../../../web-libs/kandelo-session/src/kernel-host";

test("typed operations update their own stable row without parsing log text", () => {
  const first: DmesgLine = { t: 1, facility: "image", level: "info", msg: "read 1", progress: { id: "boot-1/read", label: "Reading", completed: 1, unit: "bytes", status: "loading" } };
  const ordinary: DmesgLine = { t: 2, facility: "kernel", level: "info", msg: "checking 20%" };
  const last: DmesgLine = { ...first, t: 3, msg: "read 2", progress: { ...first.progress!, completed: 2, status: "complete" } };
  const nextBoot = { ...first, progress: { ...first.progress!, id: "boot-2/read" } };
  assert.deepEqual(syslogRows([first, ordinary, last, nextBoot], false), [last, ordinary, nextBoot]);
  assert.deepEqual(syslogRows([first, ordinary, last], true), [first, ordinary, last]);
});

test("warnings and errors are never overwritten by progress updates", () => {
  const first: DmesgLine = { t: 1, facility: "image", level: "info", msg: "reading", progress: { id: "read", label: "Reading", completed: 1, unit: "bytes", status: "loading" } };
  const warning: DmesgLine = { ...first, level: "warn", msg: "retry" };
  const error: DmesgLine = { ...first, progress: { ...first.progress!, status: "error" }, msg: "failed" };
  const last: DmesgLine = { ...first, msg: "done", progress: { ...first.progress!, status: "complete" } };
  assert.deepEqual(syslogRows([first, warning, error], false), [error, warning]);
  assert.deepEqual(syslogRows([first, warning, error, last], false), [error, warning, last]);
});
