import { resetPreviewProgress } from "../panes/preview-progress";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { DIRENT_TYPES } from "@host/generated/abi";
import { guestPath, ToolError } from "./contract";

const DIRENT_TYPE_NAMES: Record<number, string> = {
  [DIRENT_TYPES.DT_DIR]: "directory",
  [DIRENT_TYPES.DT_REG]: "file",
  [DIRENT_TYPES.DT_LNK]: "symlink",
};

/** The guest account every command and file write of the agent runs as. */
export interface WebMcpIdentity {
  uid: number;
  gid: number;
  /** The baseline environment a non-interactive shell needs; the agent's own entries override it. */
  env: string[];
}

/** What `/etc/passwd` says about the identity: where it lives and which shell runs its scripts. */
interface Account {
  home: string;
  shell: string;
}

const FALLBACK_ACCOUNT: Account = { home: "/", shell: "/bin/sh" };

// Identity and the job records this session holds. The identity exists so a
// machine that changed under an in-flight operation is reported rather than
// silently retried.
type Session = {
  unsubscribe: () => void;
  jobs: string[];
  identity: WebMcpIdentity;
  account: Promise<Account> | null;
};
const sessions = new WeakMap<KernelHost, Session>();

// A kernel holds 64 job records at once, and a record outlives its command so
// its output stays readable. Keeping fewer than that per session leaves room
// for families still running, so an agent's session is bounded by the commands
// it runs at once rather than by the commands it has ever run.
const RETAINED_JOBS = 32;

const decoder = new TextDecoder();

export function setWebMcpSession(host: KernelHost, identity: WebMcpIdentity | null): void {
  resetPreviewProgress(host);
  sessions.get(host)?.unsubscribe();
  sessions.delete(host);
  if (!identity) return;
  const session: Session = { unsubscribe: () => {}, jobs: [], identity, account: null };
  sessions.set(host, session);
  session.unsubscribe = host.subscribeStatus(status => {
    if (status === "halted" && sessions.get(host) === session) setWebMcpSession(host, null);
  });
}

export function getWebMcpRuntimeCapabilities(host: KernelHost) {
  const available = sessions.has(host) && host.getStatus() === "running";
  return {
    readFile: available,
    writeFile: available,
    exclusiveFileCreation: available,
    listFiles: available,
    structuredJobs: available,
    jobCancellation: available,
  };
}

function requireSession(host: KernelHost): Session {
  const session = sessions.get(host);
  if (!session || host.getStatus() !== "running") {
    throw new ToolError("NOT_READY", "The live computer is not running.");
  }
  return session;
}

function assertCurrent(host: KernelHost, session: Session): void {
  if (sessions.get(host) !== session || host.getStatus() !== "running") {
    throw new ToolError("STALE_SESSION", "The computer changed during the guest operation. Do not automatically retry a mutation.");
  }
}

export async function readGuestFile(host: KernelHost, path: string): Promise<Uint8Array> {
  guestPath(path);
  const session = requireSession(host);
  let bytes: Uint8Array | null;
  try {
    bytes = await host.readVfsFile(path);
  } catch (error) {
    assertCurrent(host, session);
    throw error;
  }
  assertCurrent(host, session);
  if (bytes === null) {
    throw new ToolError("FILE_NOT_FOUND", "The path does not identify a readable regular guest file.", { path });
  }
  return bytes;
}

export async function writeGuestFile(host: KernelHost, path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  guestPath(path);
  const session = requireSession(host);
  if (bytes.byteLength > 65536) throw new ToolError("INVALID_ARGUMENT", "Guest writes are limited to 65536 decoded bytes.");
  const { uid, gid } = session.identity;
  try {
    await host.writeVfsFile(path, bytes, 0o644, { exclusive: !overwrite, owner: { uid, gid } });
  } catch (error) {
    assertCurrent(host, session);
    if (/EEXIST|already exists|file exists/i.test(String(error))) throw new ToolError("FILE_EXISTS", "The guest path already exists; no bytes were written.", { path });
    if (/ENOENT|no such file|not found/i.test(String(error))) {
      throw new ToolError("FILE_NOT_FOUND", "The parent guest directory must already exist.", { path });
    }
    throw error;
  }
  assertCurrent(host, session);
}

