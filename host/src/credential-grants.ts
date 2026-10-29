/**
 * Per-process credential grants and the launch policy that asks for them.
 *
 * A credential grant is the user's permission for ONE running image of ONE
 * process to send account credentials to the fixed HTTPS origins its package
 * declared (`credential-requests.ts`). The kernel's process table is the
 * authority (`Process::credential_grant`, read and written through
 * `kernel_get_credential_grant` / `kernel_set_credential_grant`): the kernel
 * ends a grant itself when the process execs or exits, and a fork child never
 * inherits one. The host side here keeps only what the kernel cannot hold —
 * the unguessable token that later tags the process's requests and the
 * declared destinations — as a cache keyed by the grant id it set. A cached
 * grant counts only while the kernel still reports that same id for that pid,
 * so a kernel-side clear the host missed still ends it.
 *
 * Shared verbatim by the Node and browser kernel workers: both hosts prompt,
 * wait, and grant identically. Node programs open real sockets, so on Node
 * nothing yet consumes a grant; the prompt and grant exist for parity, and
 * each question says so (`CredentialRequest.enforcement`).
 */
import type { CredentialRequestDeclaration } from "./credential-requests";
import { KernelReentrantEntryError } from "./kernel-entry-gate";
import { sameFileIdentity, type VfsFileIdentity } from "./vfs/rootfs-inspection";
import {
  retryKernelEntryResult,
  retryKernelEntryResultForGeneration,
} from "./kernel-entry-retry";
import type {
  CredentialAnswerMessage,
  CredentialRequestCancelMessage,
  CredentialRequestMessage,
  GetCredentialGrantMessage,
  RevokeCredentialGrantMessage,
} from "./kernel-protocol-shared";

/** What the host shows the user before a declared program may use credentials. */
export interface CredentialRequest {
  /** The process asking. The grant, if given, is for this process only. */
  pid: number;
  /** The declaring package's name for the program. */
  title: string;
  /** The executable the kernel committed for the image (`/proc/<pid>/exe`). */
  program: string;
  /** The command line the image was started with. */
  argv: string[];
  /** Ancestors via the parent pid up to init, nearest first, best effort. */
  parentChain: { pid: number; program: string }[];
  /** Exact HTTPS origins the grant would allow credentials to be sent to. */
  destinations: readonly string[];
  /** Where the machine's VFS image came from, as the embedder described it. */
  imageSource: string;
  /**
   * True when the file the image was executed from is not the one the
   * machine booted with: its identity (device, inode, size, modification
   * and change times), read from the description the kernel kept when it
   * committed the image, differs from what the declared path named when the
   * declarations were read at boot, or the path did not resolve then. `imageSource` then says where the machine's
   * image came from, not this file; something running on the machine (a
   * guest process, a package install, a boot script) replaced or modified
   * it.
   */
  programChangedSinceBoot: boolean;
  /**
   * What the answer controls on this host. `"proxy-gate"` (browser): only a
   * granted process's requests may carry credential request fields through
   * Kandelo's CORS proxy or credential relay. `"none"` (Node): the answer
   * changes the kernel's grant record, but guest programs open real
   * sockets and nothing on the host enforces it, so an embedder must not
   * present the question as a permission.
   */
  enforcement: CredentialEnforcement;
  /**
   * The path a granted request to each destination would take, grouped by
   * the intermediary that carries it, in destination order. Every
   * destination appears in exactly one entry. Computed by the kernel
   * worker from its own transport configuration (`credential-transport.ts`),
   * so it names the intermediary that would actually see the credentials:
   * a prompt must show it, because whoever operates that intermediary can
   * read them.
   */
  transport: readonly CredentialTransport[];
}

/** See `CredentialRequest.enforcement`. */
export type CredentialEnforcement = "proxy-gate" | "none";

/**
 * One leg of `CredentialRequest.transport`.
 *
 * - `"proxy"`: the browser's CORS proxy receives the request, credentials
 *   included, and forwards it; `via` is the proxy's origin and path.
 * - `"relay"`: the development credential relay of the loopback dev server
 *   the page was served from receives and forwards it; `via` is the relay's
 *   origin and path.
 * - `"direct"`: the program connects to the destination itself (Node, where
 *   programs open real sockets); no intermediary.
 * - `"none"`: nothing can carry it. A browser kernel with no CORS proxy
 *   refuses every credentialed request before dispatch, granted or not.
 */
