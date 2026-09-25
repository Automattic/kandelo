import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost, VfsChangeEvent } from "../kernel-host";
import type { ModelContext, ModelContextTool } from "./model-context";
import { changedToolName, loadVfsTool, loadVfsTools, registerVfsTools, runVfsTool } from "./vfs-tool-registration.ts";
import { VFS_TOOLS_DIRS } from "./vfs-tools.ts";

const [STATIC, DYNAMIC] = VFS_TOOLS_DIRS as [string, string];

const runCommand = {
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  command: "{command}",
};

const currentDate = {
  description: "Print the date",
  inputSchema: { type: "object", properties: {} },
  command: "date",
};

function fakeHost(files: Record<string, string>) {
  const runs: unknown[] = [];
  const watches: Array<{ prefix: string; callback: (event: VfsChangeEvent) => void }> = [];
  let unsubscribed = 0;
  const host = {
    readDir: async (path: string) => {
      if (!VFS_TOOLS_DIRS.includes(path)) throw new Error(`ENOENT: ${path}`);
      return Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => ({ name: file.slice(path.length + 1), kind: file.endsWith("/") ? "d" : "f" }));
    },
    readFileText: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    runShellCommand: async (command: string, options: unknown) => {
      runs.push([command, options]);
      return "3.14\n";
    },
    subscribeVfsChanges: (prefix: string, callback: (event: VfsChangeEvent) => void) => {
      watches.push({ prefix, callback });
      return () => { unsubscribed += 1; };
    },
  } as unknown as KernelHost;
  const change = (kind: VfsChangeEvent["kind"], path: string) => {
    for (const watch of watches) {
      if (path.startsWith(`${watch.prefix}/`)) watch.callback({ kind, path, t: 1 });
    }
  };
  return { host, runs, watches, change, unsubscribed: () => unsubscribed };
}

function fakeContext() {
  const registered: Array<{ tool: ModelContextTool; signal: AbortSignal | undefined }> = [];
  const context: ModelContext = {
    registerTool(tool, options) {
      registered.push({ tool, signal: options?.signal });
    },
  };
  const active = () => registered.filter(({ signal }) => !signal?.aborted).map(({ tool }) => tool);
  return { context, registered, active };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("loads one tool per json file and skips other entries", async () => {
  const { host } = fakeHost({
    [`${STATIC}/run_command.json`]: JSON.stringify(runCommand),
    [`${STATIC}/notes.txt`]: "ignored",
    [`${STATIC}/nested.json/`]: "",
  });
  assert.deepEqual(await loadVfsTools(host), [{ name: "run_command", ...runCommand }]);
});

test("loads both directories, the maker's file winning on a name clash", async () => {
  const { host } = fakeHost({
    [`${STATIC}/run_command.json`]: JSON.stringify(runCommand),
    [`${STATIC}/current_date.json`]: JSON.stringify(currentDate),
    [`${DYNAMIC}/run_command.json`]: JSON.stringify({ ...runCommand, description: "Run a shell command" }),
  });
  assert.deepEqual(await loadVfsTools(host), [
    { name: "run_command", ...runCommand, description: "Run a shell command" },
    { name: "current_date", ...currentDate },
  ]);
});

test("loads no tools when the image has no tool directory", async () => {
  const host = {
    readDir: async (path: string) => { throw new Error(`ENOENT: ${path}`); },
  } as unknown as KernelHost;
  assert.deepEqual(await loadVfsTools(host), []);
});

test("loads one tool by name from the maker's directory first and resolves null once no file is left", async () => {
  const { host } = fakeHost({
    [`${STATIC}/run_command.json`]: JSON.stringify(runCommand),
    [`${DYNAMIC}/run_command.json`]: JSON.stringify({ ...runCommand, description: "Run a shell command" }),
    [`${STATIC}/current_date.json`]: JSON.stringify(currentDate),
  });
  assert.deepEqual(await loadVfsTool(host, "run_command"), { name: "run_command", ...runCommand, description: "Run a shell command" });
  assert.deepEqual(await loadVfsTool(host, "current_date"), { name: "current_date", ...currentDate });
  assert.equal(await loadVfsTool(host, "pi"), null);
});

test("maps a changed path to its tool name and ignores everything else", () => {
  assert.equal(changedToolName(`${STATIC}/run_command.json`), "run_command");
  assert.equal(changedToolName(`${DYNAMIC}/run_command.json`), "run_command");
  assert.equal(changedToolName(`${DYNAMIC}/notes.txt`), null);
  assert.equal(changedToolName(`${DYNAMIC}/nested/run_command.json`), null);
  assert.equal(changedToolName(DYNAMIC), null);
  assert.equal(changedToolName("/home/maker/run_command.json"), null);
});

test("registers every tool with its own signal and watches both tool directories", async () => {
  const { host, watches } = fakeHost({ [`${STATIC}/run_command.json`]: JSON.stringify(runCommand) });
  const { context, registered } = fakeContext();
  const controller = new AbortController();

  await registerVfsTools(host, context, controller.signal);

  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.tool.name, "run_command");
  assert.equal(registered[0]!.tool.description, "Run a command");
  assert.deepEqual(registered[0]!.tool.inputSchema, runCommand.inputSchema);
  assert.notEqual(registered[0]!.signal, controller.signal);
  assert.equal(registered[0]!.signal?.aborted, false);
  assert.deepEqual(watches.map(({ prefix }) => prefix), VFS_TOOLS_DIRS);
});

