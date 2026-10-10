import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import {
  CH_DATA_SIZE,
  MAX_REPORTABLE_TRANSFER_BYTES,
} from "./generated/abi";
import { waitForDeferredFetch } from "./vfs/rootfs-lazy-archives";

const EAGAIN = 11;
const EFBIG = 27;
const EIO = 5;
const ENOEXEC = 8;
const ENOMEM = 12;
const EOVERFLOW = 75;
const ETIMEDOUT = 110;

// An exec target the image only names (a lazy file, or a lazy-archive member)
// is fetched by the host on first read through `host_fetch_deferred`, and the
// kernel's read returns EAGAIN until that fetch settles, then either bytes or
// a terminal error. So EAGAIN here is transient and retrying is safe: the
// kernel's exec-target read records nothing before it fails, making a
// same-offset retry idempotent. The retry waits for the fetch to settle
// (`waitForDeferredFetch`), which also yields the worker's event loop so the
// in-flight fetch can run; waiting a fixed timer instead added the rest of a
// timer period to every first exec of a lazy file. Only an EAGAIN with no
// fetch in flight falls back to this plain delay between retries.
const EXEC_TARGET_EAGAIN_RETRY_DELAY_MS = 10;
// Backstop only: a fetch normally settles long before this. It exists so a
// stuck fetch fails exec with a truthful timeout instead of hanging it.
const EXEC_TARGET_EAGAIN_MAX_WAIT_MS = 30_000;

const MAX_SHEBANG_LINE_BYTES = 4096;

export interface PreparedExecKernel {
  execTargetSize(ownerPid: number, target: number): bigint;
  execTargetRead(
    ownerPid: number,
    target: number,
    offset: bigint,
    destination: Uint8Array,
  ): number;
  execTargetCancel(ownerPid: number, target: number): number;
  /** The next settlement of a deferred fetch in flight, or `null` when none
   *  is; see `CentralizedKernelWorker.deferredFetchSettled`. Optional: a
   *  kernel without a deferred pipe never returns EAGAIN for one. */
  deferredFetchSettled?(): Promise<void> | null;
}

export class PreparedExecTargetError extends Error {
  readonly errno: number;
  targetCancelled: boolean;

  constructor(message: string, errno: number, targetCancelled = false) {
    super(message);
    this.name = "PreparedExecTargetError";
    this.errno = errno;
    this.targetCancelled = targetCancelled;
  }
}

function targetError(cause: unknown, fallback: string): PreparedExecTargetError {
  if (cause instanceof PreparedExecTargetError) return cause;
  return new PreparedExecTargetError(
    cause instanceof Error ? `${fallback}: ${cause.message}` : fallback,
    EIO,
  );
}

function errnoFromNegativeResult(result: number | bigint): number {
  const errno = typeof result === "bigint" ? -result : -result;
  if (errno > 0 && errno <= 4095) return Number(errno);
  return EIO;
}

function cancelPreparedTarget(
  kernel: PreparedExecKernel,
  ownerPid: number,
  target: number,
  error: PreparedExecTargetError,
): PreparedExecTargetError {
  if (error.targetCancelled) return error;
  // One attempt consumes this host-side cancellation obligation even when a
  // corrupt kernel reports an error. Retrying could consume a reused token.
  error.targetCancelled = true;
  try {
    kernel.execTargetCancel(ownerPid, target);
  } catch {
    // Preserve the original precommit failure. The kernel entry/fatal boundary
    // owns any exception raised while trying to release its retained target.
  }
  return error;
}

