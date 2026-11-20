import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import type { DeloNetwork, DeloNetworkState } from "../../src/computer/network";
import { deloPageTools, type DeloPageHandles } from "../../src/computer/page-tools";

const names = (options: string[]) => deloPageTools(options).map((tool) => tool.name);

const tool = (name: string) => deloPageTools(["network", "internals", "share", "sound"]).find((entry) => entry.name === name)!;

const STATE: DeloNetworkState = { phase: "connected", link: "https://foo.test/?network=bar", address: "10.89.0.1", members: [], error: null };

const host = (status: string) => ({
  getStatus: () => status,
  getAudioState: () => "running",
  enumProcs: async () => [{ pid: 1, ppid: 0, user: "root", state: "R", cmdline: "init", memory: "" }],
}) as unknown as KernelHost;

const handles = (overrides: Partial<DeloPageHandles> = {}): DeloPageHandles => ({ host: host("running"), back: async () => {}, network: null, share: null, sound: null, ...overrides });

const network = (state: DeloNetworkState): DeloNetwork => ({
  read: () => state,
  create: async () => state,
  join: (link) => {
    if (!link.includes("network=")) throw new Error("this is not a network session link");
    return Promise.resolve(state);
  },
  leave: async () => ({ ...state, phase: "offline" }),
});

test("every page has delo_page, and an option gives its tools", () => {
  assert.deepEqual(names([]), ["delo_page"]);
  assert.deepEqual(names(["network"]), ["delo_page", "option_network_read", "option_network_create", "option_network_join", "option_network_leave"]);
  assert.deepEqual(names(["internals", "share", "sound"]), ["delo_page", "option_internals_read", "option_share_read", "option_sound_set"]);
});

test("upload, download, mcp and theme give no tool", () => {
  assert.deepEqual(names(["upload", "download", "mcp", "theme"]), ["delo_page"]);
});

test("every tool takes an object of arguments and refuses unknown ones", () => {
  for (const entry of deloPageTools(["network", "internals", "share", "sound"])) {
    assert.equal(entry.inputSchema.type, "object");
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
});

test("delo_page takes the way back, and keeps the page when the computer does not halt", async () => {
  let taken = 0;
  assert.deepEqual(await tool("delo_page").run(handles({ back: async () => { taken++; } }), {}), {});
  assert.equal(taken, 1);
  await assert.rejects(tool("delo_page").run(handles({ back: async () => { throw new Error("foo"); } }), {}), { code: "OPERATION_FAILED", message: /foo/ });
});

test("the network tools drive the session and report its failure", async () => {
  const connected = handles({ network: network(STATE) });
  assert.deepEqual(await tool("option_network_read").run(connected, {}), STATE);
  assert.deepEqual(await tool("option_network_create").run(connected, {}), STATE);
  assert.deepEqual(await tool("option_network_join").run(connected, { link: STATE.link }), STATE);
  assert.equal((await tool("option_network_leave").run(connected, {})).phase, "offline");
  await assert.rejects(tool("option_network_join").run(connected, { link: "https://foo.test/" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(tool("option_network_create").run(handles({ network: network({ ...STATE, phase: "error", error: "bar" }) }), {}), { code: "OPERATION_FAILED", message: "bar" });
  await assert.rejects(tool("option_network_create").run(handles({ host: host("booting"), network: network(STATE) }), {}), { code: "NOT_READY" });
});

test("option_internals_read returns the process table, option_share_read the link, and option_sound_set the switch", async () => {
  assert.deepEqual(await tool("option_internals_read").run(handles(), {}), { processes: [{ pid: 1, ppid: 0, user: "root", state: "R", command: "init" }] });
  await assert.rejects(tool("option_internals_read").run(handles({ host: host("halted") }), {}), { code: "NOT_READY" });
  assert.deepEqual(await tool("option_share_read").run(handles({ share: "https://foo.test/delo/" }), {}), { link: "https://foo.test/delo/" });
  const set: boolean[] = [];
  assert.deepEqual(await tool("option_sound_set").run(handles({ sound: (on) => set.push(on) }), { on: true }), { on: true, audio: "running" });
  assert.deepEqual(set, [true]);
});
