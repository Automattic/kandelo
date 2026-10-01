import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost, KernelOwnedJobRead, VfsChangeEvent } from "../kernel-host";
import type { ModelContext, ModelContextTool } from "./model-context";
import { setWebMcpSession } from "./runtime.ts";
import { changedToolName, loadVfsTool, loadVfsTools, registerVfsTools, runVfsTool } from "./vfs-tool-registration.ts";
import { VFS_TOOLS_DIRS } from "./vfs-tools.ts";

const [STATIC, DYNAMIC] = VFS_TOOLS_DIRS as [string, string];
const TERMINAL = "/dev/pts/0";
const encoder = new TextEncoder();

const foo = {
  description: "Echo one argument",
  inputSchema: { type: "object", properties: { bar: { type: "string" } } },
  command: "{bar}",
};

const baz = {
  description: "Print a fixed line",
  inputSchema: { type: "object", properties: {} },
  command: "qux",
};

const completed: KernelOwnedJobRead = {
  expired: false,
  pid: 7,
  status: "completed",
  exitCode: 0,
  terminationObserved: true,
  chunks: [{ stream: "stdout", bytes: encoder.encode("3.14\n") }],
  next: 5,
  hasMore: false,
  truncated: false,
};

function fakeHost(files: Record<string, string>, listError: Error | null = null) {
  const runs: unknown[] = [];
  const announced: Array<[string, string]> = [];
  const watches: Array<{ prefix: string; callback: (event: VfsChangeEvent) => void }> = [];
  let unsubscribed = 0;
  const host = {
    getStatus: () => "running",
    subscribeStatus: () => () => {},
    readVfsFile: async (path: string) =>
      path === "/etc/passwd" ? encoder.encode("maker:x:1000:1000::/home/maker:/bin/bash\n") : null,
    readDir: async (path: string) => {
      if (listError && path === STATIC) throw listError;
      if (!VFS_TOOLS_DIRS.includes(path)) throw new Error(`ENOENT: ${path}`);
      return Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => ({ name: file.slice(path.length + 1), kind: file.endsWith("/") ? "d" : "f" }));
    },
    readFileText: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    startOwnedJob: async (_id: string, program: string, argv: string[], options: unknown) => {
      runs.push([program, argv, options]);
    },
    readOwnedJob: async () => completed,
    releaseOwnedJob: async () => {},
    injectPtyOutput: (path: string, text: string) => {
      announced.push([path, text]);
      return true;
    },
    subscribeVfsChanges: (prefix: string, callback: (event: VfsChangeEvent) => void) => {
      watches.push({ prefix, callback });
      return () => { unsubscribed += 1; };
    },
  } as unknown as KernelHost;
  setWebMcpSession(host, { uid: 1000, gid: 1000, env: ["PATH=/bin"] });
  const change = (kind: VfsChangeEvent["kind"], path: string) => {
    for (const watch of watches) {
      if (path.startsWith(`${watch.prefix}/`)) watch.callback({ kind, path, t: 1 });
    }
  };
  return { host, runs, announced, watches, change, unsubscribed: () => unsubscribed };
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

async function capturingErrors<T>(run: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    return { result: await run(), errors };
  } finally {
    console.error = consoleError;
  }
}

test("loads one tool per json file and skips other entries", async () => {
  const { host } = fakeHost({
    [`${STATIC}/foo.json`]: JSON.stringify(foo),
    [`${STATIC}/notes.txt`]: "ignored",
    [`${STATIC}/nested.json/`]: "",
  });
  assert.deepEqual(await loadVfsTools(host), [{ name: "foo", ...foo }]);
});

test("loads both directories, the maker's file winning on a name clash", async () => {
  const { host } = fakeHost({
    [`${STATIC}/foo.json`]: JSON.stringify(foo),
    [`${STATIC}/baz.json`]: JSON.stringify(baz),
    [`${DYNAMIC}/foo.json`]: JSON.stringify({ ...foo, description: "Echo one argument, the maker's way" }),
  });
  assert.deepEqual(await loadVfsTools(host), [
    { name: "foo", ...foo, description: "Echo one argument, the maker's way" },
    { name: "baz", ...baz },
  ]);
});

test("loads no tools, silently, when the image has no tool directory", async () => {
  const { host } = fakeHost({});
  const { result, errors } = await capturingErrors(() => loadVfsTools(host));
  assert.deepEqual(result, []);
  assert.deepEqual(errors, []);
});

test("logs a tool directory that fails to list for another reason and still loads the other one", async () => {
  const { host } = fakeHost({ [`${DYNAMIC}/baz.json`]: JSON.stringify(baz) }, new Error("EACCES: /etc/mcp"));
  const { result, errors } = await capturingErrors(() => loadVfsTools(host));
  assert.deepEqual(result, [{ name: "baz", ...baz }]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]![0]), /listing \/etc\/mcp failed/);
});

