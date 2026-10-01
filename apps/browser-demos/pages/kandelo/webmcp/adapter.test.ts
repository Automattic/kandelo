import assert from "node:assert/strict";
import test from "node:test";

import type { KernelHost } from "../kernel-host";
import type { ShellTerminal } from "../panes/Shell";
import { registerWebMcp, type AppBindings } from "./adapter.ts";
import type { ModelContextTool } from "./model-context";

async function mounted() {
  const terminal = { id: "foo", path: "/dev/pts/1", label: "Foo" } as ShellTerminal;
  const tools = new Map<string, ModelContextTool>();
  Object.assign(globalThis, {
    document: { title: "Kandelo", modelContext: { registerTool: (tool: ModelContextTool) => { tools.set(tool.name, tool); } } },
    location: { href: "https://kandelo.dev/" },
  });
  const attached: unknown[][] = [];
  const host = {
    getStatus: () => "running",
    subscribeStatus: () => () => {},
    subscribeDmesg: () => () => {},
    dmesgHistory: () => [],
    getSurfaceAvailability: () => ({ terminal: true }),
    attachPty: async (...args: unknown[]) => {
      attached.push(args);
      return { write: () => {}, onData: () => () => {}, resize: () => {}, close: () => {} };
    },
  } as unknown as KernelHost;
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
  return { call, attached, dispose };
}

test("a dock terminal stays unattached until a terminal tool call", async () => {
  const { call, attached, dispose } = await mounted();
  assert.deepEqual(attached, []);

  const listed = await call("list_terminals", {});

  assert.deepEqual(attached, [["/dev/pts/1"]]);
  assert.equal(listed.terminals[0].ready, true);
  dispose();
});
