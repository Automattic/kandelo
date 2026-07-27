/**
 * Single-entry serialization for calls into the kernel WebAssembly instance.
 *
 * Kernel exports may synchronously call a host import while Rust still owns
 * mutable kernel state. A host callback must therefore not enter another
 * export until the outer call has returned to the event loop.
 */

type DeferredKernelEntry = {
  readonly kind: "void-ingress";
  readonly label: string;
  readonly operation: (
    scope: KernelVoidIngressScope,
    effects: KernelEntryEffectRegistrar,
  ) => undefined;
  readonly dedupeKey?: object;
};

const kernelVoidIngressScopeBrand: unique symbol = Symbol(
  "KernelVoidIngressScope",
);

/** Opaque, gate-bound authority for one synchronous void ingress. */
export interface KernelVoidIngressScope {
  readonly [kernelVoidIngressScopeBrand]: true;
}

export interface KernelEntryEffectRegistrar {
  readonly deferProtocolEffect: (operation: () => undefined) => undefined;
  /**
   * Start one host-owned asynchronous transaction after scope revocation.
   *
   * The callback may synchronously launch host work and register its captured-
   * Promise continuations, but it receives no Wasm authority and must return
   * undefined before later ingress can run. Each continuation must re-enter
   * through a fresh identity-checked ingress before touching kernel state.
   */
  readonly deferProtocolTransactionStart:
    (operation: () => undefined) => undefined;
  readonly deferObserverEffect: (operation: () => undefined) => undefined;
}

type KernelDetachedEffect = {
  readonly kind: "protocol" | "protocol-transaction-start" | "observer";
  readonly operation: () => undefined;
};

type GatedInstanceRecord = {
  readonly rawInstance: WebAssembly.Instance;
  readonly gate: KernelEntryGate;
};

type VoidIngressScopeRecord = {
  readonly gate: KernelEntryGate;
  readonly invoke: <T>(operation: () => T) => T;
  readonly invokeSerializedHostOperation: <T>(operation: () => T) => T;
};

type RawInstanceGateRecord = {
  readonly gate: KernelEntryGate;
  readonly facade: WebAssembly.Instance;
};

// WHY: kernel exports can call arbitrary host hooks before the gate drains.
// Capture every mutable intrinsic used for queueing, wrapping, invocation,
// and hidden authority lookup before those hooks can replace globals or
// prototype methods.
const IntrinsicError = Error;
const IntrinsicProxy = Proxy;
const IntrinsicSet = Set;
const intrinsicApply = Reflect.apply;
const intrinsicReflectGet = Reflect.get;
const intrinsicArrayPush = Array.prototype.push;
const intrinsicArrayShift = Array.prototype.shift;
const intrinsicConsoleError = console.error;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectEntries = Object.entries;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
const intrinsicObjectSetPrototypeOf = Object.setPrototypeOf;
const intrinsicQueueMicrotask = queueMicrotask;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicSetAdd = Set.prototype.add;
const intrinsicSetClear = Set.prototype.clear;
const intrinsicSetDelete = Set.prototype.delete;
const intrinsicSetHas = Set.prototype.has;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicInstanceExports = intrinsicObjectGetOwnPropertyDescriptor(
  WebAssembly.Instance.prototype,
  "exports",
)!.get!;
const intrinsicWasmInstancePrototype = WebAssembly.Instance.prototype;

const gatedInstances = new WeakMap<WebAssembly.Instance, GatedInstanceRecord>();
const rawInstanceGates =
  new WeakMap<WebAssembly.Instance, RawInstanceGateRecord>();
const scopedInstances =
  new WeakMap<WebAssembly.Instance, GatedInstanceRecord>();
const voidIngressScopes =
  new WeakMap<KernelVoidIngressScope, VoidIngressScopeRecord>();
const exactKernelEntryGates = new WeakSet<KernelEntryGate>();
// WHY: a public property, exported class, or global symbol would let ordinary
// host/backend failures impersonate a poisoned Wasm generation. Identity in
// this module-private set is granted only while normalizing an actual kernel
// export exception.
const kernelExportFailures = new WeakSet<object>();

/** Whether `value` is the normalized failure of an actual kernel export. */
export function isKernelExportFailure(value: unknown): value is Error {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return intrinsicApply(
    intrinsicWeakSetHas,
    kernelExportFailures,
    [value],
  );
}

/**
 * @internal Scratch leases use this only after validating and converting all
 * caller-controlled arguments. Ordinary host call sites must use the scoped
 * instance façade, whose wrapper evaluates arguments before entering here.
 */
export function invokeKernelEntryScopedOperation<T>(
  scope: KernelVoidIngressScope,
  expectedInstance: WebAssembly.Instance,
  operation: () => T,
): T {
  const scopeRecord = intrinsicApply(
    intrinsicWeakMapGet,
    voidIngressScopes,
    [scope],
  ) as VoidIngressScopeRecord | undefined;
  if (scopeRecord === undefined) {
    throw new IntrinsicError("unknown kernel void-ingress scope");
  }
  const instanceRecord = intrinsicApply(
    intrinsicWeakMapGet,
    gatedInstances,
    [expectedInstance],
  ) as GatedInstanceRecord | undefined;
  if (
    instanceRecord === undefined
    || scopeRecord.gate !== instanceRecord.gate
  ) {
    throw new IntrinsicError(
      "kernel void-ingress scope does not own the supplied operation",
    );
  }
  return scopeRecord.invoke(operation);
}

/**
 * Run one synchronous host capability call while an exact void-ingress scope
 * remains the serialization owner.
 *
 * This is narrower than an export permit: it cannot enter Wasm, register
 * effects, nest another host operation, or outlive the lexical scope. Public
 * void ingress reached by the host callback remains queued behind the current
 * record, and result-bearing ingress fails synchronously. Callers must stage
 * backend results in host-owned values and commit only after this returns.
 */