test("logs a tool file that does not parse and still loads the others", async () => {
  const { host } = fakeHost({
    [`${STATIC}/bad.json`]: "{ not json",
    [`${STATIC}/baz.json`]: JSON.stringify(baz),
  });
  const { result, errors } = await capturingErrors(() => loadVfsTools(host));
  assert.deepEqual(result, [{ name: "baz", ...baz }]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]![1]), /not valid JSON/);
});

test("loads one tool by name from the maker's directory first and resolves null once no file is left", async () => {
  const { host } = fakeHost({
    [`${STATIC}/foo.json`]: JSON.stringify(foo),
    [`${DYNAMIC}/foo.json`]: JSON.stringify({ ...foo, description: "Echo one argument, the maker's way" }),
    [`${STATIC}/baz.json`]: JSON.stringify(baz),
  });
  assert.deepEqual(await loadVfsTool(host, "foo"), { name: "foo", ...foo, description: "Echo one argument, the maker's way" });
  assert.deepEqual(await loadVfsTool(host, "baz"), { name: "baz", ...baz });
  assert.equal(await loadVfsTool(host, "pi"), null);
});

test("maps a changed path to its tool name and ignores everything else", () => {
  assert.equal(changedToolName(`${STATIC}/foo.json`), "foo");
  assert.equal(changedToolName(`${DYNAMIC}/foo.json`), "foo");
  assert.equal(changedToolName(`${DYNAMIC}/notes.txt`), null);
  assert.equal(changedToolName(`${DYNAMIC}/nested/foo.json`), null);
  assert.equal(changedToolName(DYNAMIC), null);
  assert.equal(changedToolName("/home/maker/foo.json"), null);
});

test("registers every tool with its own signal and watches both tool directories", async () => {
  const { host, watches } = fakeHost({ [`${STATIC}/foo.json`]: JSON.stringify(foo) });
  const { context, registered } = fakeContext();
  const controller = new AbortController();

  await registerVfsTools(host, context, controller.signal, () => TERMINAL);

  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.tool.name, "foo");
  assert.equal(registered[0]!.tool.description, "Echo one argument");
  assert.deepEqual(registered[0]!.tool.inputSchema, foo.inputSchema);
  assert.notEqual(registered[0]!.signal, controller.signal);
  assert.equal(registered[0]!.signal?.aborted, false);
  assert.deepEqual(watches.map(({ prefix }) => prefix), VFS_TOOLS_DIRS);
});

test("registers nothing when the signal aborts while loading", async () => {
  const { host } = fakeHost({ [`${STATIC}/foo.json`]: JSON.stringify(foo) });
  const { context, registered } = fakeContext();
  const controller = new AbortController();
  controller.abort();

  await registerVfsTools(host, context, controller.signal, () => TERMINAL);

  assert.equal(registered.length, 0);
});

test("registers a tool when its file is written and unregisters it when deleted", async () => {
  const files: Record<string, string> = {};
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  const controller = new AbortController();
  await registerVfsTools(host, context, controller.signal, () => TERMINAL);
  assert.deepEqual(active(), []);

  files[`${DYNAMIC}/baz.json`] = JSON.stringify(baz);
  change("modify", `${DYNAMIC}/baz.json`);
  await settled();
  assert.deepEqual(active().map(({ name }) => name), ["baz"]);

  delete files[`${DYNAMIC}/baz.json`];
  change("delete", `${DYNAMIC}/baz.json`);
  await settled();
  assert.deepEqual(active(), []);
});

test("replaces a tool's registration when its file changes", async () => {
  const files: Record<string, string> = { [`${DYNAMIC}/foo.json`]: JSON.stringify(foo) };
  const { host, change } = fakeHost(files);
  const { context, registered, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);

  files[`${DYNAMIC}/foo.json`] = JSON.stringify({ ...foo, description: "Echo one argument, the maker's way" });
  change("modify", `${DYNAMIC}/foo.json`);
  await settled();

  assert.equal(registered.length, 2);
  assert.equal(registered[0]!.signal?.aborted, true);
  assert.equal(registered[1]!.tool.description, "Echo one argument, the maker's way");
  assert.deepEqual(active().map(({ name }) => name), ["foo"]);
});

