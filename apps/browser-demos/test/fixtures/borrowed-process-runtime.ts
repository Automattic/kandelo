import {
  buildForkActivationStateImports,
  ForkActivationRegistry,
  forkActivationRegistrationFromInstance,
} from "../../../../host/src/fork-activation-registry";
import type { LinkedForkContinuation } from "../../../../host/src/fork-continuation";
import {
  buildForkExceptionImports,
  ForkExceptionBroker,
  forkExceptionProviderFromInstance,
  type ForkExceptionProvider,
} from "../../../../host/src/fork-exception-provider";
import { computeForkModuleTemplateIdSync } from "../../../../host/src/fork-module-state";
import { ForkProcessContinuationCoordinator } from "../../../../host/src/fork-process-continuation";
import { forkResumeTargetsFromInstance } from "../../../../host/src/fork-resume-catalog";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_NAME,
  isForkUnwindException,
} from "../../../../host/src/fork-unwind-transport";

interface PreparedActivation {
  readonly module: WebAssembly.Module;
  readonly moduleBytes: ArrayBufferView;
  readonly continuation: LinkedForkContinuation;
  exceptionProvider: ForkExceptionProvider | null;
  registered: boolean;
}

/** Browser-test owner for a real ABI 43 multi-activation transaction. */
export class BorrowedProcessTestRuntime {
  readonly registry: ForkActivationRegistry;
  readonly coordinator: ForkProcessContinuationCoordinator;

  private readonly unwindTag = createForkUnwindTag();
  private readonly exceptionBroker: ForkExceptionBroker;
  private readonly prepared = new Map<number, PreparedActivation>();
  private processLaunchRoot = 0;

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly label: string,
  ) {
    this.registry = new ForkActivationRegistry(
      memory,
      {
        capture: () => {
          throw new Error(`${label}: fixture unexpectedly captured externref`);
        },
        materialize: () => {
          throw new Error(`${label}: fixture unexpectedly replayed externref`);
        },
      },
      `${label}: activation registry`,
    );
    this.coordinator = new ForkProcessContinuationCoordinator(
      memory,
      this.registry,
      `${label}: process continuation`,
    );
    this.exceptionBroker = new ForkExceptionBroker(
      this.registry,
      `${label}: exception broker`,
    );
  }

  prepareActivation(options: {
    readonly activationId: number;
    readonly module: WebAssembly.Module;
    readonly moduleBytes: ArrayBufferView;
    readonly continuation: LinkedForkContinuation;
    readonly invokeFork?: () => number;
  }): Record<string, WebAssembly.ImportValue> {
    const {
      activationId,
      module,
      moduleBytes,
      continuation,
      invokeFork,
    } = options;
    if (this.prepared.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} was prepared twice`);
    }
    this.coordinator.prepareActivation({
      activationId,
      continuation,
      ...(activationId === 0
        ? {
            publishProcessLaunchRoot: (address: number) => {
              this.processLaunchRoot = address;
            },
            readProcessLaunchRoot: () => this.processLaunchRoot,
          }
        : {}),
    });
    const prepared: PreparedActivation = {
      module,
      moduleBytes,
      continuation,
      exceptionProvider: null,
      registered: false,
    };
    this.prepared.set(activationId, prepared);
    return {
      ...(invokeFork ? { fork: invokeFork } : {}),
      [FORK_UNWIND_TAG_IMPORT_NAME]:
        this.unwindTag as unknown as WebAssembly.ImportValue,
      ...this.coordinator.continuationImports(activationId, (errno) => {
        this.coordinator.beginCaptureAbort(errno);
      }),
      ...buildForkActivationStateImports(activationId, this.registry),
      ...buildForkExceptionImports({
        activationId,
        ptrWidth: continuation.format.ptrWidth,
        registry: this.registry,
        broker: this.exceptionBroker,
        provider: () => {
          if (!prepared.exceptionProvider) {
            throw new Error(
              `${this.label}: activation ${activationId} has no exception provider`,
            );
          }
          return prepared.exceptionProvider;
        },
      }),
    };
  }

  registerActivation(
    activationId: number,
    instance: WebAssembly.Instance,
    bootstrap: boolean,
  ): void {
    const prepared = this.prepared.get(activationId);
    if (!prepared || prepared.registered) {
      throw new Error(
        `${this.label}: activation ${activationId} cannot be registered`,
      );
    }
    prepared.exceptionProvider = forkExceptionProviderFromInstance(
      activationId,
      instance,
    );
    this.coordinator.registerActivation(
      forkActivationRegistrationFromInstance({
        activationId,
        module: prepared.module,
        instance,
        templateId: computeForkModuleTemplateIdSync(prepared.moduleBytes),
        exceptionProvider: prepared.exceptionProvider,
      }),
      forkResumeTargetsFromInstance(prepared.module, instance),
    );
    prepared.registered = true;
    if (bootstrap) this.registry.bootstrapActivation(activationId);
  }

  setProcessLaunchRoot(address: number): void {
    if (!Number.isSafeInteger(address) || address <= 0) {
      throw new RangeError(`${this.label}: invalid process launch root`);
    }
    this.processLaunchRoot = address;
  }

  expectCaptureTransport(invoke: () => unknown): void {
    try {
      invoke();
    } catch (error) {
      if (isForkUnwindException(error, this.unwindTag)) return;
      throw error;
    }
    throw new Error(`${this.label}: capture returned without unwind transport`);
  }
}