export function invokeKernelEntrySerializedHostOperation<T>(
  scope: KernelVoidIngressScope,
  operation: () => T,
): T {
  const scopeRecord = intrinsicApply(
    intrinsicWeakMapGet,
    voidIngressScopes,
    [scope],
  ) as VoidIngressScopeRecord | undefined;
  if (scopeRecord === undefined) {
    throw new IntrinsicError("unknown kernel void-ingress scope");
  }
  if (typeof operation !== "function") {
    throw new IntrinsicError(
      "serialized kernel host operation must be callable",
    );
  }
  return scopeRecord.invokeSerializedHostOperation(operation);
}

function normalizeCaughtFailure(message: string, cause: unknown): Error {
  const error = new IntrinsicError(message);
  // WHY: even `instanceof Error` consults mutable userland hooks. Always make
  // a fresh intrinsic Error and preserve the original thrown value as an own
  // data property without coercing or otherwise invoking attacker code.
  intrinsicObjectDefineProperty(error, "cause", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: cause,
  });
  return error;
}

export class KernelReentrantEntryError extends IntrinsicError {
  declare readonly exportName: string;
  declare readonly activeExportName?: string;

  constructor(
    exportName: string,
    activeExportName?: string,
  ) {
    super(
      `kernel export ${exportName} cannot run while ` +
        `${activeExportName ?? "another kernel export"} is active`,
    );
    // WHY: Error.prototype is mutable. Parameter-property assignments and
    // `this.name = ...` can invoke hostile inherited setters while this class
    // is enforcing the entry guard.
    intrinsicObjectDefineProperty(this, "exportName", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: exportName,
    });
    intrinsicObjectDefineProperty(this, "activeExportName", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: activeExportName,
    });
    intrinsicObjectDefineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "KernelReentrantEntryError",
    });
  }
}

/**
 * The capability held by one kernel worker for one kernel Wasm generation.
 *
 * Result-bearing reverse calls fail synchronously: their caller cannot be
 * told a truthful result before the active Rust operation finishes. Every
 * queued operation uses `runOrDeferVoidIngress` and an explicit scope token.
 */