export async function listGuestDirectory(host: KernelHost, path: string) {
  guestPath(path);
  const session = requireSession(host);
  const entries = await host.readVfsDir(path);
  assertCurrent(host, session);
  if (entries === null) {
    throw new ToolError("FILE_NOT_FOUND", "The path does not identify a readable guest directory.", { path });
  }
  // list_files paginates a fresh listing, so offset/limit only line up across
  // calls while the order is stable.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.map(({ name, type, mode, size, uid, gid, target }) => ({
    name,
    type: DIRENT_TYPE_NAMES[type] ?? "other",
    mode,
    size,
    uid,
    gid,
    ...(target === undefined ? {} : { target }),
  }));
}

/**
 * The identity's home and login shell, read once per session from the
 * image's own `/etc/passwd`. An image that does not list the account gets
 * the POSIX fallback, `/bin/sh` at `/`.
 */
function sessionAccount(host: KernelHost, session: Session): Promise<Account> {
  session.account ??= host.readVfsFile("/etc/passwd")
    .then(bytes => (bytes ? passwdAccount(decoder.decode(bytes), session.identity.uid) : null))
    .catch(() => null)
    .then(account => account ?? FALLBACK_ACCOUNT);
  return session.account;
}

export function passwdAccount(passwd: string, uid: number): Account | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 7 || Number(fields[2]) !== uid) continue;
    return { home: fields[5] || FALLBACK_ACCOUNT.home, shell: fields[6] || FALLBACK_ACCOUNT.shell };
  }
  return null;
}

/** The baseline, then the account's home when the baseline names none, then the caller's entries. */
function jobEnv(baseline: string[], home: string, overrides: Record<string, string>): string[] {
  const env = new Map(baseline.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  if (!env.has("HOME")) env.set("HOME", home);
  for (const [name, value] of Object.entries(overrides)) env.set(name, value);
  return [...env].map(([name, value]) => `${name}=${value}`);
}

/**
 * Forget the finished jobs of this session outside its newest ones. A job
 * that is still live refuses release and stays, without holding back the
 * finished jobs around it. A parallel call can release the same job first,
 * so a job leaves the list by its id.
 */
async function releaseFinishedJobs(host: KernelHost, session: Session): Promise<void> {
  for (const id of session.jobs.slice(0, -RETAINED_JOBS)) {
    try {
      await host.releaseOwnedJob(id);
    } catch (error) {
      if (!String(error).includes("UNKNOWN_JOB")) continue;
    }
    session.jobs = session.jobs.filter(job => job !== id);
  }
}

export async function startGuestJob(host: KernelHost, id: string, args: { script: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {
  const session = requireSession(host);
  for (const [name, value] of Object.entries(args.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) throw new ToolError("INVALID_ARGUMENT", "Invalid environment name or NUL in value");
  }
  if (args.script.includes("\0")) throw new ToolError("INVALID_ARGUMENT", "Script must not contain NUL");
  const account = await sessionAccount(host, session);
  assertCurrent(host, session);
  await releaseFinishedJobs(host, session);
  assertCurrent(host, session);
  const { uid, gid, env } = session.identity;
  await host.startOwnedJob(id, account.shell, [account.shell.slice(account.shell.lastIndexOf("/") + 1), "-c", args.script], {
    cwd: args.cwd ?? account.home,
    env: jobEnv(env, account.home, args.env ?? {}),
    uid,
    gid,
    timeoutMs: args.timeoutMs ?? 30000,
  });
  session.jobs.push(id);
  assertCurrent(host, session);
}

export async function readGuestJob(host: KernelHost, id: string, offset?: number, limit?: number, cancel = false) {
  const session = requireSession(host);
  const result = await host.readOwnedJob(id, offset, limit, cancel);
  assertCurrent(host, session);
  return result;
}