export async function readPreparedExecTarget(
  kernel: PreparedExecKernel,
  ownerPid: number,
  target: number,
): Promise<Uint8Array> {
  try {
    const size = kernel.execTargetSize(ownerPid, target);
    if (size < 0n) {
      throw new PreparedExecTargetError(
        "prepared exec target size failed",
        errnoFromNegativeResult(size),
      );
    }
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PreparedExecTargetError(
        "prepared exec target size is not a safe JavaScript length",
        EOVERFLOW,
      );
    }
    if (size > BigInt(MAX_REPORTABLE_TRANSFER_BYTES)) {
      throw new PreparedExecTargetError(
        "prepared exec target exceeds the program-size limit",
        EFBIG,
      );
    }

    let output: Uint8Array;
    try {
      // This is the sole target-sized allocation. Every kernel read is copied
      // into a bounded view of this exact destination.
      output = new Uint8Array(Number(size));
    } catch (cause) {
      throw new PreparedExecTargetError(
        cause instanceof Error
          ? `unable to allocate prepared exec target: ${cause.message}`
          : "unable to allocate prepared exec target",
        ENOMEM,
      );
    }

    let offset = 0n;
    let eagainSince: number | undefined;
    while (offset < size) {
      const start = Number(offset);
      const capacity = Math.min(
        CH_DATA_SIZE,
        output.byteLength - start,
      );
      const destination = output.subarray(start, start + capacity);
      const read = kernel.execTargetRead(
        ownerPid,
        target,
        offset,
        destination,
      );
      if (read === -EAGAIN) {
        // The deferred bytes are still being fetched: retry the same offset
        // once the fetch has settled.
        eagainSince ??= Date.now();
        const eagainWaitedMs = Date.now() - eagainSince;
        if (eagainWaitedMs >= EXEC_TARGET_EAGAIN_MAX_WAIT_MS) {
          throw new PreparedExecTargetError(
            "prepared exec target read did not become available after "
              + `${EXEC_TARGET_EAGAIN_MAX_WAIT_MS}ms of retrying a transient `
              + "EAGAIN",
            ETIMEDOUT,
          );
        }
        const inFlight = kernel.deferredFetchSettled?.() ?? null;
        await waitForDeferredFetch(
          inFlight,
          inFlight === null
            ? EXEC_TARGET_EAGAIN_RETRY_DELAY_MS
            : EXEC_TARGET_EAGAIN_MAX_WAIT_MS - eagainWaitedMs,
        );
        continue;
      }
      if (read < 0) {
        throw new PreparedExecTargetError(
          "prepared exec target read failed",
          errnoFromNegativeResult(read),
        );
      }
      if (!Number.isSafeInteger(read) || read === 0 || read > capacity) {
        throw new PreparedExecTargetError(
          "prepared exec target returned a non-progressing or oversized read",
          EIO,
        );
      }
      offset += BigInt(read);
    }
    return output;
  } catch (cause) {
    throw cancelPreparedTarget(
      kernel,
      ownerPid,
      target,
      targetError(cause, "prepared exec target read failed"),
    );
  }
}

export interface PreparedExecLaunchRequest {
  readonly pid: number;
  diagnosticPath: string;
  readonly argv: string[];
  readonly envp: string[];
  readonly targetBytes: ArrayBuffer;
  readonly targetModule: WebAssembly.Module;
}

/** Host work that becomes legal only after the shared launcher commits. */
export interface PreparedExecLaunchPlan {
  /** Release replacement resources when the kernel rejects the commit. */
  readonly onCommitFailure: (result?: number) => void;
  /** Retire the old image and start the replacement without another commit. */
  readonly startAfterCommit: () => Promise<number>;
}

export type ExecLaunchCallback = (
  request: PreparedExecLaunchRequest,
) => Promise<number | PreparedExecLaunchPlan>;

export interface PreparedExecLaunchOptions {
  readonly kernel: PreparedExecKernel;
  readonly ownerPid: number;
  readonly pid: number;
  readonly callerTid: number;
  readonly diagnosticPath: string;
  readonly argv: string[];
  readonly envp: string[];
  readonly expectedAbi: number;
  readonly materializePath: (diagnosticPath: string) => Promise<void>;
  readonly prepareInitialTarget: () => number;
  readonly prepareInterpreterTarget: (interpreterPath: string) => number;
  readonly commitTarget: (
    target: number,
    expectedSize: number,
    markTargetConsumed: () => void,
  ) => number;
  /**
   * Compile, or reuse the module already compiled for, exactly these bytes.
   * The kernel worker's content-addressed cache keys on a digest of the
   * bytes, so a spawn's preflight module is reused only when the final
   * target is byte-identical to the candidate.
   */
  readonly compileModule: CompileWasmModule;
  /**
   * A spawn's preflight module. Never executed or compared here: it only
   * stays reachable through these options until the final target compiles,
   * so the weakly held cache entry for byte-identical bytes cannot be
   * collected in between.
   */
  readonly preflightModule?: WebAssembly.Module;
}

