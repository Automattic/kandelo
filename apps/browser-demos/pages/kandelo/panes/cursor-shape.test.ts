import assert from "node:assert/strict";
import test from "node:test";

import { cssCursor } from "./cursor-shape.ts";

test("shape 0 hides the host pointer", () => {
  assert.equal(cssCursor(0), "none");
});

test("wp_cursor_shape_device_v1 shapes name their CSS cursors", () => {
  assert.equal(cssCursor(1), "default");
  assert.equal(cssCursor(4), "pointer");
  assert.equal(cssCursor(16), "grab");
  assert.equal(cssCursor(26), "ew-resize");
  assert.equal(cssCursor(34), "zoom-out");
});

test("a shape past zoom_out shows the default pointer", () => {
  assert.equal(cssCursor(35), "default");
  assert.equal(cssCursor(-1), "default");
});
