import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost, KernelOwnedJobRead, MachineStatus } from "../kernel-host";
import type { ShellTerminal } from "../panes/Shell";
import { registerWebMcp, type AppBindings } from "./adapter.ts";
import type { ModelContextTool } from "./model-context";
import { setWebMcpSession } from "./runtime.ts";

const completed: KernelOwnedJobRead = {
  expired: false,
  pid: 7,
  status: "completed",
  exitCode: 0,
  terminationObserved: true,
  chunks: [],
  next: 0,
  hasMore: false,
  truncated: false,
};

async function mounted() {
  const terminal = { id: "foo", path: "/dev/pts/1", label: "Foo" } as ShellTerminal;
  const tools = new Map<string, ModelContextTool>();
  Object.assign(globalThis, {
    document: { title: "Kandelo", modelContext: { registerTool: (tool: ModelContextTool) => { tools.set(tool.name, tool); } } },
    location: { href: "https://kandelo.dev/" },
  });
  const attached: unknown[][] = [];
  const started: string[] = [];
  let status: MachineStatus = "running";
  const host = {
    getStatus: () => status,
    subscribeStatus: () => () => {},
    subscribeDmesg: () => () => {},
    dmesgHistory: () => [],
    getSurfaceAvailability: () => ({ terminal: true }),
    attachPty: async (...args: unknown[]) => {
      attached.push(args);
      return { write: () => {}, onData: () => () => {}, resize: () => {}, close: () => {} };
    },
    readVfsFile: async () => null,
    startOwnedJob: async (id: string) => { started.push(id); },
    readOwnedJob: async () => completed,
    releaseOwnedJob: async () => {},
    injectPtyOutput: () => true,
  } as unknown as KernelHost;
  setWebMcpSession(host, { uid: 1000, gid: 1000, env: [] });
  const bindings = {
    host,
    terminals: [terminal],
    activeTerminalId: terminal.id,
    createTerminal: () => terminal,
    selectTerminal: () => {},
    launch: async () => {},
    navigatePreview: () => false,
  } as AppBindings;
  const dispose = registerWebMcp(() => bindings);
  while (!tools.has("kandelo_run_command")) await new Promise(resolve => setTimeout(resolve, 0));
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await tools.get(`kandelo_${name}`)!.execute(args, { signal: new AbortController().signal }));
  return { call, attached, started, dispose, setStatus: (next: MachineStatus) => { status = next; } };
}

test("a dock terminal stays unattached until a terminal tool call", async () => {
  const { call, attached, dispose } = await mounted();
  assert.deepEqual(attached, []);

  const listed = await call("list_terminals", {});

  assert.deepEqual(attached, [["/dev/pts/1"]]);
  assert.equal(listed.terminals[0].ready, true);
  dispose();
});

test("a call that failed before it ran keeps no retry record", async () => {
  const { call, started, dispose, setStatus } = await mounted();
  setStatus("booting");
  assert.equal((await call("run_command", { script: "true", requestId: "foo" })).error.code, "NOT_READY");

  setStatus("running");
  const retried = await call("run_command", { script: "true", requestId: "foo" });

  assert.equal(retried.ok, true);
  assert.equal(started.length, 1);
  dispose();
});

test("a retry with nested arguments in another key order replays the first call", async () => {
  const { call, started, dispose } = await mounted();

  const first = await call("run_command", { script: "true", env: { BAR: "1", BAZ: "2" }, requestId: "foo" });
  const second = await call("run_command", { requestId: "foo", env: { BAZ: "2", BAR: "1" }, script: "true" });

  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(started.length, 1);
  dispose();
});

test("a new retry key past 256 forgets the oldest one", async () => {
  const { call, dispose } = await mounted();
  for (let index = 0; index < 257; index++) {
    assert.equal((await call("run_command", { script: "true", requestId: `foo-${index}` })).ok, true);
  }

  const forgotten = await call("run_command", { script: "false", requestId: "foo-0" });
  const kept = await call("run_command", { script: "false", requestId: "foo-2" });

  assert.equal(forgotten.ok, true);
  assert.equal(kept.error.code, "REQUEST_CONFLICT");
  dispose();
});