export type CompileWasmModule = (
  bytes: ArrayBuffer,
) => Promise<WebAssembly.Module>;

function parseShebang(bytes: Uint8Array): {
  interpreter: string;
  argument?: string;
} | null {
  if (bytes.byteLength < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) {
    return null;
  }
  let end = 2;
  while (
    end < bytes.byteLength
    && end < MAX_SHEBANG_LINE_BYTES
    && bytes[end] !== 0x0a
  ) {
    end += 1;
  }
  const line = new TextDecoder()
    .decode(bytes.subarray(2, end))
    .replace(/\r$/, "")
    .trim();
  const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
  if (!match) return null;
  return { interpreter: match[1]!, argument: match[2] };
}

function preparedTargetToken(result: number): number {
  if (Number.isSafeInteger(result) && result > 0) return result;
  throw new PreparedExecTargetError(
    "prepared exec target creation failed",
    result < 0 ? errnoFromNegativeResult(result) : EIO,
  );
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer;
}

/**
 * Snapshot and compile one side-effect-free spawn candidate before the child
 * exists. The resolver's separately supplied module is intentionally absent:
 * only a module compiled here from this isolated byte snapshot may be reused,
 * and the content-addressed `compileModule` reuses it for the authoritative
 * final target only when that target has the same bytes.
 */
export async function compileSpawnCandidateSnapshot(
  programBytes: ArrayBuffer,
  expectedAbi: number,
  compileModule: CompileWasmModule,
): Promise<Readonly<{
  targetBytes: ArrayBuffer;
  targetModule: WebAssembly.Module;
}>> {
  let snapshot: Uint8Array;
  try {
    const source = new Uint8Array(programBytes);
    if (source.byteLength > MAX_REPORTABLE_TRANSFER_BYTES) {
      throw new PreparedExecTargetError(
        "spawn candidate exceeds the program-size limit",
        EFBIG,
      );
    }
    // Copy before the first await. A resolver retains no mutable authority
    // over the candidate compared or launched by the shared worker.
    snapshot = source.slice();
  } catch (cause) {
    if (cause instanceof PreparedExecTargetError) throw cause;
    throw new PreparedExecTargetError(
      "spawn candidate bytes are unavailable",
      ENOEXEC,
    );
  }

  const targetBytes = exactArrayBuffer(snapshot);
  if (!isWasmModuleBytes(targetBytes)) {
    throw new PreparedExecTargetError(
      "spawn candidate is not a WebAssembly module",
      ENOEXEC,
    );
  }
  const targetAbi = extractAbiVersion(targetBytes);
  if (
    describeWasmArtifactPolicyFailures(targetBytes, { expectedAbi }).length > 0
    || (targetAbi !== null && targetAbi !== expectedAbi)
  ) {
    throw new PreparedExecTargetError(
      "spawn candidate violates the artifact ABI policy",
      ENOEXEC,
    );
  }

  let targetModule: WebAssembly.Module;
  try {
    targetModule = await compileModule(targetBytes);
  } catch (cause) {
    if (cause instanceof WebAssembly.CompileError) {
      throw new PreparedExecTargetError(
        "spawn candidate failed WebAssembly compilation",
        ENOEXEC,
      );
    }
    throw cause;
  }
  return { targetBytes, targetModule };
}