export class KernelEntryGate {
  #activeExportName: string | null = null;
  #fatalError: Error | null = null;
  #deferred = intrinsicObjectSetPrototypeOf(
    [],
    null,
  ) as DeferredKernelEntry[];
  #deferredKeys = new IntrinsicSet<object>();
  #drainScheduled = false;
  #draining = false;
  #activeVoidIngressLabel: string | null = null;
  #activeVoidIngressToken: object | null = null;
  #activeHostOperationLabel: string | null = null;
  #scopedExportPermit: object | null = null;
  #runningDetachedPost = false;
  #runningProtocolTransactionStart = false;
  #pendingProtocolTransactionStarts = 0;
  #pendingFatalReport: Error | null = null;
  #onFatal: ((error: Error) => void) | undefined;

  constructor(
    onFatal?: (error: Error) => void,
  ) {
    if (new.target !== KernelEntryGate) {
      throw new IntrinsicError(
        "KernelEntryGate does not permit subclass dispatch overrides",
      );
    }
    intrinsicApply(intrinsicWeakSetAdd, exactKernelEntryGates, [this]);
    this.#onFatal = onFatal;
    // Private fields remain mutable on a frozen object. Freezing only removes
    // the public own-property surface that an observer could otherwise use to
    // shadow runOrDeferVoidIngress, fail, or the defer-state getter.
    intrinsicObjectFreeze(this);
  }

  /** @internal Install the owning worker's fatal-error sink exactly once. */
  setFatalHandler(handler: (error: Error) => void): void {
    if (this.#onFatal !== undefined) {
      throw new IntrinsicError(
        "kernel entry gate already has a failure handler",
      );
    }
    this.#onFatal = handler;
  }

  /** Whether a reviewed multi-export void ingress needs an owned snapshot. */
  get shouldDeferVoidIngress(): boolean {
    return this.#shouldDeferVoidIngress();
  }

  #shouldDeferVoidIngress(): boolean {
    if (this.#runningProtocolTransactionStart) {
      // The transaction start itself may invoke reviewed public worker roots.
      // Those roots receive a wholly fresh scope and are part of this ordered
      // start record, so they run before unrelated ingress already in the FIFO.
      // A detached effect produced by one of those roots must still queue:
      // running another root synchronously there would nest detached phases
      // and either expose partial publication or poison the generation.
      return this.#fatalError !== null
        || this.#activeExportName !== null
        || this.#activeVoidIngressLabel !== null
        || this.#activeHostOperationLabel !== null
        || this.#runningDetachedPost;
    }
    return this.#fatalError !== null
      || this.#activeExportName !== null
      || this.#activeVoidIngressLabel !== null
      || this.#activeHostOperationLabel !== null
      || this.#runningDetachedPost
      || this.#pendingProtocolTransactionStarts > 0
      || this.#draining
      || this.#drainScheduled
      || this.#deferred.length > 0;
  }

  #acceptSynchronousHostOperationResult<T>(
    label: string,
    result: T,
  ): T {
    if (
      result !== null
      && (typeof result === "object" || typeof result === "function")
      && typeof intrinsicReflectGet(
        result,
        "then",
        result,
      ) === "function"
    ) {
      const error = new IntrinsicError(
        `serialized kernel host operation ${label} returned a Promise or thenable`,
      );
      // WHY: the asynchronous continuation already exists and cannot be
      // cancelled here. Releasing this marker for later kernel ingress would
      // let that continuation overlap the host snapshot it was supposed to
      // finish synchronously, so this is a coherence failure rather than an
      // ordinary backend exception.
      if (this.#fail(error)) this.#pendingFatalReport = error;
      throw error;
    }
    return result;
  }

  invokeKernelExport<T>(name: string, operation: () => T): T {
    if (this.#fatalError !== null) throw this.#fatalError;
    if (
      this.#activeExportName !== null
      || this.#activeHostOperationLabel !== null
    ) {
      throw new KernelReentrantEntryError(
        name,
        this.#activeExportName ?? this.#activeHostOperationLabel ?? undefined,
      );
    }
    let scopedExportAuthorized = false;
    if (this.#activeVoidIngressToken !== null) {
      if (this.#scopedExportPermit !== this.#activeVoidIngressToken) {
        throw new KernelReentrantEntryError(
          name,
          this.#activeVoidIngressLabel ?? "scoped void ingress",
        );
      }
      // WHY: consume before entering Wasm. Any host import reached by this
      // export observes #activeExportName, and code invoked after it returns
      // cannot reuse the one-shot token for another export.
      this.#scopedExportPermit = null;
      scopedExportAuthorized = true;
    }
    if (
      !scopedExportAuthorized
      && (
        this.#draining
        || this.#runningDetachedPost
        || this.#runningProtocolTransactionStart
        || this.#drainScheduled
        || this.#deferred.length > 0
      )
    ) {
      // WHY: a generic FIFO callback is host-only and receives zero implicit
      // export authority. Otherwise an observer or other callback reached
      // before the intended export could steal that ambient permit and
      // overtake older ingress. Wasm-bearing operations must present the
      // exact token issued by runOrDeferVoidIngress.
      throw new KernelReentrantEntryError(
        name,
        this.#runningDetachedPost || this.#runningProtocolTransactionStart
          ? "detached host phase"
          : "queued kernel ingress",
      );
    }
    this.#activeExportName = name;
    try {
      return operation();
    } catch (cause) {
      const error = normalizeCaughtFailure(
        `kernel export ${name} failed`,
        cause,
      );
      intrinsicApply(intrinsicWeakSetAdd, kernelExportFailures, [error]);
      // WHY: an exception can unwind through Rust after arbitrary mutation.
      // No caller can prove that global kernel state is reusable, so queued
      // work must be discarded before this export releases the entry.
      if (this.#fail(error)) {
        this.#pendingFatalReport = error;
      }
      throw error;
    } finally {
      this.#activeExportName = null;
      // WHY: the fatal observer may attempt ordinary worker teardown or a
      // fresh ingress. Report only after the exact export authority is gone;
      // it must observe the latched generation, never the active Rust scope.
      this.#reportPendingFatalIfRevoked();
      // WHY: waiting for a microtask lets the outer lease copy its result,
      // revoke its host view, cancel the Rust reservation, and restore the
      // selected pid before any queued entry can observe that transaction.
      this.#scheduleDrain();
    }
  }

  /**
   * Serialize one synchronous host-only operation while the gate is idle.
   *
   * Unlike a void ingress scope, this grants no Wasm or detached-effect
   * authority. A reentrant void ingress joins the FIFO; result-bearing/export
   * entry and a nested host operation fail synchronously. Backend exceptions
   * propagate without poisoning the kernel because no Wasm mutation was
   * active, and the marker is always released before queued work can drain.
   *
   * @internal Shared-mapping host-only cleanup uses this when no lexical
   * KernelVoidIngressScope exists.
   */
  runSerializedHostOperation<T>(
    label: string,
    operation: () => T,
  ): T {
    if (this.#fatalError !== null) throw this.#fatalError;
    if (typeof operation !== "function") {
      throw new IntrinsicError(
        "serialized kernel host operation must be callable",
      );
    }
    if (this.#shouldDeferVoidIngress()) {
      throw new KernelReentrantEntryError(
        label,
        this.#activeExportName
          ?? this.#activeVoidIngressLabel
          ?? this.#activeHostOperationLabel
          ?? "active or queued kernel entry",
      );
    }
    this.#activeHostOperationLabel = label;
    try {
      return this.#acceptSynchronousHostOperationResult(
        label,
        operation(),
      );
    } finally {
      this.#activeHostOperationLabel = null;
      this.#reportPendingFatalIfRevoked();
      this.#scheduleDrain();
    }
  }

  /**
   * Run one synchronous void ingress only when the gate is completely idle.
   *
   * Unlike `runOrDeferVoidIngress`, this method never retains `operation`.
   * Immediate-result and fault-injection seams use it when their arguments are
   * caller-owned and cannot truthfully be snapshotted for later execution.
   * A busy gate rejects before invoking or enqueueing the callback.
   *
   * @internal
   */
  runImmediateVoidIngress(
    label: string,
    operation: (
      scope: KernelVoidIngressScope,
      effects: KernelEntryEffectRegistrar,
    ) => undefined,
  ): void {
    if (typeof label !== "string") {
      throw new IntrinsicError(
        "immediate kernel void-ingress label must be a primitive string",
      );
    }
    if (typeof operation !== "function") {
      throw new IntrinsicError(
        "immediate kernel void-ingress operation must be callable",
      );
    }
    if (this.#fatalError !== null) throw this.#fatalError;
    if (
      this.#runningProtocolTransactionStart
      || this.#shouldDeferVoidIngress()
    ) {
      throw new KernelReentrantEntryError(
        label,
        this.#activeExportName
          ?? this.#activeVoidIngressLabel
          ?? this.#activeHostOperationLabel
          ?? (
            this.#runningProtocolTransactionStart
              ? "protocol transaction start"
              : "active or queued kernel entry"
          ),
      );
    }
    const effects = this.#runVoidIngress(label, operation);
    this.#runDetachedEffects(label, effects);
  }

  /**
   * Run one reviewed synchronous void-ingress operation, or append it to the
   * ingress FIFO when the kernel entry is already owned.
   *
   * This grants the selected operation authority for multiple sequential
   * exports. Keep the callback narrowly scoped to the reviewed export
   * sequence: it must not invoke user callbacks or retain authority across a
   * Promise. The gate-bound registrar records ordered work that runs only
   * after scope revocation. The return value is true when the operation was
   * queued or discarded after a fatal latch, and false when it completed
   * synchronously.
   */
  runOrDeferVoidIngress(
    label: string,
    operation: (
      scope: KernelVoidIngressScope,
      effects: KernelEntryEffectRegistrar,
    ) => undefined,
    dedupeKey?: object,
  ): boolean {
    if (this.#fatalError !== null) return true;
    if (this.#shouldDeferVoidIngress()) {
      if (
        dedupeKey !== undefined
        && intrinsicApply(
          intrinsicSetHas,
          this.#deferredKeys,
          [dedupeKey],
        )
      ) {
        return true;
      }
      if (dedupeKey !== undefined) {
        intrinsicApply(intrinsicSetAdd, this.#deferredKeys, [dedupeKey]);
      }
      intrinsicApply(
        intrinsicArrayPush,
        this.#deferred,
        [{
          kind: "void-ingress",
          label,
          operation,
          dedupeKey,
        }],
      );
      return true;
    }
    const effects = this.#runVoidIngress(label, operation);
    this.#runDetachedEffects(label, effects);
    return false;
  }

  #runDetachedEffects(
    label: string,
    effects: KernelDetachedEffect[],
  ): void {
    if (this.#runningDetachedPost) {
      throw new KernelReentrantEntryError(
        "detached host phase",
        "another detached host phase",
      );
    }
    this.#runningDetachedPost = true;
    try {
      const effectCount = effects.length;
      for (let index = 0; index < effectCount; index++) {
        // An earlier observer may intentionally retire this generation through
        // the owning worker without throwing. A fatal latch revokes every
        // remaining effect, including protocol publication that would
        // otherwise make incoherent state externally visible.
        if (this.#fatalError !== null) return;
        const effect = effects[index]!;
        if (effect.kind === "protocol-transaction-start") {
          if (index !== effectCount - 1) {
            const error = new IntrinsicError(
              "protocol transaction start must be the final detached effect",
            );
            if (this.#fail(error)) this.#pendingFatalReport = error;
            throw error;
          }
          this.#pendingProtocolTransactionStarts++;
          try {
            intrinsicQueueMicrotask(() => {
              this.#runProtocolTransactionStart(
                label,
                index,
                effect.operation,
              );
            });
          } catch (cause) {
            this.#pendingProtocolTransactionStarts--;
            throw cause;
          }
          continue;
        }
        try {
          const result: unknown = effect.operation();
          // Runtime defense in depth: do not inspect a user-controlled
          // thenable. Any non-undefined return released this synchronous
          // boundary early and is therefore a contract failure.
          if (result !== undefined) {
            throw new IntrinsicError(
              `${effect.kind} effect ${index} returned a value`,
            );
          }
        } catch (cause) {
          if (effect.kind === "observer") {
            this.#reportDetachedFailure(label, cause);
            if (this.#fatalError !== null) return;
            continue;
          }
          if (this.#fatalError !== null) throw this.#fatalError;
          const error = normalizeCaughtFailure(
            `kernel protocol effect ${index} for ${label} failed`,
            cause,
          );
          if (this.#fail(error)) {
            // Latch and discard queued ingress before invoking the worker's
            // potentially compromised fatal observer.
            this.#pendingFatalReport = error;
          }
          throw error;
        }
        if (this.#fatalError !== null) return;
      }
    } finally {
      this.#runningDetachedPost = false;
      this.#reportPendingFatalIfRevoked();
      // A public ingress reached by an observer joins the FIFO. The scoped
      // phase may have had no queued work when it released its token, so the
      // detached barrier itself must arrange the later drain.
      this.#scheduleDrain();
    }
  }

  #runProtocolTransactionStart(
    label: string,
    index: number,
    operation: () => undefined,
  ): void {
    this.#pendingProtocolTransactionStarts--;
    if (this.#fatalError !== null) return;
    this.#runningProtocolTransactionStart = true;
    try {
      const result: unknown = operation();
      if (result !== undefined) {
        throw new IntrinsicError(
          `protocol transaction start ${index} for ${label} returned a value`,
        );
      }
    } catch (cause) {
      if (this.#fatalError !== null) return;
      const error = normalizeCaughtFailure(
        `protocol transaction start ${index} for ${label} failed`,
        cause,
      );
      if (this.#fail(error)) this.#pendingFatalReport = error;
    } finally {
      this.#runningProtocolTransactionStart = false;
      this.#reportPendingFatalIfRevoked();
      this.#scheduleDrain();
    }
  }

  #runVoidIngress(
    label: string,
    operation: (
      scope: KernelVoidIngressScope,
      effects: KernelEntryEffectRegistrar,
    ) => undefined,
  ): KernelDetachedEffect[] {
    if (this.#fatalError !== null) throw this.#fatalError;
    if (
      this.#activeExportName !== null
      || this.#activeVoidIngressLabel !== null
      || this.#activeHostOperationLabel !== null
    ) {
      throw new KernelReentrantEntryError(
        label,
        this.#activeExportName
          ?? this.#activeVoidIngressLabel
          ?? this.#activeHostOperationLabel
          ?? "kernel cleanup",
      );
    }
    const token = intrinsicObjectCreate(null) as object;
    const scope = intrinsicObjectCreate(null) as KernelVoidIngressScope;
    const detachedEffects = intrinsicObjectSetPrototypeOf(
      [],
      null,
    ) as KernelDetachedEffect[];
    let acceptingEffects = true;
    let runningSerializedHostOperation = false;
    intrinsicObjectDefineProperty(scope, kernelVoidIngressScopeBrand, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    });
    const invoke = <T>(invokeOperation: () => T): T => {
        if (
          this.#activeVoidIngressToken !== token
          || this.#activeVoidIngressLabel === null
        ) {
          throw new IntrinsicError(
            `void kernel ingress ${label} scope is no longer active`,
          );
        }
        if (
          this.#activeExportName !== null
          || this.#scopedExportPermit !== null
          || runningSerializedHostOperation
        ) {
          throw new KernelReentrantEntryError(
            label,
            this.#activeExportName ?? "another scoped export",
          );
        }
        this.#scopedExportPermit = token;
        try {
          const result = invokeOperation();
          if (this.#scopedExportPermit === token) {
            throw new IntrinsicError(
              `void kernel ingress ${label} scope did not invoke an export`,
            );
          }
          return result;
        } finally {
          this.#scopedExportPermit = null;
        }
      };
    const invokeSerializedHostOperation = <T>(
      hostOperation: () => T,
    ): T => {
      if (
        this.#activeVoidIngressToken !== token
        || this.#activeVoidIngressLabel === null
      ) {
        throw new IntrinsicError(
          `void kernel ingress ${label} scope is no longer active`,
        );
      }
      if (
        this.#activeExportName !== null
        || this.#scopedExportPermit !== null
        || runningSerializedHostOperation
      ) {
        throw new KernelReentrantEntryError(
          "serialized host operation",
          this.#activeExportName
            ?? (
              runningSerializedHostOperation
                ? "another serialized host operation"
                : "another scoped export"
            ),
        );
      }
      runningSerializedHostOperation = true;
      try {
        return this.#acceptSynchronousHostOperationResult(
          label,
          hostOperation(),
        );
      } finally {
        runningSerializedHostOperation = false;
      }
    };
    intrinsicApply(
      intrinsicWeakMapSet,
      voidIngressScopes,
      [
        scope,
        {
          gate: this,
          invoke,
          invokeSerializedHostOperation,
        },
      ],
    );
    intrinsicObjectFreeze(scope);
    const registerEffect = (
      kind: KernelDetachedEffect["kind"],
      effectOperation: () => undefined,
    ): undefined => {
      if (
        !acceptingEffects
        || this.#activeVoidIngressToken !== token
        || this.#activeVoidIngressLabel === null
        || runningSerializedHostOperation
      ) {
        throw new IntrinsicError(
          `void kernel ingress ${label} effect registration is no longer active`,
        );
      }
      if (typeof effectOperation !== "function") {
        throw new IntrinsicError(
          `void kernel ingress ${label} effect must be callable`,
        );
      }
      intrinsicApply(
        intrinsicArrayPush,
        detachedEffects,
        [intrinsicObjectFreeze({ kind, operation: effectOperation })],
      );
      return undefined;
    };
    const effectRegistrar = intrinsicObjectFreeze({
      deferProtocolEffect: (effectOperation: () => undefined): undefined =>
        registerEffect("protocol", effectOperation),
      deferProtocolTransactionStart: (
        effectOperation: () => undefined,
      ): undefined =>
        registerEffect("protocol-transaction-start", effectOperation),
      deferObserverEffect: (effectOperation: () => undefined): undefined =>
        registerEffect("observer", effectOperation),
    });
    this.#activeVoidIngressLabel = label;
    this.#activeVoidIngressToken = token;
    try {
      const result: unknown = operation(scope, effectRegistrar);
      // WHY: a Promise would extend this authority beyond the synchronous
      // stack, while any other value indicates that a result-bearing boundary
      // was accidentally routed through a void-only API.
      if (result !== undefined) {
        throw new IntrinsicError(
          `void kernel ingress ${label} must return undefined synchronously`,
        );
      }
      if (this.#fatalError !== null) throw this.#fatalError;
      return detachedEffects;
    } catch (cause) {
      if (this.#fatalError !== null) throw this.#fatalError;
      const error = normalizeCaughtFailure(
        `void kernel ingress ${label} failed`,
        cause,
      );
      if (this.#fail(error)) {
        this.#pendingFatalReport = error;
      }
      throw error;
    } finally {
      acceptingEffects = false;
      this.#scopedExportPermit = null;
      this.#activeVoidIngressToken = null;
      this.#activeVoidIngressLabel = null;
      // WHY: no fatal observer receives a live scope token or registration
      // surface. Reentrant work sees only the already-latched generation.
      this.#reportPendingFatalIfRevoked();
      this.#scheduleDrain();
    }
  }

  /**
   * Poison this generation and discard work that can no longer be executed
   * against a coherent Rust state.
   */
  fail(error: Error): boolean {
    return this.#fail(error);
  }

  #fail(error: Error): boolean {
    if (this.#fatalError !== null) return false;
    this.#fatalError = error;
    this.#deferred.length = 0;
    intrinsicApply(intrinsicSetClear, this.#deferredKeys, []);
    return true;
  }

  #scheduleDrain(): void {
    if (
      this.#drainScheduled
      || this.#draining
      || this.#runningDetachedPost
      || this.#runningProtocolTransactionStart
      || this.#pendingProtocolTransactionStarts > 0
      || this.#fatalError !== null
      || this.#activeHostOperationLabel !== null
      || this.#deferred.length === 0
    ) {
      return;
    }
    this.#drainScheduled = true;
    intrinsicQueueMicrotask(() => {
      this.#drainScheduled = false;
      if (
        this.#fatalError !== null
        || this.#activeExportName !== null
        || this.#activeHostOperationLabel !== null
        || this.#runningProtocolTransactionStart
        || this.#pendingProtocolTransactionStarts > 0
      ) {
        return;
      }
      this.#draining = true;
      try {
        while (
          this.#deferred.length > 0
          && this.#fatalError === null
          && this.#pendingProtocolTransactionStarts === 0
        ) {
          const next = intrinsicApply(
            intrinsicArrayShift,
            this.#deferred,
            [],
          ) as DeferredKernelEntry;
          if (next.dedupeKey !== undefined) {
            intrinsicApply(
              intrinsicSetDelete,
              this.#deferredKeys,
              [next.dedupeKey],
            );
          }
          try {
            // WHY: only the callback selected from the FIFO may cross the
            // pending-ingress barrier, and it carries the sole export token.
            const effects = this.#runVoidIngress(
              next.label,
              next.operation,
            );
            this.#runDetachedEffects(next.label, effects);
          } catch (cause) {
            if (this.#fatalError !== null) continue;
            const error = normalizeCaughtFailure(
              `deferred kernel entry ${next.label} failed`,
              cause,
            );
            if (this.#fail(error)) {
              this.#pendingFatalReport = error;
            }
          } finally {
            // No authority-bearing state survives one selected FIFO record.
          }
        }
      } finally {
        this.#draining = false;
        this.#reportPendingFatalIfRevoked();
      }
    });
  }

  #reportPendingFatalIfRevoked(): void {
    const error = this.#pendingFatalReport;
    if (
      error === null
      || this.#activeExportName !== null
      || this.#activeVoidIngressToken !== null
      || this.#activeVoidIngressLabel !== null
      || this.#activeHostOperationLabel !== null
      || this.#runningDetachedPost
      || this.#runningProtocolTransactionStart
      || this.#draining
    ) {
      return;
    }
    this.#pendingFatalReport = null;
    this.#reportFatal(error);
  }

  #reportFatal(error: Error): void {
    try {
      this.#onFatal?.(error);
    } catch {
      // The generation was already poisoned before the reporting callback.
      // Keep its original coherence failure authoritative.
      try {
        intrinsicApply(
          intrinsicConsoleError,
          console,
          ["[kernel-entry-gate] fatal-error handler failed"],
        );
      } catch {
        // Reporting is best-effort after the fatal latch. Never let a hostile
        // console implementation replace the authoritative coherence error.
      }
    }
  }

  #reportDetachedFailure(label: string, cause: unknown): void {
    try {
      intrinsicApply(
        intrinsicConsoleError,
        console,
        [
          `[kernel-entry-gate] detached host phase failed for ${label}`,
          cause,
        ],
      );
    } catch {
      // The scoped Wasm phase already completed coherently. Reporting a host
      // observer/backend failure must not replace that state or poison FIFO
      // work that never depended on the detached callback.
    }
  }
}

const intrinsicKernelEntryGateInvoke =
  KernelEntryGate.prototype.invokeKernelExport;
// WHY: every façade dispatches through this prototype. Freeze it before any
// caller can construct a gate so an observer cannot replace an entry-taking
// method for a later call.
intrinsicObjectFreeze(KernelEntryGate.prototype);
intrinsicObjectFreeze(KernelEntryGate);

function createFrozenKernelInstanceFacade(
  exports: WebAssembly.Exports,
): WebAssembly.Instance {
  // WHY: proxying a genuine instance makes every unhandled mutation trap act
  // on the authority-bearing target. A plain object with the nominal
  // prototype preserves `instanceof WebAssembly.Instance`, while the
  // intrinsic exports getter still rejects it as a non-genuine receiver.
  const facade = intrinsicObjectCreate(
    intrinsicWasmInstancePrototype,
  ) as WebAssembly.Instance;
  intrinsicObjectDefineProperty(facade, "exports", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: exports,
  });
  return intrinsicObjectFreeze(facade);
}

/**
 * Wrap all callable exports and omit every mutable exported Wasm object.
 *
 * The frozen façade remains `instanceof WebAssembly.Instance` for APIs that
 * use that nominal check. It contains no raw instance target, and the
 * intrinsic `Instance#exports` getter rejects the non-genuine receiver.
 */
export function createKernelEntryGatedInstance(
  rawInstance: WebAssembly.Instance,
  gate: KernelEntryGate,
): WebAssembly.Instance {
  if (
    !intrinsicApply(
      intrinsicWeakSetHas,
      exactKernelEntryGates,
      [gate],
    )
  ) {
    throw new IntrinsicError(
      "kernel entry façade requires an exact KernelEntryGate",
    );
  }
  const rawExports = intrinsicApply(
    intrinsicInstanceExports,
    rawInstance,
    [],
  ) as WebAssembly.Exports;
  const existing = intrinsicApply(
    intrinsicWeakMapGet,
    rawInstanceGates,
    [rawInstance],
  ) as RawInstanceGateRecord | undefined;
  if (existing !== undefined) {
    if (existing.gate !== gate) {
      // WHY: two independent gates around one raw instance would each think
      // it owns the sole entry permit. The second façade could therefore
      // re-enter Rust while the first gate still has an export active.
      throw new IntrinsicError(
        "kernel WebAssembly instance is already owned by another entry gate",
      );
    }
    return existing.facade;
  }

  const safeExports = intrinsicObjectCreate(null) as Record<string, Function>;
  const invoke = <T>(name: string, operation: () => T): T =>
    intrinsicApply(
      intrinsicKernelEntryGateInvoke,
      gate,
      [name, operation],
    ) as T;
  const exportEntries = intrinsicObjectEntries(rawExports);
  for (let index = 0; index < exportEntries.length; index++) {
    const entry = exportEntries[index]!;
    const name = entry[0];
    const value = entry[1];
    if (typeof value !== "function") continue;
    const wrapped = (...args: unknown[]): unknown =>
      invoke(
        name,
        () => intrinsicApply(value, undefined, args),
      );
    intrinsicObjectDefineProperty(safeExports, name, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: wrapped,
    });
  }
  intrinsicObjectFreeze(safeExports);

  const facade = createFrozenKernelInstanceFacade(safeExports);
  intrinsicApply(
    intrinsicWeakMapSet,
    gatedInstances,
    [
      facade,
      {
        rawInstance,
        gate,
      },
    ],
  );
  intrinsicApply(
    intrinsicWeakMapSet,
    rawInstanceGates,
    [rawInstance, intrinsicObjectFreeze({ gate, facade })],
  );
  return facade;
}

/**
 * @internal Return only exports proven to belong to a genuine raw instance or
 * an exact registered gated façade.
 */
export function validatedKernelEntryExports(
  instance: WebAssembly.Instance,
): WebAssembly.Exports {
  const gatedRecord = intrinsicApply(
    intrinsicWeakMapGet,
    gatedInstances,
    [instance],
  ) as GatedInstanceRecord | undefined;
  if (gatedRecord !== undefined) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(
      instance,
      "exports",
    );
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.value === undefined
    ) {
      throw new IntrinsicError(
        "registered gated kernel instance lost its frozen exports façade",
      );
    }
    return descriptor.value as WebAssembly.Exports;
  }
  if (
    intrinsicApply(
      intrinsicWeakMapGet,
      scopedInstances,
      [instance],
    ) !== undefined
  ) {
    throw new IntrinsicError(
      "scoped kernel entry exports cannot escape their ingress",
    );
  }
  // The captured intrinsic getter rejects structural nominal objects and
  // Proxy-wrapped instances because neither carries the exact engine slots.
  return intrinsicApply(
    intrinsicInstanceExports,
    instance,
    [],
  ) as WebAssembly.Exports;
}

export type KernelHostAdapterManifestScalarExport =
  | "kernel_host_adapter_manifest_ptr"
  | "kernel_host_adapter_manifest_len";

/**
 * Read one exact host-adapter manifest scalar without returning a callable or
 * an exports object.
 *
 * This is the narrow inspection boundary used while initialization owns a
 * scoped entry instance. The ordinary validator above intentionally rejects
 * that instance because its authority-bearing namespace must not escape.
 * Keep the runtime name check as well as the TypeScript union: an erased or
 * untyped caller must not turn manifest inspection into generic export-entry
 * authority. The wrapper is obtained, called, and discarded synchronously;
 * the scope still revokes it when the ingress ends.
 */
export function readValidatedKernelHostAdapterManifestScalar(
  instance: WebAssembly.Instance,
  exportName: KernelHostAdapterManifestScalarExport,
): number | bigint {
  if (
    exportName !== "kernel_host_adapter_manifest_ptr"
    && exportName !== "kernel_host_adapter_manifest_len"
  ) {
    throw new IntrinsicError(
      "kernel export is not a host-adapter manifest scalar",
    );
  }
  let exports: WebAssembly.Exports;
  if (
    intrinsicApply(
      intrinsicWeakMapGet,
      scopedInstances,
      [instance],
    ) !== undefined
  ) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(
      instance,
      "exports",
    );
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.value === undefined
    ) {
      throw new IntrinsicError(
        "registered scoped kernel instance lost its exports façade",
      );
    }
    exports = descriptor.value as WebAssembly.Exports;
  } else {
    exports = validatedKernelEntryExports(instance);
  }
  const value = intrinsicReflectGet(exports, exportName, exports);
  if (typeof value !== "function") {
    throw new IntrinsicError(
      `kernel export ${exportName} is unavailable`,
    );
  }
  const result = intrinsicApply(value, undefined, []);
  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new IntrinsicError(
      `kernel export ${exportName} did not return a Wasm scalar`,
    );
  }
  return result;
}

