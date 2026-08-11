import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
  isWasmModuleBytes,
} from "./constants";
import {
  CH_DATA_SIZE,
  MAX_REPORTABLE_TRANSFER_BYTES,
} from "./generated/abi";

const EFBIG = 27;
const EIO = 5;
const ENOEXEC = 8;
const ENOMEM = 12;
const EOVERFLOW = 75;
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
  readonly commitTarget: (target: number, expectedSize: number) => number;
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

    let targetModule: WebAssembly.Module;
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
    targetLive = false;
    let commitResult: number;
    try {
      commitResult = options.commitTarget(target, targetBytes.byteLength);
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