export interface CredentialTransport {
  readonly kind: "proxy" | "relay" | "direct" | "none";
  /** Origin and path of the intermediary; only for `"proxy"` and `"relay"`. */
  readonly via?: string;
  readonly destinations: readonly string[];
}

/** Computes `CredentialRequest.transport` for a declaration's destinations. */
export type CredentialTransportPlan = (
  destinations: readonly string[],
) => CredentialTransport[];

/**
 * Embedder hook that asks the user. Resolve `true` only for an explicit
 * "Allow for this process"; anything else, a rejection, or a throw denies.
 * `signal` aborts when the question no longer applies (the process exited or
 * replaced its image, or the machine is being torn down) so a dialog can be
 * dismissed; the answer is then ignored.
 */
export type CredentialRequestHandler = (
  request: CredentialRequest,
  options: { signal: AbortSignal },
) => Promise<boolean>;

/** A live grant as the host holds it. */
export interface CredentialGrant {
  /** Nonzero grant id, as recorded in the kernel's process table. */
  readonly id: number;
  /** 32 random bytes, base64url without padding; tags the process's requests. */
  readonly token: string;
  readonly destinations: readonly string[];
}

/** The kernel surface grants are recorded in (CentralizedKernelWorker). */
export interface CredentialGrantKernel {
  /** False when the process is absent or exited (ESRCH). */
  setCredentialGrant(pid: number, grant: number): boolean;
  /** 0 for none, null when the process is absent or exited (ESRCH). */
  getCredentialGrant(pid: number): number | null;
}

interface GrantEntry {
  readonly pid: number;
  readonly grant: CredentialGrant;
}

const MAX_GRANT_ID = 0xffff_ffff;
const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The kernel worker's grants. Every method that consults the kernel enters it
 * synchronously and so must run outside a kernel entry; while another entry
 * holds the gate it throws `KernelReentrantEntryError` (retry on a later
 * host turn, as every other result-bearing kernel query does).
 */
export class CredentialGrants {
  readonly #kernel: CredentialGrantKernel;
  #nextId = 1;
  readonly #byPid = new Map<number, GrantEntry>();
  readonly #byToken = new Map<string, GrantEntry>();

  constructor(kernel: CredentialGrantKernel) {
    this.#kernel = kernel;
  }