/** Return function presence without exposing the function itself. */
export function hasValidatedKernelEntryExport(
  instance: WebAssembly.Instance,
  exportName: string,
): boolean {
  if (typeof exportName !== "string") {
    throw new IntrinsicError(
      "kernel entry export name must be a primitive string",
    );
  }
  if (
    intrinsicApply(
      intrinsicWeakMapGet,
      scopedInstances,
      [instance],
    ) !== undefined
  ) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(
      instance,
      "exports",
    );
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.value === undefined
    ) {
      throw new IntrinsicError(
        "registered scoped kernel instance lost its exports façade",
      );
    }
    const exports = descriptor.value as WebAssembly.Exports;
    return typeof intrinsicReflectGet(
      exports,
      exportName,
      exports,
    ) === "function";
  }
  return typeof validatedKernelEntryExports(instance)[exportName]
    === "function";
}

/**
 * Bind one gated instance to an explicit void-ingress capability.
 *
 * Only code that receives this façade can make scoped exports. The ordinary
 * façade remains blocked for callbacks that run between reviewed exports.
 */
export function createKernelEntryScopedInstance(
  instance: WebAssembly.Instance,
  scope: KernelVoidIngressScope,
): WebAssembly.Instance {
  const record = intrinsicApply(
    intrinsicWeakMapGet,
    gatedInstances,
    [instance],
  ) as GatedInstanceRecord | undefined;
  if (record === undefined) {
    throw new IntrinsicError(
      "scoped kernel entry requires a registered gated instance",
    );
  }
  const scopeRecord = intrinsicApply(
    intrinsicWeakMapGet,
    voidIngressScopes,
    [scope],
  ) as VoidIngressScopeRecord | undefined;
  if (scopeRecord === undefined) {
    throw new IntrinsicError(
      "scoped kernel entry requires a registered void-ingress scope",
    );
  }
  if (scopeRecord.gate !== record.gate) {
    throw new IntrinsicError(
      "scoped kernel entry gate does not own the supplied scope",
    );
  }
  const gatedExports = intrinsicReflectGet(
    instance,
    "exports",
    instance,
  ) as WebAssembly.Exports;
  const scopedExportCache = intrinsicObjectCreate(null) as Record<
    string,
    Function
  >;
  const scopedExportsTarget = intrinsicObjectFreeze(
    intrinsicObjectCreate(null) as object,
  );
  const invoke = scopeRecord.invoke;
  // WHY: the kernel currently has hundreds of callable exports. Materializing
  // a wrapper for every one on every syscall would turn an authority check
  // into hundreds of hot-path allocations. Lazily cache only the handful this
  // exact ingress actually requests; the underlying gated namespace exposes
  // no Memory or other mutable Wasm object.
  const scopedExports = new IntrinsicProxy(scopedExportsTarget, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const cached = intrinsicObjectGetOwnPropertyDescriptor(
        scopedExportCache,
        property,
      )?.value as Function | undefined;
      if (cached !== undefined) return cached;
      const gatedValue = intrinsicReflectGet(
        gatedExports,
        property,
        gatedExports,
      );
      if (typeof gatedValue !== "function") return undefined;
      const wrapped = (...args: unknown[]): unknown =>
        intrinsicApply(
          invoke,
          undefined,
          [() => intrinsicApply(gatedValue, undefined, args)],
        );
      intrinsicObjectDefineProperty(scopedExportCache, property, {
        enumerable: true,
        configurable: false,
        writable: false,
        value: wrapped,
      });
      return wrapped;
    },
  }) as WebAssembly.Exports;
  const facade = createFrozenKernelInstanceFacade(scopedExports);
  intrinsicApply(
    intrinsicWeakMapSet,
    scopedInstances,
    [facade, record],
  );
  return facade;
}

