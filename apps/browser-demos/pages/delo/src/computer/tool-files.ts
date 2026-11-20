// The WebMCP tools a delo computer's disk declares. A binary or a pipeline
// declares a tool in /etc/mcp/<name>.json: `{ description, inputSchema,
// command }`, where `command` is an argv list whose first item is the
// program's absolute path. A registry binary names its files
// `binary_<name>.json` and a pipeline `pipeline_<name>.json` (registry.ts
// refuses the wrong prefix and parses the files the same way). The file name
// is the tool name of an official file; any other file registers as
// `unofficial_<name>`, and an untrusted one waits for the visitor's
// acceptance on its first call (see trust.ts and acceptance.ts).
// While the computer runs, the page registers each file
// and follows the folder: a file written, replaced or deleted registers or
// unregisters its tool. A call runs the program with no shell, with the uid
// and gid of the computer's first process, and returns its output. Results
// and errors use Kandelo's WebMCP envelope (see docs/webmcp.md).

import { ToolError } from "../../../kandelo/webmcp/contract";
import { modelContextOf, type ModelContext } from "../../../kandelo/webmcp/model-context";
import { registerTool } from "../../../kandelo/webmcp/registry";
import { runGuestJob, startSessionJob } from "../../../kandelo/webmcp/runtime";
import { commandArgv, vfsToolName } from "../../../kandelo/webmcp/vfs-tools";
import type { KernelHost, ProcessInfo } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { parseDeloToolFile, type DeloToolFile } from "../registry";
import type { Acceptance } from "./acceptance";
import { deloToolName, deloToolTrust, unacceptedDescription, unacceptedSchema, type DeloToolTexts } from "./trust";

const TOOLS_DIR = "/etc/mcp";

const TIMEOUT_MS = 30_000;

const SYNTHETIC_INIT_PID = 1;

const PATH = "/usr/local/bin:/usr/bin:/bin";

interface ToolUser {
  uid: number;
  gid: number;
  home: string;
}

/** The account of the computer's first process: its user found in `passwd`, or root, which Kandelo names uid 0 even without a `passwd`. */
export function toolUser(processes: readonly ProcessInfo[], passwd: string): ToolUser {
  const first = processes.filter((process) => process.pid !== SYNTHETIC_INIT_PID && process.state !== "Z").sort((a, b) => a.pid - b.pid)[0];
  if (first === undefined) throw new ToolError("NOT_READY", "The computer runs no process.");
  const line = passwd.split("\n").map((entry) => entry.split(":")).find((fields) => fields.length >= 7 && fields[0] === first.user);
  if (line !== undefined) return { uid: Number(line[2]), gid: Number(line[3]), home: line[5] || "/" };
  if (first.user === "root") return { uid: 0, gid: 0, home: "/" };
  throw new ToolError("OPERATION_FAILED", `The first process runs as uid ${first.user}, which /etc/passwd does not name, so its group is unknown.`);
}

const textOf = async (host: KernelHost, path: string) => {
  try {
    return await host.readFileText(path);
  } catch (error) {
    if (/ENOENT/.test(String(error))) return "";
    throw error;
  }
};

/** Run `tool` for `args` as the computer's user and collect its output, as Kandelo's image-declared tools do. */
async function runToolFile(host: KernelHost, tool: DeloToolFile, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const argv = commandArgv(tool.command, args);
  if (argv.some((item) => item.includes("\0"))) throw new ToolError("INVALID_ARGUMENT", "Arguments must not contain NUL.");
  const user = toolUser(await host.enumProcs(), await textOf(host, "/etc/passwd"));
  const options = { timeoutMs: TIMEOUT_MS, uid: user.uid, gid: user.gid, cwd: "/", env: [`PATH=${PATH}`, `HOME=${user.home}`] };
  return runGuestJob(host, (id) => startSessionJob(host, id, argv[0], argv, options), { timeoutMs: TIMEOUT_MS, signal });
}

/** What decides how a tool file registers. */
export interface ToolFileTrust {
  official: DeloToolTexts;
  trusted: DeloToolTexts;
  acceptance: Acceptance;
  /** The computer an unaccepted tool's description names. */
  computer: string;
}

interface ToolFile {
  path: string;
  tool: DeloToolFile;
  text: string;
}

const ANNOTATIONS = { readOnlyHint: false, untrustedContentHint: true };

