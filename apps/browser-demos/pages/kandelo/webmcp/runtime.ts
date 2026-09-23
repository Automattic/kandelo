import { resetPreviewProgress } from "../panes/preview-progress";
import type { BrowserKernel } from "@host/browser-kernel-host";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { guestPath, ToolError } from "./contract";

// References only: lifecycle and process ownership remain with the existing host.
type Runtime = { kernel: BrowserKernel; unsubscribe: () => void };
const runtimes = new WeakMap<KernelHost, Runtime>();

export function setWebMcpRuntime(host: KernelHost, kernel: BrowserKernel | null): void {
  resetPreviewProgress(host);
  runtimes.get(host)?.unsubscribe();
  runtimes.delete(host);
  if (!kernel) return;
  const runtime: Runtime = { kernel, unsubscribe: () => {} };
  runtimes.set(host, runtime);
  runtime.unsubscribe = host.subscribeStatus(status => {
    if (status === "halted" && runtimes.get(host) === runtime) setWebMcpRuntime(host, null);
  });
}

export function getWebMcpRuntimeCapabilities(host: KernelHost) {
  const available = runtimes.has(host) && host.getStatus() === "running";
  return {
    readFile: available,
    writeFile: available,
    exclusiveFileCreation: available,
    listFiles: available,
    structuredJobs: available,
    jobCancellation: available,
  };
}

function requireRuntime(host: KernelHost): Runtime {
  const runtime = runtimes.get(host);
  if (!runtime || host.getStatus() !== "running") {
    throw new ToolError("NOT_READY", "The live computer is not running.");
  }
  return runtime;
}

function assertCurrent(host: KernelHost, runtime: Runtime): void {
  if (runtimes.get(host) !== runtime || host.getStatus() !== "running") {
    throw new ToolError("STALE_SESSION", "The computer changed during the guest operation. Do not automatically retry a mutation.");
  }
}

export async function readGuestFile(host: KernelHost, path: string): Promise<Uint8Array> {
  guestPath(path);
  const runtime = requireRuntime(host);
  let bytes: Uint8Array | null;
  try {
    bytes = await runtime.kernel.readFileFromVfs(path);
  } catch (error) {
    assertCurrent(host, runtime);
    throw error;
  }
  assertCurrent(host, runtime);
  if (bytes === null) {
    throw new ToolError("FILE_NOT_FOUND", "The path does not identify a readable regular guest file.", { path });
  }
  return bytes;
}

export async function writeGuestFile(host: KernelHost, path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  guestPath(path);
  const runtime = requireRuntime(host);
  if (bytes.byteLength > 65536) throw new ToolError("INVALID_ARGUMENT", "Guest writes are limited to 65536 decoded bytes.");
  try {
    await runtime.kernel.writeFileToVfs(path, bytes, 0o644, !overwrite);
  } catch (error) {
    assertCurrent(host, runtime);
    if (/EEXIST|already exists|file exists/i.test(String(error))) throw new ToolError("FILE_EXISTS", "The guest path already exists; no bytes were written.", { path });
    if (/ENOENT|no such file|not found/i.test(String(error))) {
      throw new ToolError("FILE_NOT_FOUND", "The parent guest directory must already exist.", { path });
    }
    throw error;
  }
  assertCurrent(host, runtime);
}

export async function listGuestDirectory(host: KernelHost, path: string) {
  guestPath(path);
  const runtime = requireRuntime(host);
  const entries = await runtime.kernel.listDirectoryFromVfs(path);
  assertCurrent(host, runtime);
  return entries;
}

export async function startGuestJob(host: KernelHost, id: string, args: { script: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {
  const runtime = requireRuntime(host);
  for (const [name, value] of Object.entries(args.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) throw new ToolError("INVALID_ARGUMENT", "Invalid environment name or NUL in value");
  }
  if (args.script.includes("\0")) throw new ToolError("INVALID_ARGUMENT", "Script must not contain NUL");
  const process = await runtime.kernel.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-c", args.script], {
    cwd: args.cwd ?? "/", env: Object.entries(args.env ?? {}).map(([key, value]) => `${key}=${value}`),
    stdin: new Uint8Array(0), ownedJob: { id, timeoutMs: args.timeoutMs ?? 30000 },
  });
  // Lifecycle/output are read from the worker-owned job record. Consume the
  // separate root-exit rejection when a computer is destroyed mid-command.
  void process.exit.catch(() => {});
  assertCurrent(host, runtime);
}
export async function readGuestJob(host: KernelHost, id: string, offset?: number, limit?: number, cancel = false) {
  const runtime = requireRuntime(host);
  const result = await runtime.kernel.readOwnedJob(id, offset, limit, cancel);
  assertCurrent(host, runtime);
  return result;
}