function rawKernelEntryExports(
  instance: WebAssembly.Instance,
): WebAssembly.Exports {
  if (
    intrinsicApply(
      intrinsicWeakMapGet,
      scopedInstances,
      [instance],
    ) !== undefined
  ) {
    throw new IntrinsicError(
      "scoped kernel entry instances cannot bind allocator ownership",
    );
  }
  const record = (
    intrinsicApply(
      intrinsicWeakMapGet,
      gatedInstances,
      [instance],
    ) as GatedInstanceRecord | undefined
  );
  const rawInstance = record?.rawInstance ?? instance;
  // Reject a prototype-forged nominal object and a Proxy around a genuine
  // instance. Only the intrinsic getter can prove the exact receiver carries
  // the engine's internal WebAssembly.Instance slots.
  return intrinsicApply(
    intrinsicInstanceExports,
    rawInstance,
    [],
  ) as WebAssembly.Exports;
}

/**
 * Safe binding metadata for one callable export. The callable is the exact
 * already-visible gated wrapper (or the raw callable only when the supplied
 * instance itself is a genuine ungated instance); raw instance/function
 * authority is never returned from a registered façade.
 */
export interface ValidatedKernelEntryCallable {
  readonly call: Function;
  readonly argumentCount: number;
}

/** @internal Prove exact instance/Memory ownership without returning either raw receiver. */
export function validateKernelEntryMemoryOwnership(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
): void {
  const scopedRecord = intrinsicApply(
    intrinsicWeakMapGet,
    scopedInstances,
    [instance],
  ) as GatedInstanceRecord | undefined;
  const exports = scopedRecord === undefined
    ? rawKernelEntryExports(instance)
    : intrinsicApply(
      intrinsicInstanceExports,
      scopedRecord.rawInstance,
      [],
    ) as WebAssembly.Exports;
  if (exports.memory !== memory) {
    throw new IntrinsicError(
      "kernel entry instance does not own the supplied WebAssembly.Memory",
    );
  }
}

