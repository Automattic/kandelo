import assert from "node:assert/strict";
import test from "node:test";

import { ToolError } from "../../../kandelo/webmcp/contract";
import { deloDeviceTools, type DeloSurfaces, type OpenDevice } from "../../src/computer/webmcp";

const names = (devices: Parameters<typeof deloDeviceTools>[0]) => deloDeviceTools(devices).map((tool) => `${tool.name}:${tool.device}`);

test("a computer with no device has no tool", () => {
  assert.deepEqual(names([]), []);
});

test("each device gives its own tools", () => {
  assert.deepEqual(names(["terminal"]), ["device_terminal_read:terminal", "device_terminal_type:terminal"]);
  assert.deepEqual(names(["framebuffer"]), ["device_framebuffer_screenshot:framebuffer", "device_keyboard_press:framebuffer", "device_pointer_move:framebuffer", "device_pointer_click:framebuffer"]);
  assert.deepEqual(names(["kms"]), ["device_display_screenshot:kms", "device_keyboard_press:kms", "device_pointer_move:kms", "device_pointer_click:kms"]);
  assert.deepEqual(names(["web"]), ["device_web_open:web", "device_web_read:web"]);
});

test("the display wins device_keyboard_press and the pointer over the framebuffer", () => {
  assert.deepEqual(names(["framebuffer", "kms"]), [
    "device_framebuffer_screenshot:framebuffer",
    "device_display_screenshot:kms",
    "device_keyboard_press:kms",
    "device_pointer_move:kms",
    "device_pointer_click:kms",
  ]);
});

test("every tool takes an object of arguments and refuses unknown ones", () => {
  for (const tool of deloDeviceTools(["terminal", "framebuffer", "kms", "web"])) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

const opened = (surfaces: Partial<{ [D in keyof DeloSurfaces]: Partial<DeloSurfaces[D]> }>): OpenDevice =>
  ((device) => surfaces[device] ?? null) as OpenDevice;

const run = (device: keyof DeloSurfaces, name: string, open: OpenDevice, args: Record<string, unknown> = {}) =>
  deloDeviceTools([device]).find((tool) => tool.name === name)!.run(open, args);

const refuses = (code: string) => (error: unknown) => error instanceof ToolError && error.code === code;

test("a tool of a device that cannot open is not ready", async () => {
  await assert.rejects(run("terminal", "device_terminal_read", opened({})), refuses("NOT_READY"));
});

test("the terminal tools read the screen and type once the terminal is attached", async () => {
  const typed: string[] = [];
  const open = opened({ terminal: { screen: () => "foo\nbar", type: (text) => typed.push(text) > 0 } });
  assert.deepEqual(await run("terminal", "device_terminal_read", open), { screen: "foo\nbar" });
  assert.deepEqual(await run("terminal", "device_terminal_type", open, { text: "baz\n" }), { delivered: true });
  assert.deepEqual(typed, ["baz\n"]);
  await assert.rejects(run("terminal", "device_terminal_type", opened({ terminal: { type: () => false } }), { text: "baz" }), refuses("NOT_READY"));
});

test("device_keyboard_press takes one to eight keys the device has", async () => {
  const pressed: [readonly string[], number][] = [];
  const kms = { knows: (code: string) => code !== "Foo", press: async (codes: readonly string[], holdMs: number) => { pressed.push([codes, holdMs]); } };
  const open = opened({ kms });
  assert.deepEqual(await run("kms", "device_keyboard_press", open, { keys: ["ControlLeft", "KeyC"] }), { pressed: ["ControlLeft", "KeyC"] });
  await run("kms", "device_keyboard_press", open, { keys: ["Enter"], holdMs: 5 });
  assert.deepEqual(pressed, [[["ControlLeft", "KeyC"], 100], [["Enter"], 5]]);
  for (const keys of [[], Array(9).fill("KeyA"), ["Foo"], [1]]) {
    await assert.rejects(run("kms", "device_keyboard_press", open, { keys }), refuses("INVALID_ARGUMENT"));
  }
  const idle = opened({ framebuffer: { knows: () => true, press: async () => false } });
  await assert.rejects(run("framebuffer", "device_keyboard_press", idle, { keys: ["KeyA"] }), refuses("NOT_READY"));
});

test("the display pointer stays inside the scanout, and a click presses then releases", async () => {
  const points: number[][] = [];
  const kms = { scanout: () => ({ width: 4, height: 3 }), point: (x: number, y: number, buttons: number) => { points.push([x, y, buttons]); } };
  assert.deepEqual(await run("kms", "device_pointer_move", opened({ kms }), { x: 3, y: 2 }), { x: 3, y: 2 });
  assert.deepEqual(await run("kms", "device_pointer_click", opened({ kms }), { x: 1, y: 1, button: "right" }), { x: 1, y: 1 });
  assert.deepEqual(points, [[3, 2, 0], [1, 1, 0], [1, 1, 2], [1, 1, 0]]);
  await assert.rejects(run("kms", "device_pointer_move", opened({ kms }), { x: 4, y: 0 }), refuses("INVALID_ARGUMENT"));
  await assert.rejects(run("kms", "device_pointer_move", opened({ kms: { scanout: () => null } }), { x: 0, y: 0 }), refuses("NOT_READY"));
});

test("the framebuffer pointer moves by a delta and clicks where the cursor is", async () => {
  const moves: number[][] = [];
  const open = opened({ framebuffer: { move: (dx, dy, buttons) => moves.push([dx, dy, buttons]) > 0 } });
  assert.deepEqual(await run("framebuffer", "device_pointer_move", open, { dx: 2, dy: -3 }), { dx: 2, dy: -3 });
  assert.deepEqual(await run("framebuffer", "device_pointer_click", open, {}), { button: "left" });
  assert.deepEqual(moves, [[2, -3, 0], [0, 0, 1], [0, 0, 0]]);
  const idle = opened({ framebuffer: { move: () => false } });
  await assert.rejects(run("framebuffer", "device_pointer_move", idle, { dx: 1, dy: 1 }), refuses("NOT_READY"));
  await assert.rejects(run("framebuffer", "device_pointer_click", idle, {}), refuses("NOT_READY"));
});

test("device_web_open takes a guest URL path and needs a running server", async () => {
  const open = opened({ web: { open: (path) => `https://foo.test${path}` } });
  assert.deepEqual(await run("web", "device_web_open", open, { path: "/index.html?x=1" }), { url: "https://foo.test/index.html?x=1" });
  for (const path of ["//foo", "/a%25b", "/a b", "/%E0%A4%A", "foo", "/../foo"]) {
    await assert.rejects(run("web", "device_web_open", open, { path }), refuses("INVALID_ARGUMENT"));
  }
  await assert.rejects(run("web", "device_web_open", opened({ web: { open: () => null } }), { path: "/" }), refuses("NOT_READY"));
});

test("device_web_read cuts the text at 262144 characters and says so", async () => {
  const page = { path: "/foo", title: "Foo", loaded: true };
  const read = (text: string) => run("web", "device_web_read", opened({ web: { read: () => ({ ...page, text }) } }));
  assert.deepEqual(await read("bar"), { ...page, text: "bar", truncated: false });
  const cut = await read("a".repeat(262145));
  assert.equal((cut.text as string).length, 262144);
  assert.equal(cut.truncated, true);
  await assert.rejects(run("web", "device_web_read", opened({ web: { read: () => null } })), refuses("NOT_READY"));
});
