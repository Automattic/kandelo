import assert from "node:assert/strict";
import test from "node:test";

import { validate } from "../../kandelo/webmcp/contract";
import { parseDeloRegistry } from "../src/registry";
import { DELO_TOOLS, deloListEntries, type DeloPage } from "../src/webmcp";

const CORGE_TOOL = { description: "Corge the foo", inputSchema: { type: "object", properties: { foo: { type: "string" } } }, command: ["/etc/foo", "{foo}"] };

const REGISTRY = parseDeloRegistry(JSON.stringify({
  schema: 1,
  entries: [
    { name: "foo", type: "binary", description: "Foo", use: ["bar"], provide: ["shell"], device: ["terminal"], files: [{ to: "/etc/foo", content: "foo" }] },
    { name: "bar", type: "binary", description: "Bar", files: [{ to: "/etc/bar", content: "bar" }, { to: "/etc/baz", type: "symlink", from: "/etc/bar" }] },
    { name: "baz", type: "option", description: "Baz", use: ["bar"], need: ["shell"] },
    { name: "corge", type: "pipeline", description: "Corge", use: ["foo"], enable: ["baz"], files: [{ to: "/etc/foo", content: "corge" }, { to: "/etc/mcp/pipeline_corge.json", content: JSON.stringify(CORGE_TOOL) }] },
    { name: "@foo/qux", type: "image", description: "Qux", vfs: "https://example.com/qux.vfs.zst", profile: "qux" },
    { name: "@foo/quux", type: "app", description: "Quux", url: "https://example.com/quux/" },
  ],
}));

const tool = (name: string) => DELO_TOOLS.find((entry) => entry.name === name)!;

/** A page that records the commands it runs. */
const page = () => {
  const commands: unknown[][] = [];
  const fake: DeloPage = {
    command: async (...words) => {
      commands.push(words);
      return [{ label: "foo", text: "bar" }];
    },
    computers: () => [],
    config: async () => { throw new Error("no config"); },
    files: async () => { throw new Error("no files"); },
  };
  return { commands, fake };
};

test("the page has one delo_ tool for each verb", () => {
  assert.deepEqual(DELO_TOOLS.map((entry) => entry.name), ["delo_list", "delo_init", "delo_add", "delo_remove", "delo_write", "delo_enable", "delo_disable", "delo_run", "delo_save", "delo_destroy", "delo_config"]);
  for (const entry of DELO_TOOLS) assert.equal(entry.inputSchema.additionalProperties, false);
});

test("a tool runs the command a visitor types and returns its lines", async () => {
  const { commands, fake } = page();
  assert.deepEqual(await tool("delo_add").run(fake, REGISTRY, { name: "foo", computer: "waldo" }), { lines: [{ label: "foo", text: "bar" }], computers: [] });
  await tool("delo_disable").run(fake, REGISTRY, { name: "baz", computer: "waldo" });
  await tool("delo_init").run(fake, REGISTRY, {});
  await tool("delo_run").run(fake, REGISTRY, { name: "@foo/qux" });
  await tool("delo_destroy").run(fake, REGISTRY, { computer: "waldo" });
  await tool("delo_write").run(fake, REGISTRY, { computer: "waldo", file: { to: "/etc/foo", from: "https://example.com/foo", lazy: true } });
  await tool("delo_write").run(fake, REGISTRY, { computer: "waldo", file: { to: "/etc/bar", content: "bar", lazy: false } });
  assert.deepEqual(commands, [
    ["add", "foo", "waldo"],
    ["disable", "baz", "waldo"],
    ["init", null, null],
    ["run", "@foo/qux", null],
    ["destroy", "waldo", null],
    ["write", "/etc/foo", "waldo", [{ key: "from", value: "https://example.com/foo" }, { key: "lazy", value: null }]],
    ["write", "/etc/bar", "waldo", [{ key: "content", value: "bar" }]],
  ]);
});

