import type { KernelHost, KernelOwnedJobOptions, KernelOwnedJobScope } from "../../../../../web-libs/kandelo-session/src/kernel-host";

interface RetainedCommand {
  id: string;
  owner: KernelOwnedJobScope;
  finished: boolean;
  cancelRequested: boolean;
  cleanup: Promise<boolean> | null;
}

const retained = new Map<string, RetainedCommand>();
const MAX_COMMANDS = 8;
let activeCommands = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

async function cleanupCommand(command: RetainedCommand): Promise<boolean> {
  if (command.cleanup) return command.cleanup;
  command.cleanup = (async () => {
    if (command.owner.closed()) return true;
    try {
      if (!command.finished) {
        const result = await command.owner.read(command.id, undefined, 1, !command.cancelRequested);
        command.cancelRequested = true;
        if (result.expired || !result.terminationObserved) return false;
        command.finished = true;
      }
      await command.owner.release(command.id);
      return true;
    } catch (failure) {
      return command.owner.closed() || failure instanceof Error && failure.message === "UNKNOWN_JOB";
    }
  })();
  try { return await command.cleanup; }
  finally { command.cleanup = null; }
}

export async function retryImageActivityCleanup(): Promise<void> {
  await Promise.all([...retained.values()].map(async command => {
    if (await cleanupCommand(command)) retained.delete(command.id);
  }));
  if (!retained.size && cleanupTimer !== null) { clearTimeout(cleanupTimer); cleanupTimer = null; }
  if (retained.size && cleanupTimer === null) {
    cleanupTimer = setTimeout(() => { cleanupTimer = null; void retryImageActivityCleanup(); }, 1000);
    (cleanupTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}

export async function runImageActivityCommand(
  host: KernelHost,
  command: string,
  account: Pick<KernelOwnedJobOptions, "uid" | "gid" | "env" | "cwd">,
  assertCurrent: () => void,
  timeoutMs = 110_000,
): Promise<string> {
  const id = `image-activity-${crypto.randomUUID()}`;
  assertCurrent();
  await retryImageActivityCleanup();
  assertCurrent();
  if (retained.size + activeCommands >= MAX_COMMANDS) throw new Error("Activity command cleanup is still pending; no command slot is available");
  const owner = host.captureOwnedJobs?.();
  if (!owner) throw new Error("The host cannot bind activity commands to their kernel owner");
  activeCommands++;
  let finished = false;
  let cursor = 0;
  let output = "";
  const deadline = Date.now() + timeoutMs + 5_000;
  try {
    await owner.start(id, "/bin/sh", ["sh", "-c", command], { ...account, timeoutMs });
    for (;;) {
      assertCurrent();
      if (Date.now() > deadline) throw new Error(`Activity command did not finish: ${id}`);
      const read = await owner.read(id, cursor, 16384);
      if (read.expired) { cursor = read.oldest; continue; }
      output = (output + read.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("")).slice(-16384);
      cursor = read.next;
      if (read.terminationObserved) {
        finished = true;
        if (read.status !== "completed" || read.exitCode !== 0) throw new Error(`Activity command failed (${read.status}, exit ${read.exitCode}): ${output}`);
        return output;
      }
      if (!read.hasMore) await new Promise(resolve => setTimeout(resolve, 40));
    }
  } finally {
    activeCommands--;
    retained.set(id, { id, owner, finished, cancelRequested: false, cleanup: null });
    await retryImageActivityCleanup();
  }
}