  /**
   * Grant `pid`'s current image credentials for `destinations`: mint a grant
   * id and token, record the id in the kernel, and cache the token. Null when
   * the kernel refuses because the process is gone.
   */
  issue(pid: number, destinations: readonly string[]): CredentialGrant | null {
    if (this.#nextId > MAX_GRANT_ID) {
      throw new Error("credential grant ids are exhausted for this kernel");
    }
    const id = this.#nextId++;
    const random = new Uint8Array(TOKEN_BYTES);
    globalThis.crypto.getRandomValues(random);
    const grant: CredentialGrant = Object.freeze({
      id,
      token: base64url(random),
      destinations: Object.freeze([...destinations]),
    });
    if (!this.#kernel.setCredentialGrant(pid, id)) return null;
    this.#drop(pid);
    const entry = { pid, grant };
    this.#byPid.set(pid, entry);
    this.#byToken.set(grant.token, entry);
    return grant;
  }

  /**
   * The grant `pid` holds now, or null. Null unless the kernel still reports
   * the cached id for `pid`; a mismatch (the kernel ended it on exec or exit)
   * drops the cached entry.
   */
  grantFor(pid: number): CredentialGrant | null {
    const entry = this.#byPid.get(pid);
    if (!entry) return null;
    if (this.#kernel.getCredentialGrant(pid) !== entry.grant.id) {
      this.#drop(pid);
      return null;
    }
    return entry.grant;
  }

  /**
   * The id of the grant this host holds for `pid`, or 0, WITHOUT entering
   * the kernel: safe inside a kernel entry (the network backends call it
   * from `host_net_send`). It may name a grant the kernel has already
   * ended; `tagFor` asks the kernel before anything is sent.
   */
  peekGrantId(pid: number): number {
    return this.#byPid.get(pid)?.grant.id ?? 0;
  }

  /**
   * The tag a request carries that `pid` wrote while holding grant
   * `grantId`, sent to `origin`; null unless `pid` still holds that very
   * grant (the kernel confirms) and its destinations include that exact
   * origin (`new URL(url).origin`). Grant ids are never reused, so a grant
   * issued after the write, e.g. after an exec kept the pid, never matches.
   * The network backends ask this when they dispatch a request, outside any
   * kernel entry (request-attribution.ts).
   */
  tagFor(pid: number, grantId: number, origin: string): { token: string } | null {
    if (grantId === 0) return null;
    const grant = this.grantFor(pid);
    return grant !== null && grant.id === grantId &&
        grant.destinations.includes(origin)
      ? { token: grant.token }
      : null;
  }

  /**
   * Whether `token` is a live grant whose destinations include `origin`, an
   * exact origin string such as `new URL(url).origin`.
   */
  verify(token: string, origin: string): boolean {
    const entry = this.#byToken.get(token);
    if (!entry) return false;
    const grant = this.grantFor(entry.pid);
    return grant !== null && grant.token === token &&
      grant.destinations.includes(origin);
  }

  /**
   * End `pid`'s grant in the kernel and the host. A gone process is a no-op.
   * This host is the only writer of grants, so with no cached entry the
   * kernel holds none it set (or has cleared it already) and is not entered.
   */
  revoke(pid: number): void {
    if (!this.#byPid.has(pid)) return;
    this.#kernel.setCredentialGrant(pid, 0);
    this.#drop(pid);
  }

  /** Drop the host entry only; the kernel already ended the grant (exit). */
  forget(pid: number): void {
    this.#drop(pid);
  }

  /** Machine teardown: no grant outlives the kernel. */
  clear(): void {
    this.#byPid.clear();
    this.#byToken.clear();
  }

  #drop(pid: number): void {
    const entry = this.#byPid.get(pid);
    if (!entry) return;
    this.#byPid.delete(pid);
    this.#byToken.delete(entry.grant.token);
  }
}

/** Kernel surface the launch policy reads (CentralizedKernelWorker). */
export interface CredentialLaunchKernel extends CredentialGrantKernel {
  /** `/proc/<pid>/exe`, or null when absent, exited, or not attached. */
  getExePath(pid: number): string | null;
  /**
   * The identity of the file the image was executed from (the description
   * the kernel kept at commit, not what the path names now), or null when
   * absent, exited, or not attached.
   */
  getExeIdentity(pid: number): VfsFileIdentity | null;
  enumProcs(): ReadonlyArray<{ pid: number; ppid: number; comm: string }>;
}

/**
 * The identity of the file at `path` now, or null when it does not resolve
 * (or cannot be inspected). Must run outside a kernel entry; a busy gate
 * throws `KernelReentrantEntryError` for the caller to retry. Used at boot
 * to record what each declared program's path names.
 */
export function programFileIdentity(
  kernel: { rootfsFileIdentity(path: string): VfsFileIdentity },
  path: string,
): VfsFileIdentity | null {
  try {
    return kernel.rootfsFileIdentity(path);
  } catch (error) {
    if (error instanceof KernelReentrantEntryError) throw error;
    return null;
  }
}

/**
 * Open questions one machine may have at a time. A guest that starts
 * declared programs in a loop could otherwise queue questions without
 * bound, each covering the app's interface; beyond this, launches are
 * denied without asking and the denial is reported.
 */
export const MAX_OPEN_CREDENTIAL_QUESTIONS = 8;

/** At most one over-cap denial line per machine per this interval. */
export const OVER_CAP_REPORT_INTERVAL_MS = 5_000;

/**
 * Reports launches denied because a machine already has
 * `MAX_OPEN_CREDENTIAL_QUESTIONS` open. A guest that starts declared
 * programs in a loop is denied on every launch, so a line per denial would
 * flood the console without bound. The first denial is printed at once;
 * the ones after it within the interval are counted, and one summary line
 * gives the count when the interval ends.
 */
export class OverCapReport {
  readonly #report: (message: string) => void;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  #quietUntil = Number.NEGATIVE_INFINITY;
  #heldBack = 0;
  #cancelSummary: (() => void) | null = null;
  #closed = false;