export async function launchPreparedExecTarget(
  options: PreparedExecLaunchOptions,
  callback: ExecLaunchCallback,
): Promise<number> {
  await options.materializePath(options.diagnosticPath);
  let target = preparedTargetToken(options.prepareInitialTarget());
  let bytes = await readPreparedExecTarget(
    options.kernel,
    options.ownerPid,
    target,
  );

  let targetLive = true;
  let launchArgv = [...options.argv];
  let finalDiagnosticPath = options.diagnosticPath;
  const script = parseShebang(bytes);
  if (script !== null) {
    // Script set-ID state is deliberately never committed. Consume the script
    // token before preparing the interpreter as the sole final authority.
    targetLive = false;
    const cancelResult = options.kernel.execTargetCancel(
      options.ownerPid,
      target,
    );
    if (cancelResult < 0) {
      throw new PreparedExecTargetError(
        "unable to cancel prepared script target",
        errnoFromNegativeResult(cancelResult),
        true,
      );
    }
    launchArgv = [
      script.interpreter,
      ...(script.argument ? [script.argument] : []),
      options.diagnosticPath,
      ...options.argv.slice(1),
    ];
    finalDiagnosticPath = script.interpreter;
    await options.materializePath(script.interpreter);
    target = preparedTargetToken(
      options.prepareInterpreterTarget(script.interpreter),
    );
    bytes = await readPreparedExecTarget(
      options.kernel,
      options.ownerPid,
      target,
    );
    targetLive = true;
    if (parseShebang(bytes) !== null) {
      throw cancelPreparedTarget(
        options.kernel,
        options.ownerPid,
        target,
        new PreparedExecTargetError(
          "the prepared shebang interpreter is itself a script",
          ENOEXEC,
        ),
      );
    }
  }

  try {
    const targetBytes = exactArrayBuffer(bytes);
    if (!isWasmModuleBytes(targetBytes)) {
      throw new PreparedExecTargetError(
        "prepared exec target is not a WebAssembly module",
        ENOEXEC,
      );
    }
    const targetAbi = extractAbiVersion(targetBytes);
    if (
      describeWasmArtifactPolicyFailures(targetBytes, {
        expectedAbi: options.expectedAbi,
      }).length > 0
      || (targetAbi !== null && targetAbi !== options.expectedAbi)
    ) {
      throw new PreparedExecTargetError(
        "prepared exec target violates the artifact ABI policy",
        ENOEXEC,
      );
    }

    // Every admission check above ran on these exact bytes; the cache only
    // replaces the compile step, never the checks.
    let targetModule: WebAssembly.Module;
    try {
      targetModule = await options.compileModule(targetBytes);
    } catch (cause) {
      if (cause instanceof WebAssembly.CompileError) {
        throw new PreparedExecTargetError(
          "prepared exec target failed WebAssembly compilation",
          ENOEXEC,
        );
      }
      throw cause;
    }

    const request: PreparedExecLaunchRequest = {
      pid: options.pid,
      diagnosticPath: finalDiagnosticPath,
      argv: launchArgv,
      envp: [...options.envp],
      targetBytes,
      targetModule,
    };
    const decision = await callback(request);
    if (typeof decision === "number") {
      targetLive = false;
      options.kernel.execTargetCancel(options.ownerPid, target);
      return decision < 0 ? decision : -EIO;
    }

    // The opaque token never entered the async callback. The shared launcher
    // alone owns this no-yield commit edge and invokes the postcommit action
    // immediately after Rust consumes the token.
    let commitResult: number;
    try {
      commitResult = options.commitTarget(
        target,
        targetBytes.byteLength,
        () => {
          // The production wrapper calls this immediately before the raw
          // commit/cancel export. A throw before that edge leaves the token
          // cancellable; a host-import throw after it has uncertain/consumed
          // Rust ownership and must never retry the token.
          targetLive = false;
        },
      );
      // Every numeric kernel result has settled the exact token, including a
      // rejected commit. Test doubles may omit the marker because they cannot
      // throw from inside Rust after taking the target.
      targetLive = false;
    } catch (cause) {
      decision.onCommitFailure();
      throw cause;
    }
    if (commitResult < 0) {
      decision.onCommitFailure(commitResult);
      return commitResult;
    }
    return await decision.startAfterCommit();
  } catch (cause) {
    if (targetLive) {
      targetLive = false;
      const error = targetError(cause, "prepared exec launch failed");
      throw cancelPreparedTarget(
        options.kernel,
        options.ownerPid,
        target,
        error,
      );
    }
    throw cause;
  }
}
