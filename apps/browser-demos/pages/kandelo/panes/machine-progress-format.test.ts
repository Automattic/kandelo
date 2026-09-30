import assert from "node:assert/strict";
import test from "node:test";

import { formatMachineProgress } from "./machine-progress-format.ts";

test("a provisional teardown total is marked with a plus", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 3, total: 7,
    totalProvisional: true, unit: "processes", status: "loading",
  });
  assert.equal(f.headline, "Unloading Bare shell");
  assert.equal(f.detail, "3 of 7+ processes");
  assert.equal(f.valueText, "3 of at least 7 processes");
});

test("a final teardown total drops the plus", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 9, total: 9,
    totalProvisional: false, unit: "processes", status: "loading",
  });
  assert.equal(f.detail, "9 of 9 processes");
  assert.equal(f.valueText, "9 of 9 processes");
  assert.equal(f.percent, 100);
});

test("image progress reads in binary units", () => {
  const f = formatMachineProgress({
    phase: "image", label: "browser-main-shell image",
    completed: 1024 * 1024, total: 2 * 1024 * 1024,
    unit: "bytes", status: "loading",
  });
  assert.equal(f.headline, "Loading browser-main-shell image");
  assert.equal(f.detail, "1.0 MiB / 2.0 MiB");
  assert.equal(f.percent, 50);
});

test("no total yields no percentage", () => {
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 0,
    unit: "processes", status: "loading",
  });
  assert.equal(f.percent, null);
  assert.equal(f.detail, "0 processes");
});

test("an error shows its message rather than a count", () => {
  const f = formatMachineProgress({
    phase: "image", label: "custom.vfs.zst", completed: 0,
    unit: "bytes", status: "error", error: "custom.vfs.zst returned HTTP 503",
  });
  assert.equal(f.detail, "custom.vfs.zst returned HTTP 503");
});

test("a receded total never yields a percentage above 100", () => {
  // Review Focus 3's UI side: the total may grow under a finished count.
  const f = formatMachineProgress({
    phase: "destroying", label: "Bare shell", completed: 7, total: 9,
    totalProvisional: false, unit: "processes", status: "loading",
  });
  assert.ok(f.percent !== null && f.percent < 100);
});