test("delo_list returns the facts the list view shows", () => {
  assert.deepEqual(deloListEntries(REGISTRY, "binaries"), [
    { name: "foo", description: "Foo", files: ["/etc/foo"], use: ["bar"], provide: ["shell"], need: [], device: ["terminal"], tools: [] },
    { name: "bar", description: "Bar", files: ["/etc/bar", "/etc/baz"], use: [], provide: [], need: [], device: [], tools: [] },
  ]);
  assert.deepEqual(deloListEntries(REGISTRY, "pipelines"), [
    { name: "corge", description: "Corge", files: ["/etc/foo", "/etc/mcp/pipeline_corge.json"], use: ["foo"], provide: [], need: [], device: [], tools: [{ name: "pipeline_corge", ...CORGE_TOOL }], enable: ["baz"] },
  ]);
  assert.deepEqual(deloListEntries(REGISTRY, "options"), [{ name: "baz", description: "Baz", use: ["bar"], need: ["shell"] }]);
  assert.deepEqual(deloListEntries(REGISTRY, "images"), [{ name: "@foo/qux", description: "Qux", vfs: "https://example.com/qux.vfs.zst", profile: "qux" }]);
  assert.deepEqual(deloListEntries(REGISTRY, "apps"), [{ name: "@foo/quux", description: "Quux", url: "https://example.com/quux/" }]);
});

test("a name argument takes an image URL or a path longer than a computer name", () => {
  const url = `https://example.com/${"foo/".repeat(60)}bar.vfs.zst`;
  validate({ name: url }, tool("delo_run").inputSchema);
  validate({ name: `/${"foo/".repeat(60)}bar`, computer: "waldo" }, tool("delo_remove").inputSchema);
});

test("no tool turns on mcp, which accepts every tool without asking", async () => {
  const registry = parseDeloRegistry(JSON.stringify({
    schema: 1,
    entries: [
      { name: "mcp", type: "option", description: "Mcp" },
      { name: "baz", type: "option", description: "Baz" },
      { name: "grault", type: "pipeline", description: "Grault", enable: ["mcp"], files: [{ to: "/etc/grault", content: "grault" }] },
      { name: "garply", type: "pipeline", description: "Garply", enable: ["baz"], files: [{ to: "/etc/garply", content: "garply" }] },
    ],
  }));
  const { commands, fake } = page();
  await assert.rejects(tool("delo_enable").run(fake, registry, { name: "mcp", computer: "waldo" }), { code: "PERMISSION_DENIED", message: /delo enable mcp <computer>/ });
  await assert.rejects(tool("delo_add").run(fake, registry, { name: "grault", computer: "waldo" }), { code: "PERMISSION_DENIED", message: /delo add grault <computer>/ });
  await tool("delo_enable").run(fake, registry, { name: "baz", computer: "waldo" });
  await tool("delo_add").run(fake, registry, { name: "garply", computer: "waldo" });
  await tool("delo_disable").run(fake, registry, { name: "mcp", computer: "waldo" });
  assert.deepEqual(commands, [["enable", "baz", "waldo"], ["add", "garply", "waldo"], ["disable", "mcp", "waldo"]]);
});

test("delo_config lists a folder of the disk of the computer it names after a rename", async () => {
  const listed: string[][] = [];
  const entry = { name: "foo", path: "/foo", kind: "file" as const, mode: 0o644, uid: 0, gid: 0, size: 3, lazy: false, target: null };
  const settings = { name: "fred", description: null, state: "saved", configuration: null, user: null, startedFrom: null, createdAt: null, lastOpenedAt: null };
  const fake: DeloPage = {
    command: async () => [],
    computers: () => [],
    config: async () => settings,
    files: async (name, folder) => {
      listed.push([name, folder]);
      return [entry];
    },
  };
  assert.deepEqual(await tool("delo_config").run(fake, REGISTRY, { computer: "waldo", name: "fred", folder: "/" }), { settings, files: [entry], computers: [] });
  assert.deepEqual(await tool("delo_config").run(fake, REGISTRY, { computer: "fred" }), { settings, computers: [] });
  await assert.rejects(tool("delo_config").run(fake, REGISTRY, { computer: "fred", folder: "etc" }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(listed, [["fred", "/"]]);
});