/** @internal Snapshot one safe callable plus its genuine Wasm arity. */
export function validatedKernelEntryCallable(
  instance: WebAssembly.Instance,
  name: string,
): ValidatedKernelEntryCallable | undefined {
  if (typeof name !== "string") {
    throw new IntrinsicError(
      "kernel entry callable name must be a primitive string",
    );
  }
  const rawValue = rawKernelEntryExports(instance)[name];
  if (typeof rawValue !== "function") return undefined;
  const callable = validatedKernelEntryExports(instance)[name];
  if (typeof callable !== "function") {
    throw new IntrinsicError(
      `registered kernel entry export ${name} lost its callable façade`,
    );
  }
  const lengthDescriptor =
    intrinsicObjectGetOwnPropertyDescriptor(rawValue, "length");
  const argumentCount = lengthDescriptor?.value;
  if (
    typeof argumentCount !== "number"
    || !intrinsicNumberIsSafeInteger(argumentCount)
    || argumentCount < 0
  ) {
    throw new IntrinsicError(
      `kernel entry export ${name} has an invalid Wasm arity`,
    );
  }
  return intrinsicObjectFreeze({ call: callable, argumentCount });
}

/**
 * Prove that a callable selected from a short-lived scoped façade belongs to
 * the same generation as a persistent allocation owner.
 *
 * No gate, raw instance, exports namespace, or replacement callable is
 * returned. Scratch allocation uses this only to bind a scoped allocator call
 * to the persistent instance that will own the resulting region.
 */