test("registers nothing when the signal aborts while loading", async () => {
  const { host } = fakeHost({ [`${STATIC}/run_command.json`]: JSON.stringify(runCommand) });
  const { context, registered } = fakeContext();
  const controller = new AbortController();
  controller.abort();

  await registerVfsTools(host, context, controller.signal);

  assert.equal(registered.length, 0);
});

test("registers a tool when its file is written and unregisters it when deleted", async () => {
  const files: Record<string, string> = {};
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  const controller = new AbortController();
  await registerVfsTools(host, context, controller.signal);
  assert.deepEqual(active(), []);

  files[`${DYNAMIC}/current_date.json`] = JSON.stringify(currentDate);
  change("modify", `${DYNAMIC}/current_date.json`);
  await settled();
  assert.deepEqual(active().map(({ name }) => name), ["current_date"]);

  delete files[`${DYNAMIC}/current_date.json`];
  change("delete", `${DYNAMIC}/current_date.json`);
  await settled();
  assert.deepEqual(active(), []);
});

test("replaces a tool's registration when its file changes", async () => {
  const files: Record<string, string> = { [`${DYNAMIC}/run_command.json`]: JSON.stringify(runCommand) };
  const { host, change } = fakeHost(files);
  const { context, registered, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal);

  files[`${DYNAMIC}/run_command.json`] = JSON.stringify({ ...runCommand, description: "Run a shell command" });
  change("modify", `${DYNAMIC}/run_command.json`);
  await settled();

  assert.equal(registered.length, 2);
  assert.equal(registered[0]!.signal?.aborted, true);
  assert.equal(registered[1]!.tool.description, "Run a shell command");
  assert.deepEqual(active().map(({ name }) => name), ["run_command"]);
});

test("falls back to the static tool when the maker's override is deleted", async () => {
  const files: Record<string, string> = {
    [`${STATIC}/run_command.json`]: JSON.stringify(runCommand),
    [`${DYNAMIC}/run_command.json`]: JSON.stringify({ ...runCommand, description: "Run a shell command" }),
  };
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal);
  assert.deepEqual(active().map(({ description }) => description), ["Run a shell command"]);

  delete files[`${DYNAMIC}/run_command.json`];
  change("delete", `${DYNAMIC}/run_command.json`);
  await settled();

  assert.deepEqual(active().map(({ description }) => description), ["Run a command"]);
});

test("unregisters a tool whose file stops parsing and logs the error", async () => {
  const files: Record<string, string> = { [`${DYNAMIC}/run_command.json`]: JSON.stringify(runCommand) };
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal);
  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };

  try {
    files[`${DYNAMIC}/run_command.json`] = "{ not json";
    change("modify", `${DYNAMIC}/run_command.json`);
    await settled();
  } finally {
    console.error = consoleError;
  }

  assert.deepEqual(active(), []);
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as unknown[])[1]), /not valid JSON/);
});

test("ignores changes to files that are not tools", async () => {
  const files: Record<string, string> = {};
  const { host, change } = fakeHost(files);
  const { context, registered } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal);

  files[`${DYNAMIC}/notes.txt`] = "ignored";
  change("modify", `${DYNAMIC}/notes.txt`);
  await settled();

  assert.equal(registered.length, 0);
});

test("aborting the registration stops watching and unregisters every tool", async () => {
  const { host, unsubscribed } = fakeHost({ [`${STATIC}/run_command.json`]: JSON.stringify(runCommand) });
  const { context, registered, active } = fakeContext();
  const controller = new AbortController();
  await registerVfsTools(host, context, controller.signal);
  assert.deepEqual(active().map(({ name }) => name), ["run_command"]);

  controller.abort();

  assert.equal(unsubscribed(), VFS_TOOLS_DIRS.length);
  assert.equal(registered[0]!.signal?.aborted, true);
  assert.deepEqual(active(), []);
});

test("types the substituted command into the shell with the call's signal", async () => {
  const { host, runs } = fakeHost({});
  const signal = new AbortController().signal;

  const result = await runVfsTool(host, { name: "run_command", ...runCommand }, { command: "echo hi" }, signal);

  assert.deepEqual(result, { output: "3.14\n" });
  assert.deepEqual(runs, [["echo hi", { signal }]]);
});