  constructor(
    report: (message: string) => void,
    options: {
      intervalMs?: number;
      now?: () => number;
      /** Run `run` after `delayMs`; returns a cancel function. */
      schedule?: (run: () => void, delayMs: number) => () => void;
    } = {},
  ) {
    this.#report = report;
    this.#intervalMs = options.intervalMs ?? OVER_CAP_REPORT_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  }

  deny(message: string): void {
    if (this.#closed) return;
    const now = this.#now();
    if (now >= this.#quietUntil) {
      this.#quietUntil = now + this.#intervalMs;
      this.#report(message);
      return;
    }
    this.#heldBack++;
    this.#cancelSummary ??= this.#schedule(() => this.#summarize(), this.#quietUntil - now);
  }

  close(): void {
    this.#closed = true;
    this.#cancelSummary?.();
    this.#cancelSummary = null;
  }

  #summarize(): void {
    this.#cancelSummary = null;
    const count = this.#heldBack;
    this.#heldBack = 0;
    if (count === 0 || this.#closed) return;
    this.#quietUntil = this.#now() + this.#intervalMs;
    this.#report(
      `[credentials] ${count} more declared ${count === 1 ? "launch" : "launches"} ran without a grant ` +
        `in the last ${this.#intervalMs / 1000} s: ${MAX_OPEN_CREDENTIAL_QUESTIONS} questions were ` +
        "already open, the most one machine may ask at once",
    );
  }
}

export interface CredentialLaunchPolicyOptions {
  kernel: CredentialLaunchKernel;
  grants: CredentialGrants;
  /** Read once at boot (`createCredentialLaunchPolicy` in process-lifecycle.ts) and frozen. */
  declarations: ReadonlyMap<string, CredentialRequestDeclaration>;
  /**
   * Each declared program's file identity when the declarations were read
   * at boot, keyed like `declarations`; null when it did not resolve then.
   */
  bootIdentities: ReadonlyMap<string, VfsFileIdentity | null>;
  imageSource: string;
  /** See `CredentialRequest.enforcement`; fixed per host. */
  enforcement: CredentialEnforcement;
  /** See `CredentialRequest.transport`; fixed per host configuration. */
  transport: CredentialTransportPlan;
  post: (message: CredentialRequestMessage | CredentialRequestCancelMessage) => void;
  /** Where a failed prompt or grant is reported; it never stops the launch. */
  report: (message: string) => void;
}

interface PendingPrompt {
  readonly pid: number;
  readonly resolve: (allow: boolean) => void;
}

const MAX_PARENT_CHAIN = 64;

/**
 * When a declared program's image is committed, ask the user and grant the
 * process. Both kernel workers call `imageCommitted` from every path that
 * commits an image — exec, guest `posix_spawn`, and the host's root spawn —
 * after the commit and before the image's first instruction can run. Fork
 * never calls it: a fork child runs its parent's image and holds no grant.
 */
export class CredentialLaunchPolicy {
  readonly #options: CredentialLaunchPolicyOptions;
  /**
   * A fresh, never-reused number per committed image of each live pid, so a
   * late answer cannot land on a later image. Exit deletes the pid's entry,
   * keeping this bounded by live processes.
   */
  readonly #imageGeneration = new Map<number, number>();
  #nextGeneration = 1;
  readonly #pending = new Map<number, PendingPrompt>();
  readonly #overCap: OverCapReport;
  #nextRequestId = 1;
  #closed = false;

  constructor(options: CredentialLaunchPolicyOptions) {
    this.#options = options;
    this.#overCap = new OverCapReport(options.report);
  }

  get grants(): CredentialGrants {
    return this.#options.grants;
  }

