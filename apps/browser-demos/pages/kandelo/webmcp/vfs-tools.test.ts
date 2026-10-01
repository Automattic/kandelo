import assert from "node:assert/strict";
import test from "node:test";

import { parseVfsTool, shellQuote, substituteCommand, validateToolSchema, vfsToolName } from "./vfs-tools.ts";

const definition = (inputSchema: unknown) =>
  JSON.stringify({ description: "x", inputSchema, command: "true" });

test("derives a tool name from a json file name", () => {
  assert.equal(vfsToolName("foo.json"), "foo");
  assert.equal(vfsToolName("run-command.json"), "run-command");
  assert.equal(vfsToolName("README.md"), null);
  assert.equal(vfsToolName("Run Command.json"), null);
  assert.equal(vfsToolName(".json"), null);
});

test("parses a tool definition", () => {
  const inputSchema = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };
  const tool = parseVfsTool("/etc/mcp/foo.json", JSON.stringify({
    description: "Run a command",
    inputSchema,
    command: "{command}",
  }));
  assert.deepEqual(tool, {
    name: "foo",
    description: "Run a command",
    inputSchema,
    command: "{command}",
  });
});

test("rejects malformed tool definitions", () => {
  assert.throws(() => parseVfsTool("/etc/mcp/notes.txt", "{}"), /not named after a tool/);
  assert.throws(() => parseVfsTool("/home/maker/mcp/bad.json", "{"), /not valid JSON/);
  assert.throws(() => parseVfsTool("/home/maker/mcp/bad.json", "[]"), /JSON object/);
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ inputSchema: { type: "object" }, command: "true" })),
    /"description"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", command: "true" })),
    /"inputSchema"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", inputSchema: { type: "object" }, command: "" })),
    /"command"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", inputSchema: { type: "object" }, command: ["true"] })),
    /"command"/,
  );
});

test("accepts every schema keyword the shared validator enforces", () => {
  const inputSchema = {
    type: "object",
    description: "args",
    properties: {
      name: { type: "string", maxLength: 8, enum: ["a", "b"] },
      count: { type: "integer", minimum: 1, maximum: 9 },
      ratio: { type: "number" },
      dry: { type: "boolean" },
      items: { type: "array" },
      nested: { type: "object", properties: { deep: { type: "string" } }, additionalProperties: { type: "string" } },
    },
    required: ["name"],
    additionalProperties: false,
  };
  assert.deepEqual(parseVfsTool("/etc/mcp/foo.json", definition(inputSchema)).inputSchema, inputSchema);
});

test("rejects a schema the shared validator would not enforce", () => {
  const rejects = (inputSchema: unknown, message: RegExp) =>
    assert.throws(() => parseVfsTool("/etc/mcp/foo.json", definition(inputSchema)), message);

  rejects({}, /"type": "object"/);
  rejects({ type: "string" }, /"type": "object"/);
  rejects({ type: "object", additionalProperties: true }, /additionalProperties must be false or a schema/);
  rejects({ type: "object", properties: { n: { type: ["string", "null"] } } }, /properties\.n\.type must be one of/);
  rejects({ type: "object", properties: { n: { type: "null" } } }, /properties\.n\.type must be one of/);
  rejects({ type: "object", properties: { n: { type: "string", default: "x" } } }, /uses "default", which Kandelo does not enforce/);
  rejects({ type: "object", properties: { n: { type: "array", items: { type: "string" } } } }, /uses "items"/);
  rejects({ type: "object", required: ["missing"] }, /required must list names from properties/);
  rejects({ type: "object", properties: { n: { type: "string", minimum: 1 } } }, /minimum must be a number on an integer/);
  rejects({ type: "object", properties: { n: { type: "integer", enum: ["1"] } } }, /enum must be an array of strings on a string/);
  rejects({ type: "object", properties: { n: { type: "string", properties: {} } } }, /properties belongs on an object/);
  rejects({ type: "object", properties: "no" }, /properties must be an object/);
});

test("validateToolSchema names the path of the offending keyword", () => {
  assert.throws(
    () => validateToolSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "date" } } } } }, "schema"),
    /^Error: schema\.properties\.a\.properties\.b\.type must be one of/,
  );
});

test("substitutes named arguments into the command", () => {
  assert.equal(
    substituteCommand("{command} {count} {missing}", { command: "echo 'hi'", count: 2 }),
    "echo 'hi' 2 {missing}",
  );
});

test("a :q placeholder substitutes one shell-quoted word", () => {
  assert.equal(
    substituteCommand("grep -n {pattern:q} {file:q}", { pattern: "it's here", file: "/a b.txt" }),
    "grep -n 'it'\\''s here' '/a b.txt'",
  );
});

test("a bare placeholder stays verbatim beside a quoted one", () => {
  assert.equal(
    substituteCommand("{prefix} {value:q}", { prefix: "echo hi |", value: "$HOME; rm -rf /" }),
    "echo hi | '$HOME; rm -rf /'",
  );
});

test("a quoted placeholder JSON-encodes a non-string before quoting", () => {
  assert.equal(substituteCommand("n={count:q}", { count: 2 }), "n='2'");
  assert.equal(substituteCommand("n={items:q}", { items: ["a", "b"] }), `n='["a","b"]'`);
});

test("a missing argument leaves both placeholder spellings untouched", () => {
  assert.equal(substituteCommand("{a} {b:q}", {}), "{a} {b:q}");
});

test("shellQuote makes every value one word the shell cannot reinterpret", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("$(whoami)"), "'$(whoami)'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("line\nnext"), "'line\nnext'");
});
