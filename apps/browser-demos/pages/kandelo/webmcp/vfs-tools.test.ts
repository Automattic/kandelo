import assert from "node:assert/strict";
import test from "node:test";

import { parseVfsTool, substituteCommand, vfsToolName } from "./vfs-tools.ts";

test("derives a tool name from a json file name", () => {
  assert.equal(vfsToolName("run_command.json"), "run_command");
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
  const tool = parseVfsTool("/etc/mcp/run_command.json", JSON.stringify({
    description: "Run a command",
    inputSchema,
    command: "{command}",
  }));
  assert.deepEqual(tool, {
    name: "run_command",
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
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ inputSchema: {}, command: "true" })),
    /"description"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", command: "true" })),
    /"inputSchema"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", inputSchema: {}, command: "" })),
    /"command"/,
  );
  assert.throws(
    () => parseVfsTool("/home/maker/mcp/bad.json", JSON.stringify({ description: "x", inputSchema: {}, command: ["true"] })),
    /"command"/,
  );
});

test("substitutes named arguments into the command", () => {
  assert.equal(
    substituteCommand("{command} {count} {missing}", { command: "echo 'hi'", count: 2 }),
    "echo 'hi' 2 {missing}",
  );
});