  /**
   * `pid` committed a new image. Ends any grant the previous image held, and
   * if the new image is a declared program, asks the user. With
   * `launch = "wait"` the returned promise settles only once the answer has
   * been applied, so the caller starts the process after it; with
   * `"continue"` it settles at once and the grant follows the answer. A
   * declined or failed prompt never stops the program: it runs without a
   * grant.
   */
  async imageCommitted(pid: number, argv: readonly string[]): Promise<void> {
    const generation = this.#bumpGeneration(pid);
    let program: string | null = null;
    let executed: VfsFileIdentity | null = null;
    try {
      // The kernel cleared the grant at this commit. One set by a late answer
      // for the previous image between the commit and now is cleared here,
      // before the new image can run.
      await retryKernelEntryResult(() => this.#options.grants.revoke(pid));
      if (this.#closed || this.#options.declarations.size === 0) return;
      // Path and identity in one synchronous pass, so no syscall can commit
      // another image between them. The identity is the file the kernel
      // kept for this image, not what the path names now: a guest that can
      // write the program's directory could move the real file back after
      // its own was executed under that name.
      ({ program, executed } = await retryKernelEntryResult(() => {
        const path = this.#options.kernel.getExePath(pid);
        if (path === null) return { program: null, executed: null };
        let identity: VfsFileIdentity | null = null;
        try {
          identity = this.#options.kernel.getExeIdentity(pid);
        } catch (error) {
          if (error instanceof KernelReentrantEntryError) throw error;
          // Not knowing is not "unchanged": a null identity counts as changed.
        }
        return { program: path, executed: identity };
      }));
    } catch (error) {
      // Never fail the launch over the credential question: the program runs
      // without a grant, and the failure is reported.
      this.#options.report(
        `[credentials] could not identify pid ${pid}'s program; it runs without a grant: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (program === null) return;
    const declaration = this.#options.declarations.get(program);
    if (!declaration) return;
    const atBoot = this.#options.bootIdentities.get(program) ?? null;
    const changed = executed === null || atBoot === null ||
      !sameFileIdentity(executed, atBoot);
    const asked = this.#askAndGrant(pid, generation, program, [...argv], declaration, changed);
    if (declaration.launch === "wait") await asked;
  }

  /**
   * Answer a main-thread credential message (`credential_answer`,
   * `get_credential_grant`, `revoke_credential_grant`). Returns false for any
   * other message. Shared so both kernel workers answer identically.
   */
  handleMessage(
    message: { type: string },
    respond: (requestId: number, result: unknown) => void,
    respondError: (requestId: number, error: string) => void,
  ): boolean {
    switch (message.type) {
      case "credential_answer": {
        const { requestId, allow } = message as CredentialAnswerMessage;
        this.answer(requestId, allow);
        return true;
      }
      case "get_credential_grant":
      case "revoke_credential_grant": {
        const { requestId, pid } = message as GetCredentialGrantMessage;
        const revoke = message.type === "revoke_credential_grant";
        void retryKernelEntryResult(() => {
          if (revoke) this.#options.grants.revoke(pid);
          return this.#options.kernel.getCredentialGrant(pid);
        }).then(
          (grant) => respond(requestId, grant),
          (error) => respondError(
            requestId,
            error instanceof Error ? error.message : String(error),
          ),
        );
        return true;
      }
      default:
        return false;
    }
  }

  /** `pid` exited: drop its grant and withdraw any question it was asked. */
  processEnded(pid: number): void {
    this.#withdrawFor(pid);
    this.#imageGeneration.delete(pid);
    this.#options.grants.forget(pid);
  }

  /** Deliver the main thread's answer; an unknown or withdrawn id is ignored. */
  answer(requestId: number, allow: boolean): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    pending.resolve(allow === true);
  }

  /** Machine teardown: deny every open question so no launch waits forever. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#overCap.close();
    for (const [requestId, pending] of [...this.#pending]) {
      this.#withdraw(requestId, pending);
    }
    this.#options.grants.clear();
    this.#imageGeneration.clear();
  }

  #bumpGeneration(pid: number): number {
    const generation = this.#nextGeneration++;
    this.#imageGeneration.set(pid, generation);
    this.#withdrawFor(pid);
    return generation;
  }

  #withdrawFor(pid: number): void {
    for (const [requestId, pending] of [...this.#pending]) {
      if (pending.pid === pid) this.#withdraw(requestId, pending);
    }
  }

  #withdraw(requestId: number, pending: PendingPrompt): void {
    this.#pending.delete(requestId);
    pending.resolve(false);
    try {
      this.#options.post({ type: "credential_request_cancel", requestId });
    } catch {
      // A closed main-thread port cannot be told; the launch is unaffected.
    }
  }

  async #askAndGrant(
    pid: number,
    generation: number,
    program: string,
    argv: string[],
    declaration: CredentialRequestDeclaration,
    programChangedSinceBoot: boolean,
  ): Promise<void> {
    const isCurrent = () =>
      !this.#closed && this.#imageGeneration.get(pid) === generation;
    try {
      const parentChain = await this.#parentChain(pid);
      if (!isCurrent()) return;
      const allow = await this.#prompt({
        pid,
        title: declaration.title,
        program,
        argv,
        parentChain,
        destinations: declaration.destinations,
        imageSource: this.#options.imageSource,
        programChangedSinceBoot,
        enforcement: this.#options.enforcement,
        transport: this.#options.transport(declaration.destinations),
      });
      if (!allow) return;
      // Re-checked inside every retry: a retry yields, and the process may
      // exec or exit before the kernel entry runs.
      const result = await retryKernelEntryResultForGeneration(
        isCurrent,
        () => this.#options.grants.issue(pid, declaration.destinations),
      );
      if (result.status === "current" && result.value === null) {
        this.#options.report(
          `[credentials] pid ${pid} (${program}) ended before its grant was recorded`,
        );
      }
    } catch (error) {
      this.#options.report(
        `[credentials] asking for pid ${pid} (${program}) failed; it runs without a grant: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  #prompt(request: CredentialRequest): Promise<boolean> {
    if (this.#pending.size >= MAX_OPEN_CREDENTIAL_QUESTIONS) {
      this.#overCap.deny(
        `[credentials] pid ${request.pid} (${request.program}) runs without a grant: ` +
          `${this.#pending.size} questions are already open, the most one machine may ask at once`,
      );
      return Promise.resolve(false);
    }
    const requestId = this.#nextRequestId++;
    return new Promise<boolean>((resolve) => {
      this.#pending.set(requestId, { pid: request.pid, resolve });
      try {
        this.#options.post({ type: "credential_request", requestId, request });
      } catch (error) {
        this.#pending.delete(requestId);
        this.#options.report(
          `[credentials] could not ask about pid ${request.pid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        resolve(false);
      }
    });
  }

  async #parentChain(pid: number): Promise<{ pid: number; program: string }[]> {
    const snapshots = await retryKernelEntryResult(() =>
      this.#options.kernel.enumProcs()
    );
    const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    const chain: { pid: number; program: string }[] = [];
    const seen = new Set<number>([pid]);
    let current = byPid.get(pid)?.ppid ?? 0;
    while (current > 0 && !seen.has(current) && chain.length < MAX_PARENT_CHAIN) {
      seen.add(current);
      const ancestor = current;
      const exe = await retryKernelEntryResult(() =>
        this.#options.kernel.getExePath(ancestor)
      );
      const snapshot = byPid.get(ancestor);
      chain.push({ pid: ancestor, program: exe ?? snapshot?.comm ?? "" });
      current = snapshot?.ppid ?? 0;
    }
    return chain;
  }
}

type CredentialMainMessage =
  | CredentialAnswerMessage
  | GetCredentialGrantMessage
  | RevokeCredentialGrantMessage;

/** Whether `message` is one of the main thread's credential messages. */
export function isCredentialMainMessage(
  message: { type: string },
): message is CredentialMainMessage {
  return message.type === "credential_answer" ||
    message.type === "get_credential_grant" ||
    message.type === "revoke_credential_grant";
}

/**
 * Kernel-worker dispatch for the main thread's credential messages, shared by
 * both entries. Before boot finishes there is no policy: an answer is
 * dropped (nothing was asked) and a query fails visibly.
 */
export function dispatchCredentialMainMessage(
  policy: CredentialLaunchPolicy | null,
  message: CredentialMainMessage,
  respond: (requestId: number, result: unknown) => void,
  respondError: (requestId: number, error: string) => void,
): void {
  if (policy) {
    policy.handleMessage(message, respond, respondError);
  } else if (message.type !== "credential_answer") {
    respondError(message.requestId, "the kernel is not initialized");
  }
}