/** Every tool file in /etc/mcp that parses, with its text; a file that does not is logged and skipped. */
async function loadToolFiles(host: KernelHost): Promise<Map<string, ToolFile>> {
  const tools = new Map<string, ToolFile>();
  let entries: Awaited<ReturnType<KernelHost["readDir"]>>;
  try {
    entries = await host.readDir(TOOLS_DIR);
  } catch (error) {
    if (!/ENOENT/.test(String(error))) console.error(`WebMCP: listing ${TOOLS_DIR} failed`, error);
    return tools;
  }
  for (const entry of entries) {
    if (entry.kind !== "f" || vfsToolName(entry.name) === null) continue;
    const file = `${TOOLS_DIR}/${entry.name}`;
    try {
      const text = await host.readFileText(file);
      const tool = parseDeloToolFile(file, text);
      tools.set(tool.name, { path: file, tool, text });
    } catch (error) {
      console.error(`WebMCP: loading ${file} failed`, error);
    }
  }
  return tools;
}

export async function followToolFiles(host: KernelHost, context: ModelContext, signal: AbortSignal, trust: ToolFileTrust): Promise<void> {
  const registered = new Map<string, { text: string; controller: AbortController }>();
  const register = async (file: string, text: string, definition: Parameters<typeof registerTool>[1]) => {
    registered.get(file)?.controller.abort();
    const controller = new AbortController();
    registered.set(file, { text, controller });
    await Promise.resolve(registerTool(context, definition, controller.signal)).catch((error) => console.error(`WebMCP: registering ${definition.name} failed`, error));
  };
  /** The tool of `file` as it registers now: whole, or as Delo describes it until the visitor accepts it. */
  const definitionOf = (file: string, { path, tool, text }: ToolFile): Parameters<typeof registerTool>[1] => {
    const level = deloToolTrust(path, text, trust.official, trust.trusted);
    const name = deloToolName(tool.name, level);
    const run = (args: Record<string, unknown>, callSignal?: AbortSignal) => runToolFile(host, tool, args, callSignal);
    const whole = { name, description: tool.description, inputSchema: tool.inputSchema, annotations: ANNOTATIONS, execute: run };
    const key = JSON.stringify([path, text]);
    if (level !== "untrusted" || trust.acceptance.accepted(key)) return whole;
    const schema = unacceptedSchema(tool.inputSchema);
    const request = {
      tool: name,
      rows: [
        ["file", path],
        ["description", tool.description],
        ["input schema", JSON.stringify(tool.inputSchema, null, 2)],
        ["command", tool.command.join(" ")],
      ] as [string, string][],
    };
    return {
      name,
      description: unacceptedDescription(path, trust.computer),
      inputSchema: schema ?? { type: "object" },
      annotations: ANNOTATIONS,
      execute: async (args, callSignal) => {
        if (!await trust.acceptance.accept(key, request)) throw new ToolError("PERMISSION_DENIED", `The user refused ${name}.`);
        if (!signal.aborted && registered.get(file)?.text === text) await register(file, text, whole);
        if (schema === null) throw new ToolError("NOT_READY", `The user accepted ${name}. Call it again with the arguments of its new schema.`);
        return run(args, callSignal);
      },
    };
  };
  const refresh = async () => {
    const tools = await loadToolFiles(host);
    if (signal.aborted) return;
    for (const [file, registration] of registered) {
      if (tools.get(file)?.text === registration.text) continue;
      registration.controller.abort();
      registered.delete(file);
    }
    for (const [file, found] of tools) {
      if (signal.aborted) return;
      if (registered.has(file)) continue;
      await register(file, found.text, definitionOf(file, found));
    }
  };
  let queue = Promise.resolve();
  const enqueue = () => {
    queue = queue.then(refresh).catch((error) => console.error("WebMCP: updating tool files failed", error));
    return queue;
  };
  const off = host.subscribeVfsChanges(TOOLS_DIR, () => void enqueue());
  signal.addEventListener("abort", () => {
    off();
    for (const { controller } of registered.values()) controller.abort();
    registered.clear();
  }, { once: true });
  await enqueue();
}

/** Keep the registered tools equal to the tool files in /etc/mcp while the computer runs, and none while it does not. */
export function wireToolFiles(host: KernelHost, trust: ToolFileTrust): void {
  const context = modelContextOf(document);
  if (context === null) return;
  let controller: AbortController | null = null;
  const sync = () => {
    const running = host.getStatus() === "running";
    if (running === (controller !== null)) return;
    controller?.abort();
    controller = running ? new AbortController() : null;
    if (controller !== null) void followToolFiles(host, context, controller.signal, trust);
  };
  host.subscribeStatus(sync);
  sync();
}
