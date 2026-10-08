import assert from "node:assert/strict";
import test from "node:test";

import { ToolError } from "./contract.ts";
import type { ModelContext, ModelContextTool } from "./model-context";
import { BUILT_IN_PREFIX, builtInTool, imageTool, objectSchema, registerTool } from "./registry.ts";

const schema = objectSchema({ bar: { type: "string" } }, ["bar"]);

function fakeContext() {
  const registered: Array<{ tool: ModelContextTool; signal: AbortSignal | undefined }> = [];
  const context: ModelContext = {
    registerTool: (tool, options) => { registered.push({ tool, signal: options?.signal }); },
  };
  return { context, registered };
}

function register(execute: Parameters<typeof builtInTool>[4]) {
  const { context, registered } = fakeContext();
  registerTool(context, builtInTool("run", "Run it", false, schema, execute), new AbortController().signal);
  return registered[0]!.tool;
}

test("objectSchema closes the object and copies the required list", () => {
  const required = ["bar"];
  const built = objectSchema({ bar: { type: "string" } }, required);

  assert.deepEqual(built, { type: "object", properties: { bar: { type: "string" } }, required: ["bar"], additionalProperties: false });
  required.push("baz");
  assert.deepEqual(built.required, ["bar"]);
});

test("a built-in tool takes the reserved prefix and declares its own read-only hint", () => {
  const readOnly = builtInTool("read_file", "Read", true, schema, async () => ({}));
  const writes = builtInTool("write_file", "Write", false, schema, async () => ({}));

  assert.equal(readOnly.name, `${BUILT_IN_PREFIX}read_file`);
  assert.deepEqual(readOnly.annotations, { readOnlyHint: true, untrustedContentHint: true });
  assert.deepEqual(writes.annotations, { readOnlyHint: false, untrustedContentHint: true });
});

test("an image tool keeps its own name, claims no read-only hint and is marked untrusted", () => {
  const tool = imageTool("pi", "Print pi", schema, async () => ({}));

  assert.equal(tool.name, "pi");
  assert.deepEqual(tool.annotations, { readOnlyHint: false, untrustedContentHint: true });
});

test("an image may not declare a tool under the reserved prefix", () => {
  assert.throws(
    () => imageTool(`${BUILT_IN_PREFIX}run_command`, "Impersonate", schema, async () => ({})),
    (error: unknown) => error instanceof ToolError && error.code === "RESERVED_TOOL_NAME",
  );
});

test("a registered tool carries its name, schema and annotations to the browser", () => {
  const tool = register(async () => ({}));

  assert.equal(tool.name, `${BUILT_IN_PREFIX}run`);
  assert.equal(tool.description, "Run it");
  assert.deepEqual(tool.inputSchema, schema);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, untrustedContentHint: true });
});

test("a result is wrapped in the ok envelope", async () => {
  const tool = register(async () => ({ output: "3.14\n" }));

  const result = await tool.execute({ bar: "pi" }, { signal: new AbortController().signal });

  assert.deepEqual(JSON.parse(result), { ok: true, output: "3.14\n" });
});

test("the call signal reaches the executor", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const tool = register(async (_args, signal) => { seen.push(signal); return {}; });
  const { signal } = new AbortController();

  await tool.execute({ bar: "pi" }, { signal });

  assert.deepEqual(seen, [signal]);
});

test("a ToolError keeps its code and details", async () => {
  const tool = register(async () => {
    throw new ToolError("OUTPUT_EXPIRED", "Gone", { oldestCursor: "a:0" });
  });

  const result = await tool.execute({ bar: "pi" }, { signal: new AbortController().signal });

  assert.deepEqual(JSON.parse(result), {
    ok: false,
    error: { code: "OUTPUT_EXPIRED", message: "Gone", oldestCursor: "a:0" },
  });
});

test("a plain error is classified by its message", async () => {
  const codeOf = async (message: string) => {
    const tool = register(async () => { throw new Error(message); });
    const result = await tool.execute({ bar: "pi" }, { signal: new AbortController().signal });
    return JSON.parse(result).error.code;
  };

  assert.equal(await codeOf("the kernel has no synchronous VFS surface"), "UNSUPPORTED_CAPABILITY");
  assert.equal(await codeOf("no writeFileToVfs on this kernel"), "UNSUPPORTED_CAPABILITY");
  assert.equal(await codeOf("ENOENT: /nope"), "FILE_NOT_FOUND");
  assert.equal(await codeOf("something else broke"), "OPERATION_FAILED");
});

test("arguments are validated before the executor runs", async () => {
  let ran = 0;
  const tool = register(async () => { ran += 1; return {}; });

  const missing = await tool.execute({}, { signal: new AbortController().signal });
  const unknown = await tool.execute({ bar: "pi", quux: 1 }, { signal: new AbortController().signal });

  assert.equal(JSON.parse(missing).error.code, "INVALID_ARGUMENT");
  assert.equal(JSON.parse(unknown).error.code, "INVALID_ARGUMENT");
  assert.equal(ran, 0);
});

test("the registration signal reaches the browser so a teardown unregisters the tool", () => {
  const { context, registered } = fakeContext();
  const controller = new AbortController();

  registerTool(context, builtInTool("run", "Run it", false, schema, async () => ({})), controller.signal);

  assert.equal(registered[0]!.signal, controller.signal);
  assert.equal(registered[0]!.signal?.aborted, false);
  controller.abort();
  assert.equal(registered[0]!.signal?.aborted, true);
});

test("an array argument satisfies an array parameter", async () => {
  const { context, registered } = fakeContext();
  const arrayed = objectSchema({ items: { type: "array" } }, ["items"]);

  registerTool(context, imageTool("collect", "Collect", arrayed, async (args) => args), new AbortController().signal);
  const { tool } = registered[0]!;

  const accepted = await tool.execute({ items: ["a", "b"] }, { signal: new AbortController().signal });
  const refused = await tool.execute({ items: "a" }, { signal: new AbortController().signal });

  assert.deepEqual(JSON.parse(accepted), { ok: true, items: ["a", "b"] });
  assert.equal(JSON.parse(refused).error.code, "INVALID_ARGUMENT");
});
