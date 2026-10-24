import type { BrowserKernel } from "@host/browser-kernel-host";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UnconfirmedPersistentKernelQuiescence extends Error {
  constructor(readonly kernel: BrowserKernel, options?: ErrorOptions) {
    const detail = options?.cause === undefined ? "" : `: ${errorMessage(options.cause)}`;
    super(`persistent kernel storage quiescence is unconfirmed; computer remains locked${detail}`, options);
  }
}

export class UnconfirmedPersistentBridgeQuiescence extends UnconfirmedPersistentKernelQuiescence {
  constructor(kernel: BrowserKernel, cause: unknown) {
    super(kernel, { cause });
    this.message = "persistent HTTP bridge ownership is uncertain; computer remains locked until reload";
  }
}

export async function withPersistentKernelCleanup<Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>,
): Promise<Result> {
  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
      const failures = new AggregateError(
        [operationError, cleanupError],
        `persistent kernel operation failed: ${errorMessage(operationError)}; cleanup failed: ${errorMessage(cleanupError)}`,
      );
      if (cleanupError instanceof UnconfirmedPersistentKernelQuiescence) {
        throw new UnconfirmedPersistentKernelQuiescence(cleanupError.kernel, { cause: failures });
      }
      throw failures;
    }
  }
}
