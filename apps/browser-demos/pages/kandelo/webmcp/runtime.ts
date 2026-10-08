import { resetPreviewProgress } from "../panes/preview-progress";
import type { KernelHost, KernelOwnedJobRead } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { DIRENT_TYPES } from "@host/generated/abi";
import { guestPath, ToolError } from "./contract";
import { shellQuote } from "./vfs-tools";

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

const SCRIPT_RESULT_BYTES = 256 * 1024;

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

const WRITE_REFUSALS: Record<number, [code: string, message: string]> = {
  3: ["FILE_NOT_FOUND", "The parent guest directory must already exist."],
  4: ["FILE_EXISTS", "The guest path already exists; no bytes were written."],
};

/**
 * Write `bytes` to `path` from a guest process that runs as the agent's
 * account, so the kernel applies that account's permissions and follows
 * symlinks as `open` does. A new file belongs to the account; a replaced file
 * keeps its owner and mode. Without `overwrite` the shell's noclobber option
 * makes the create exclusive.
 */
export async function writeGuestFile(host: KernelHost, path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  guestPath(path);
  requireSession(host);
  if (bytes.byteLength > 65536) throw new ToolError("INVALID_ARGUMENT", "Guest writes are limited to 65536 decoded bytes.");
  const target = shellQuote(path);
  const parent = shellQuote(path.slice(0, path.lastIndexOf("/")) || "/");
  const script = [
    `[ -d ${parent} ] || exit 3`,
    ...(overwrite ? [] : [`if [ -e ${target} ] || [ -h ${target} ]; then exit 4; fi`, "set -C"]),
    `cat > ${target}`,
  ].join("\n");
  const result = await runGuestScript(host, script, { timeoutMs: 30000, stdin: bytes });
  if (result.exitCode === 0) return;
  const refusal = WRITE_REFUSALS[result.exitCode ?? -1];
  if (refusal) throw new ToolError(refusal[0], refusal[1], { path });
  if (/File exists|cannot overwrite existing file/.test(result.stderr)) throw new ToolError(...WRITE_REFUSALS[4], { path });
  if (/Permission denied|Operation not permitted|Read-only file system/.test(result.stderr)) {
    throw new ToolError("PERMISSION_DENIED", "The agent's account may not write this guest path.", { path, stderr: result.stderr });
  }
  throw new ToolError("OPERATION_FAILED", "The guest write did not complete.", { path, exitCode: result.exitCode, stderr: result.stderr });
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
 * the POSIX fallback, `/bin/sh` at `/`, and a listed shell the image does
 * not hold is replaced by `/bin/sh`.
 */
function sessionAccount(host: KernelHost, session: Session): Promise<Account> {
  session.account ??= host.readVfsFile("/etc/passwd")
    .then(bytes => (bytes ? passwdAccount(decoder.decode(bytes), session.identity.uid) : null))
    .then(account => (account ? withInstalledShell(host, account) : null))
    .catch(() => null)
    .then(account => account ?? FALLBACK_ACCOUNT);
  return session.account;
}

async function withInstalledShell(host: KernelHost, account: Account): Promise<Account> {
  const slash = account.shell.lastIndexOf("/");
  const entries = await host.readVfsDir(account.shell.slice(0, slash) || "/");
  if (entries?.some(entry => entry.name === account.shell.slice(slash + 1))) return account;
  return { ...account, shell: FALLBACK_ACCOUNT.shell };
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

export async function startGuestJob(host: KernelHost, id: string, args: { script: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: Uint8Array }) {
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
    ...(args.stdin && { stdin: args.stdin }),
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

type JobChunks = Extract<KernelOwnedJobRead, { expired: false }>["chunks"];

/** The two streams of a job read, each decoded on its own. */
export function jobStreams(chunks: JobChunks): { stdout: string; stderr: string } {
  const decode = (stream: "stdout" | "stderr") => {
    const parts = chunks.filter(chunk => chunk.stream === stream);
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes.length, 0));
    let index = 0;
    for (const part of parts) { bytes.set(part.bytes, index); index += part.bytes.length; }
    return decoder.decode(bytes);
  };
  return { stdout: decode("stdout"), stderr: decode("stderr") };
}

export type GuestScriptResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: Extract<KernelOwnedJobRead, { expired: false }>["status"];
  terminationObserved: boolean;
  /** True when output was dropped: by the kernel before it was read, or past the last 256 KiB. */
  truncated: boolean;
};

/**
 * Run `script` as an owned job and collect its last 256 KiB of output.
 * Resolves once every member of the family has terminated, or once the job's
 * own timeout has passed without that observation; the record is released
 * either way, so this job never counts against the session's retained jobs.
 */
export async function runGuestScript(
  host: KernelHost,
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal; stdin?: Uint8Array },
): Promise<GuestScriptResult> {
  const id = `job-${crypto.randomUUID()}`;
  await startGuestJob(host, id, { script, timeoutMs: options.timeoutMs, stdin: options.stdin });
  const deadline = performance.now() + options.timeoutMs + 5000;
  const chunks: JobChunks = [];
  let cursor: number | undefined;
  let cancelled = false;
  let kept = 0;
  let truncated = false;
  let last: Extract<KernelOwnedJobRead, { expired: false }>;
  try {
    for (;;) {
      const cancel: boolean = Boolean(options.signal?.aborted) && !cancelled;
      cancelled ||= cancel;
      const read = await readGuestJob(host, id, cursor, 65536, cancel);
      if (read.expired) { cursor = read.oldest; truncated = true; continue; }
      last = read;
      chunks.push(...read.chunks);
      kept += read.chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
      let dropped = 0;
      while (kept > SCRIPT_RESULT_BYTES) kept -= chunks[dropped++].bytes.length;
      if (dropped > 0) { chunks.splice(0, dropped); truncated = true; }
      cursor = read.next;
      truncated ||= read.truncated;
      if (read.hasMore) continue;
      if (read.terminationObserved || performance.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    const session = sessions.get(host);
    if (session) session.jobs = session.jobs.filter(job => job !== id);
    await host.releaseOwnedJob(id).catch(() => {});
  }
  return { ...jobStreams(chunks), exitCode: last.exitCode, status: last.status, terminationObserved: last.terminationObserved, truncated };
}

/** Show the first line of a script the agent runs on the terminal the user is looking at. */
export function announceGuestScript(host: KernelHost, terminalPath: string | null, script: string): void {
  if (terminalPath === null) return;
  const [first, ...rest] = script.replace(/\n$/, "").split("\n");
  const line = rest.length === 0 ? first : `${first} ...`;
  host.injectPtyOutput(terminalPath, `\r\n\x1b[2m[agent] ${line}\x1b[0m\r\n`);
}