export function validateKernelScratchAllocatorOwnership(
  ownerInstance: WebAssembly.Instance,
  callableInstance: WebAssembly.Instance,
  callable: Function,
): void {
  const name = "kernel_alloc_scratch";
  if (ownerInstance === callableInstance) {
    if (validatedKernelEntryCallable(ownerInstance, name)?.call !== callable) {
      throw new IntrinsicError(
        `kernel entry callable ${name} does not belong to its owner`,
      );
    }
    return;
  }
  const ownerRecord = intrinsicApply(
    intrinsicWeakMapGet,
    gatedInstances,
    [ownerInstance],
  ) as GatedInstanceRecord | undefined;
  const callableRecord = intrinsicApply(
    intrinsicWeakMapGet,
    scopedInstances,
    [callableInstance],
  ) as GatedInstanceRecord | undefined;
  if (
    ownerRecord === undefined
    || callableRecord === undefined
    || ownerRecord !== callableRecord
  ) {
    throw new IntrinsicError(
      `kernel entry callable ${name} belongs to another generation`,
    );
  }
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(
    callableInstance,
    "exports",
  );
  if (
    descriptor === undefined
    || descriptor.get !== undefined
    || descriptor.value === undefined
  ) {
    throw new IntrinsicError(
      "registered scoped kernel instance lost its exports façade",
    );
  }
  const scopedExports = descriptor.value as WebAssembly.Exports;
  if (
    intrinsicReflectGet(scopedExports, name, scopedExports) !== callable
  ) {
    throw new IntrinsicError(
      `kernel entry callable ${name} is not the scoped export`,
    );
  }
}