test("falls back to the static tool when the maker's override is deleted", async () => {
  const files: Record<string, string> = {
    [`${STATIC}/foo.json`]: JSON.stringify(foo),
    [`${DYNAMIC}/foo.json`]: JSON.stringify({ ...foo, description: "Echo one argument, the maker's way" }),
  };
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);
  assert.deepEqual(active().map(({ description }) => description), ["Echo one argument, the maker's way"]);

  delete files[`${DYNAMIC}/foo.json`];
  change("delete", `${DYNAMIC}/foo.json`);
  await settled();

  assert.deepEqual(active().map(({ description }) => description), ["Echo one argument"]);
});

test("unregisters a tool whose file stops parsing and logs the error", async () => {
  const files: Record<string, string> = { [`${DYNAMIC}/foo.json`]: JSON.stringify(foo) };
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);

  const { errors } = await capturingErrors(async () => {
    files[`${DYNAMIC}/foo.json`] = "{ not json";
    change("modify", `${DYNAMIC}/foo.json`);
    await settled();
  });

  assert.deepEqual(active(), []);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]![1]), /not valid JSON/);
});

test("ignores changes to files that are not tools", async () => {
  const files: Record<string, string> = {};
  const { host, change } = fakeHost(files);
  const { context, registered } = fakeContext();
  await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);

  files[`${DYNAMIC}/notes.txt`] = "ignored";
  change("modify", `${DYNAMIC}/notes.txt`);
  await settled();

  assert.equal(registered.length, 0);
});

test("aborting the registration stops watching and unregisters every tool", async () => {
  const { host, unsubscribed } = fakeHost({ [`${STATIC}/foo.json`]: JSON.stringify(foo) });
  const { context, registered, active } = fakeContext();
  const controller = new AbortController();
  await registerVfsTools(host, context, controller.signal, () => TERMINAL);
  assert.deepEqual(active().map(({ name }) => name), ["foo"]);

  controller.abort();

  assert.equal(unsubscribed(), VFS_TOOLS_DIRS.length);
  assert.equal(registered[0]!.signal?.aborted, true);
  assert.deepEqual(active(), []);
});

test("runs the substituted command as an owned job of the agent and announces it on the terminal", async () => {
  const { host, runs, announced } = fakeHost({});

  const result = await runVfsTool(host, { name: "foo", ...foo }, { bar: "echo hi" }, TERMINAL);

  assert.deepEqual(result, { stdout: "3.14\n", stderr: "", exitCode: 0, status: "completed", terminationObserved: true, truncated: false });
  assert.deepEqual(runs, [["/bin/bash", ["bash", "-c", "echo hi"], { cwd: "/home/maker", env: ["PATH=/bin", "HOME=/home/maker"], uid: 1000, gid: 1000, timeoutMs: 30_000 }]]);
  assert.deepEqual(announced, [[TERMINAL, "\r\n\x1b[2m[agent] echo hi\x1b[0m\r\n"]]);
});

test("a registered image tool answers through the shared envelope and annotations", async () => {
  const { host, announced } = fakeHost({ [`${STATIC}/foo.json`]: JSON.stringify(foo) });
  const { context, active } = fakeContext();

  await registerVfsTools(host, context, new AbortController().signal, () => "/dev/pts/2");
  await settled();

  const [tool] = active();
  assert.deepEqual(tool!.annotations, { readOnlyHint: false, untrustedContentHint: true });

  const result = await tool!.execute({ bar: "echo hi" }, { signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(result), { ok: true, stdout: "3.14\n", stderr: "", exitCode: 0, status: "completed", terminationObserved: true, truncated: false });
  assert.deepEqual(announced.map(([path]) => path), ["/dev/pts/2"]);
});

test("a tool file under the reserved prefix is refused without losing the others", async () => {
  const { host } = fakeHost({
    [`${STATIC}/kandelo_run_command.json`]: JSON.stringify(foo),
    [`${STATIC}/baz.json`]: JSON.stringify(baz),
  });
  const { context, active } = fakeContext();

  const { errors } = await capturingErrors(async () => {
    await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);
    await settled();
  });

  assert.deepEqual(active().map(({ name }) => name), ["baz"]);
  assert.equal(errors.length, 1);
});

test("a reserved name written while the machine runs is refused without disturbing the rest", async () => {
  const files: Record<string, string> = { [`${STATIC}/baz.json`]: JSON.stringify(baz) };
  const { host, change } = fakeHost(files);
  const { context, active } = fakeContext();

  await registerVfsTools(host, context, new AbortController().signal, () => TERMINAL);
  await settled();

  const { errors } = await capturingErrors(async () => {
    files[`${DYNAMIC}/kandelo_write_file.json`] = JSON.stringify(foo);
    change("modify", `${DYNAMIC}/kandelo_write_file.json`);
    await settled();
  });

  assert.deepEqual(active().map(({ name }) => name), ["baz"]);
  assert.equal(errors.length, 1);
});
