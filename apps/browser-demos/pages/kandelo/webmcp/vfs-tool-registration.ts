import type { KernelHost, VfsChangeEvent, VfsDirent } from "../kernel-host";
import type { ModelContext } from "./model-context";
import {
  VFS_TOOLS_DIRS,
  parseVfsTool,
  substituteCommand,
  vfsToolName,
  type VfsTool,
} from "./vfs-tools";

/**
 * Register every tool file under {@link VFS_TOOLS_DIRS}, then keep the
 * registrations in step with those directories until `signal` aborts. Changes
 * are applied one at a time in the order the VFS reported them; a tool whose
 * file no longer parses is unregistered and the error is logged.
 */
export async function registerVfsTools(
  host: KernelHost,
  context: ModelContext,
  signal: AbortSignal,
): Promise<void> {
  const registrations = new Map<string, AbortController>();
  let queue: Promise<void> = Promise.resolve();

  const unregister = (name: string) => {
    registrations.get(name)?.abort();
    registrations.delete(name);
  };
  const register = async (tool: VfsTool) => {
    unregister(tool.name);
    if (signal.aborted) return;
    const controller = new AbortController();
    registrations.set(tool.name, controller);
    await context.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: (args, options) => runVfsTool(host, tool, args, options.signal),
    }, { signal: controller.signal });
  };
  const reload = async (name: string) => {
    unregister(name);
    const tool = await loadVfsTool(host, name);
    if (tool) await register(tool);
  };
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error) => {
      console.error("WebMCP: updating tools failed", error);
    });
    return queue;
  };

  const offs = VFS_TOOLS_DIRS.map((dir) => host.subscribeVfsChanges(dir, (event: VfsChangeEvent) => {
    const name = changedToolName(event.path);
    if (name) void enqueue(() => reload(name));
  }));
  signal.addEventListener("abort", () => {
    for (const off of offs) off();
    for (const name of [...registrations.keys()]) unregister(name);
  }, { once: true });

  await enqueue(async () => {
    for (const tool of await loadVfsTools(host)) await register(tool);
  });
}

export async function loadVfsTools(host: KernelHost): Promise<VfsTool[]> {
  const tools = new Map<string, VfsTool>();
  for (const dir of VFS_TOOLS_DIRS) {
    for (const entry of await toolEntries(host, dir)) {
      const name = vfsToolName(entry.name);
      if (!name) continue;
      tools.set(name, await readVfsTool(host, `${dir}/${entry.name}`));
    }
  }
  return [...tools.values()];
}

export async function loadVfsTool(host: KernelHost, name: string): Promise<VfsTool | null> {
  for (const dir of [...VFS_TOOLS_DIRS].reverse()) {
    const entries = await toolEntries(host, dir);
    const entry = entries.find((candidate) => candidate.name === `${name}.json`);
    if (entry) return readVfsTool(host, `${dir}/${entry.name}`);
  }
  return null;
}

export async function runVfsTool(
  host: KernelHost,
  tool: VfsTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ output: string }> {
  const output = await host.runShellCommand(substituteCommand(tool.command, args), { signal });
  return { output };
}

/** The tool a changed path belongs to, or `null` for anything but a tool file directly in a tool directory. */
export function changedToolName(path: string): string | null {
  for (const dir of VFS_TOOLS_DIRS) {
    if (!path.startsWith(`${dir}/`)) continue;
    const fileName = path.slice(dir.length + 1);
    return fileName.includes("/") ? null : vfsToolName(fileName);
  }
  return null;
}

async function readVfsTool(host: KernelHost, file: string): Promise<VfsTool> {
  return parseVfsTool(file, await host.readFileText(file));
}

async function toolEntries(host: KernelHost, dir: string): Promise<VfsDirent[]> {
  const entries = await host.readDir(dir).catch(() => []);
  return entries.filter((entry) => entry.kind === "f");
}
