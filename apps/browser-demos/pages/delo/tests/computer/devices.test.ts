import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_DELO_PIPELINE } from "../../src/draft";
import { deloDevicesOf, deloShownDevice, imageDevicesOf } from "../../src/computer/devices";

const entry = (provide: string[], device: string[]) => ({ ...EMPTY_DELO_PIPELINE, provide, device });

const [FOO, BAR, BAZ, QUX, QUUX] = [entry(["init", "shell"], []), entry([], ["fb0"]), entry(["web"], []), entry([], ["card0"]), entry(["init"], [])];

test("lists the devices the installed binaries and the pipeline provide, in toolbar order", () => {
  assert.deepEqual(deloDevicesOf([BAZ, BAR, FOO, QUX]), ["terminal", "framebuffer", "kms", "web"]);
  assert.deepEqual(deloDevicesOf([BAR]), ["framebuffer"]);
});

test("lists no device for binaries that provide none", () => {
  assert.deepEqual(deloDevicesOf([]), []);
  assert.deepEqual(deloDevicesOf([QUUX]), []);
});

test("lists only the first device an image's presentation prefers, and never syslog", () => {
  const presentation = { bootPrimary: "syslog", terminalAccess: "drawer", internalsAccess: "drawer" } as const;
  assert.deepEqual(imageDevicesOf({ ...presentation, runningPrimary: ["kms", "terminal", "syslog"] }), ["kms"]);
  assert.deepEqual(imageDevicesOf({ ...presentation, runningPrimary: ["syslog", "framebuffer"] }), ["framebuffer"]);
  assert.deepEqual(imageDevicesOf({ ...presentation, runningPrimary: ["syslog"] }), []);
});

const AVAILABLE = { terminal: true, framebuffer: true, kms: true, web: true };
const NONE = { terminal: false, framebuffer: false, kms: false, web: false };

test("shows the first available device in the order kms, web, framebuffer, terminal", () => {
  assert.equal(deloShownDevice(["terminal", "framebuffer", "kms", "web"], AVAILABLE), "kms");
  assert.equal(deloShownDevice(["terminal", "framebuffer", "web"], AVAILABLE), "web");
  assert.equal(deloShownDevice(["terminal", "framebuffer"], AVAILABLE), "framebuffer");
  assert.equal(deloShownDevice(["framebuffer", "kms", "web"], { ...AVAILABLE, kms: false }), "web");
});

test("shows the first device in that order while none is available", () => {
  assert.equal(deloShownDevice(["terminal", "framebuffer", "web"], NONE), "web");
});

test("shows the terminal only when it is the sole device", () => {
  assert.equal(deloShownDevice(["terminal", "framebuffer"], { ...AVAILABLE, framebuffer: false }), "framebuffer");
  assert.equal(deloShownDevice(["terminal"], NONE), "terminal");
  assert.equal(deloShownDevice([], AVAILABLE), null);
});