/**
 * @internal Prove that an instance is the exact immutable façade registered
 * for one kernel entry generation. This returns no gate or invocation
 * capability.
 */
export function validateKernelEntryGatedInstance(
  instance: WebAssembly.Instance,
): void {
  if (
    intrinsicApply(
      intrinsicWeakMapGet,
      gatedInstances,
      [instance],
    ) === undefined
  ) {
    throw new IntrinsicError(
      "kernel instance is not a registered entry-gated façade",
    );
  }
  validatedKernelEntryExports(instance);
}

/**
 * @internal Test initialization may supply a gate it already owns. Validate
 * that candidate without returning the registered generation's authority.
 */
export function validateKernelEntryGateOwnership(
  instance: WebAssembly.Instance,
  gate: KernelEntryGate,
): void {
  const record = (
    intrinsicApply(
      intrinsicWeakMapGet,
      gatedInstances,
      [instance],
    ) as GatedInstanceRecord | undefined
  );
  if (
    record === undefined
    || record.gate !== gate
    || !intrinsicApply(
      intrinsicWeakSetHas,
      exactKernelEntryGates,
      [gate],
    )
  ) {
    throw new IntrinsicError(
      "kernel entry gate does not own the supplied instance",
    );
  }
  validatedKernelEntryExports(instance);
}
