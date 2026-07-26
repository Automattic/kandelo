import {
  buildForkActivationStateImports,
  ForkActivationRegistry,
  forkActivationRegistrationFromInstance,
} from "../src/fork-activation-registry";
import type { LinkedForkContinuation } from "../src/fork-continuation";
import {
  buildForkExceptionImports,
  ForkExceptionBroker,
  forkExceptionProviderFromInstance,
  type ForkExceptionProvider,
} from "../src/fork-exception-provider";
import {
  computeForkModuleTemplateIdSync,
  ForkModuleStateArena,
} from "../src/fork-module-state";
import { ForkProcessContinuationCoordinator } from "../src/fork-process-continuation";
import { forkResumeTargetsFromInstance } from "../src/fork-resume-catalog";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_NAME,
  isForkUnwindException,
} from "../src/fork-unwind-transport";

export interface SingleActivationForkRuntimeOptions {
  readonly module: WebAssembly.Module;
  readonly moduleBytes: ArrayBufferView;
  readonly memory: WebAssembly.Memory;
  readonly continuation: LinkedForkContinuation;
  readonly newArena: () => ForkModuleStateArena;
  readonly label: string;
}

/**
 * Production-shaped ABI 43 owner for direct instrumenter tests.
 *
 * WHY: these tests instantiate generated Wasm without a process Worker. They
 * still need the real activation registry, resume-event journal, module-state
 * arena, and typed codecs; inert zero stubs would let ABI drift pass while
 * bypassing the ownership protocol the test is supposed to exercise.
 */
export class SingleActivationForkRuntime {
  readonly registry: ForkActivationRegistry;
  readonly coordinator: ForkProcessContinuationCoordinator;
  readonly envImports: Record<string, WebAssembly.ImportValue>;

  private readonly unwindTag = createForkUnwindTag();
  private instance: WebAssembly.Instance | null = null;
  private exceptionProvider: ForkExceptionProvider | null = null;
  private processLaunchRoot = 0;

  constructor(
    private readonly options: SingleActivationForkRuntimeOptions,
  ) {
    const { memory, continuation, label } = options;
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
    this.coordinator.prepareActivation({
      activationId: 0,
      continuation,
      publishProcessLaunchRoot: (address) => {
        this.processLaunchRoot = address;
      },
      readProcessLaunchRoot: () => this.processLaunchRoot,
    });
    const exceptionBroker = new ForkExceptionBroker(
      this.registry,
      `${label}: exception broker`,
    );
    this.envImports = {
      [FORK_UNWIND_TAG_IMPORT_NAME]:
        this.unwindTag as unknown as WebAssembly.ImportValue,
      ...this.coordinator.continuationImports(0, (errno) => {
        this.coordinator.beginCaptureAbort(errno);
      }),
      ...buildForkActivationStateImports(0, this.registry),
      ...buildForkExceptionImports({
        activationId: 0,
        ptrWidth: continuation.format.ptrWidth,
        registry: this.registry,
        broker: exceptionBroker,
        provider: () => {
          if (!this.exceptionProvider) {
            throw new Error(`${label}: exception provider is not registered`);
          }
          return this.exceptionProvider;
        },
      }),
    };
  }

  register(
    instance: WebAssembly.Instance,
    options: { readonly bootstrap?: boolean } = {},
  ): void {
    if (this.instance) {
      throw new Error(`${this.options.label}: activation is already registered`);
    }
    this.instance = instance;
    this.exceptionProvider = forkExceptionProviderFromInstance(0, instance);
    this.coordinator.registerActivation(
      forkActivationRegistrationFromInstance({
        activationId: 0,
        module: this.options.module,
        instance,
        templateId: computeForkModuleTemplateIdSync(this.options.moduleBytes),
        exceptionProvider: this.exceptionProvider,
      }),
      forkResumeTargetsFromInstance(this.options.module, instance),
    );
    if (options.bootstrap ?? true) this.registry.bootstrapActivation(0);
  }

  beginCapture(): void {
    const arena = this.options.newArena();
    arena.begin();
    this.coordinator.beginCapture(arena);
  }

  setCopiedProcessLaunchRoot(address: number): void {
    if (!Number.isSafeInteger(address) || address <= 0) {
      throw new RangeError(
        `${this.options.label}: copied process launch root is invalid`,
      );
    }
    this.processLaunchRoot = address;
  }

  isForkUnwind(value: unknown): boolean {
    return isForkUnwindException(value, this.unwindTag);
  }

  expectCaptureTransport(invoke: () => unknown): void {
    try {
      invoke();
    } catch (error) {
      if (this.isForkUnwind(error)) return;
      throw error;
    }
    throw new Error(
      `${this.options.label}: capture returned instead of transporting unwind`,
    );
  }
}
