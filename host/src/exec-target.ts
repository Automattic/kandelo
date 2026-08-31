import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import {
  CH_DATA_SIZE,
  MAX_REPORTABLE_TRANSFER_BYTES,
} from "./generated/abi";

const EAGAIN = 11;
const EFBIG = 27;
const EIO = 5;
const ENOEXEC = 8;
const ENOMEM = 12;
const EOVERFLOW = 75;
const ETIMEDOUT = 110;
const MAX_SHEBANG_LINE_BYTES = 4096;

// A lazy-archive-backed exec target's kernel read returns EAGAIN while the
// backing archive member is still being fetched (rootfs-lazy-archives.ts),
// then resolves to either bytes or a terminal EIO once the fetch settles. So
// EAGAIN here is guaranteed transient and retrying is safe: exec_target::read
// on the Rust side short-circuits on error before recording any read, making
// a same-offset retry idempotent. The 10ms cadence mirrors the default
// blocking-retry poll (kernel-worker.ts's `#registerTimeout(retryFn, 10)`),
// and a `setTimeout`-backed delay (not a microtask) is required so the
// worker event loop can run the in-flight archive `fetch()` callback between
// retries.
const EXEC_TARGET_EAGAIN_RETRY_DELAY_MS = 10;
// Defensive backstop only — normal operation always resolves via bytes or a
// terminal EIO well before this. It exists so a hypothetical stuck fetch
// fails with a truthful timeout instead of hanging exec forever.
const EXEC_TARGET_EAGAIN_MAX_WAIT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PreparedExecKernel {
  execTargetSize(ownerPid: number, target: number): bigint;
  execTargetRead(
    ownerPid: number,
    target: number,
    offset: bigint,
    destination: Uint8Array,
  ): number;
  execTargetCancel(ownerPid: number, target: number): number;
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
    let eagainWaitedMs = 0;
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
        // The backing lazy-archive member is still being fetched. Retry the
        // exact same offset/destination once the fetch has had a chance to
        // progress; do not throw or cancel the token (see the constant
        // comments above for why this is safe and bounded).
        if (eagainWaitedMs >= EXEC_TARGET_EAGAIN_MAX_WAIT_MS) {
          throw new PreparedExecTargetError(
            "prepared exec target read did not become available after "
              + `${EXEC_TARGET_EAGAIN_MAX_WAIT_MS}ms of retrying a transient `
              + "EAGAIN",
            ETIMEDOUT,
          );
        }
        await delay(EXEC_TARGET_EAGAIN_RETRY_DELAY_MS);
        eagainWaitedMs += EXEC_TARGET_EAGAIN_RETRY_DELAY_MS;
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
  /** Side-effect-free candidate that may be reused only on exact byte identity. */
  readonly preflightCandidate?: Readonly<{
    targetBytes: ArrayBuffer;
    targetModule: WebAssembly.Module;
  }>;
}

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

function exactlyMatchesPreflightCandidate(
  bytes: Uint8Array,
  candidate: ArrayBuffer,
): boolean {
  if (bytes.byteLength !== candidate.byteLength) return false;
  const candidateBytes = new Uint8Array(candidate);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== candidateBytes[index]) return false;
  }
  return true;
}

/**
 * Snapshot and compile one side-effect-free spawn candidate before the child
 * exists. The resolver's separately supplied module is intentionally absent:
 * only a module compiled here from this isolated byte snapshot may be reused
 * when the authoritative final target has exact byte identity.
 */
export async function compileSpawnCandidateSnapshot(
  programBytes: ArrayBuffer,
  expectedAbi: number,
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
    targetModule = await WebAssembly.compile(targetBytes);
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

    let targetModule = options.preflightCandidate
      && exactlyMatchesPreflightCandidate(
        bytes,
        options.preflightCandidate.targetBytes,
      )
      ? options.preflightCandidate.targetModule
      : undefined;
    if (targetModule === undefined) {
      try {
        targetModule = await WebAssembly.compile(targetBytes);
      } catch (cause) {
        if (cause instanceof WebAssembly.CompileError) {
          throw new PreparedExecTargetError(
            "prepared exec target failed WebAssembly compilation",
            ENOEXEC,
          );
        }
        throw cause;
      }
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
