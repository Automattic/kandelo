import {
  readWasmFunctionImports,
  type WasmFunctionImportType,
  type WasmFunctionSignature,
  type WasmValueType,
} from "./constants";
import {
  createForkExternrefImportMailbox,
  type ForkExternrefImportAuthority,
  type ForkExternrefImportBinding,
  type ForkExternrefImportDescriptor,
  type ForkExternrefImportHandler,
  ForkExternrefImportOwnerCatalog,
  ForkExternrefImportOwnerEndpoint,
  type ForkExternrefImportWake,
  ForkExternrefImportWorkerCaller,
} from "./fork-externref-import-mailbox";
import {
  FORK_WORKER_EXCEPTION_RESERVED_ORDINAL_START,
  ForkWorkerExceptionCapabilityOwner,
  ForkWorkerLocalImportExceptionNormalizer,
  type ForkWorkerLocalImportExceptionNormalizerOptions,
} from "./fork-worker-import-exceptions";
import {
  ForkExternrefTokenCache,
} from "./fork-reference-broker";

export interface ForkOwnerImportWireRegistration {
  readonly module: string;
  readonly name: string;
  readonly descriptor: ForkExternrefImportDescriptor;
}

export interface ForkHostImportWorkerInit {
  readonly mailbox: SharedArrayBuffer;
  readonly senderId: number;
  readonly ownerImports: readonly ForkOwnerImportWireRegistration[];
}

export interface ForkHostImportOwnerWorkerOptions {
  readonly pid: number;
  readonly generationId: number;
  /**
   * Must compare the exact live Worker object/generation held by the host
   * entrypoint. Numeric wake fields are never sufficient authorization.
   */
  readonly authorizeSender: (binding: ForkExternrefImportBinding) => void;
  readonly onDiagnostic?: (error: unknown) => void;
}

function importKey(module: string, name: string): string {
  return `${module.length}:${module}${name}`;
}

function validateImportName(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function freezeDescriptor(
  descriptor: ForkExternrefImportDescriptor,
): ForkExternrefImportDescriptor {
  return Object.freeze({
    version: descriptor.version,
    ordinal: descriptor.ordinal,
    params: Object.freeze([...descriptor.params]),
    results: Object.freeze([...descriptor.results]),
  });
}

function cloneWireRegistration(
  registration: ForkOwnerImportWireRegistration,
): ForkOwnerImportWireRegistration {
  return Object.freeze({
    module: registration.module,
    name: registration.name,
    descriptor: freezeDescriptor(registration.descriptor),
  });
}

function wasmTypeForMailbox(type: string): number {
  switch (type) {
    case "i32":
      return 0x7f;
    case "i64":
      return 0x7e;
    case "f32":
      return 0x7d;
    case "f64":
      return 0x7c;
    case "externref":
      return 0x6f;
    default:
      throw new Error(`unknown fork host-import mailbox type ${type}`);
  }
}

function isExternReferenceType(type: WasmValueType): boolean {
  return (
    type.code === 0x6f
    || type.code === 0x72
    || (
      (type.code === 0x62 || type.code === 0x63 || type.code === 0x64)
      && (type.heapType === -17 || type.heapType === -14)
    )
  );
}

/**
 * Vectors and exception/continuation references deliberately cannot enter a
 * JavaScript host function. They remain valid on a direct Wasm-to-Wasm import
 * and are reconstructed by the scalar frame, exception codec, or activation
 * codec respectively.
 */
function requiresDirectWasmBoundary(type: WasmValueType): boolean {
  if (
    type.code === 0x7b // v128
    || type.code === 0x69 // exnref
    || type.code === 0x74 // noexnref
    || type.code === 0x68 // contref
    || type.code === 0x75 // nocontref
  ) {
    return true;
  }
  return (
    (type.code === 0x62 || type.code === 0x63 || type.code === 0x64)
    && (
      type.heapType === -23 // exn
      || type.heapType === -12 // noexn
      || type.heapType === -24 // cont
      || type.heapType === -11 // nocont
    )
  );
}

function signatureRequiresDirectWasmBoundary(
  signature: WasmFunctionSignature,
): boolean {
  for (const type of signature.paramTypes) {
    if (requiresDirectWasmBoundary(type)) return true;
  }
  for (const type of signature.resultTypes) {
    if (requiresDirectWasmBoundary(type)) return true;
  }
  return false;
}

function signatureMatchesDescriptor(
  signature: WasmFunctionSignature,
  descriptor: ForkExternrefImportDescriptor,
): boolean {
  return (
    signature.params.length === descriptor.params.length
    && signature.results.length === descriptor.results.length
    && signature.params.every(
      (type, index) => {
        const expected = descriptor.params[index]!;
        return expected === "externref"
          ? isExternReferenceType(signature.paramTypes[index]!)
          : type === wasmTypeForMailbox(expected);
      },
    )
    && signature.results.every(
      (type, index) => {
        const expected = descriptor.results[index]!;
        return expected === "externref"
          ? isExternReferenceType(signature.resultTypes[index]!)
          : type === wasmTypeForMailbox(expected);
      },
    )
  );
}

function signatureText(signature: WasmFunctionSignature): string {
  const valueName = (value: WasmValueType): string => {
    switch (value.code) {
      case 0x7f:
        return "i32";
      case 0x7e:
        return "i64";
      case 0x7d:
        return "f32";
      case 0x7c:
        return "f64";
      case 0x6f:
        return "externref";
      case 0x70:
        return "funcref";
      case 0x6e:
        return "anyref";
      case 0x6d:
        return "eqref";
      case 0x6c:
        return "i31ref";
      case 0x6b:
        return "structref";
      case 0x6a:
        return "arrayref";
      case 0x69:
        return "exnref";
      case 0x68:
        return "contref";
      case 0x7b:
        return "v128";
      case 0x62:
      case 0x63:
      case 0x64:
        return `${value.code === 0x62 ? "exact" : "ref"}`
          + `${value.code === 0x63 ? " null" : ""}`
          + `${value.shared ? " shared" : ""} ${String(value.heapType)}`;
      default:
        return `0x${value.code.toString(16)}`;
    }
  };
  return `(${signature.paramTypes.map(valueName).join(",")}) -> (`
    + `${signature.resultTypes.map(valueName).join(",")})`;
}

/**
 * One owner-realm catalog shared by every process/pthread Worker.
 *
 * The catalog is sealed when the first Worker is created. This guarantees a
 * side module and the process main module see the same immutable routing
 * policy, while every Worker still gets a distinct mailbox/sender identity.
 */
export class ForkHostImportOwnerRuntime {
  private readonly catalog = new ForkExternrefImportOwnerCatalog();
  private readonly exceptionCapabilities =
    new ForkWorkerExceptionCapabilityOwner();
  private readonly registrations =
    new Map<string, ForkOwnerImportWireRegistration>();
  private nextSenderId = 1;
  private sealed = false;

  constructor(
    private readonly authority: ForkExternrefImportAuthority,
  ) {
    this.exceptionCapabilities.install(this.catalog);
  }

  register(
    module: string,
    name: string,
    descriptor: ForkExternrefImportDescriptor,
    handler: ForkExternrefImportHandler,
  ): void {
    if (this.sealed) {
      throw new Error(
        "fork owner host-import catalog is sealed by a live Worker",
      );
    }
    validateImportName(module, "fork owner import module");
    validateImportName(name, "fork owner import name");
    if (descriptor.ordinal >= FORK_WORKER_EXCEPTION_RESERVED_ORDINAL_START) {
      throw new RangeError(
        `fork owner import ordinal ${descriptor.ordinal} is reserved`,
      );
    }
    const key = importKey(module, name);
    if (this.registrations.has(key)) {
      throw new Error(`duplicate fork owner import ${module}.${name}`);
    }
    const registration = cloneWireRegistration({
      module,
      name,
      descriptor,
    });
    this.catalog.register(registration.descriptor, handler);
    this.registrations.set(key, registration);
  }

  createWorker(
    options: ForkHostImportOwnerWorkerOptions,
  ): ForkHostImportOwnerWorker {
    this.sealed = true;
    if (this.nextSenderId > 0xffff_ffff) {
      throw new RangeError("fork host-import sender id space exhausted");
    }
    const binding: ForkExternrefImportBinding = Object.freeze({
      pid: options.pid,
      generationId: options.generationId,
      senderId: this.nextSenderId++,
    });
    // WHY: the sealed catalog is the reconstruction owner for these imports.
    // Size one reusable mailbox from its widest exact signature so valid wide
    // imports need neither a continuation-frame field nor per-call buffers.
    const mailbox = createForkExternrefImportMailbox(
      this.catalog.mailboxCapacity,
    );
    const endpoint = new ForkExternrefImportOwnerEndpoint(
      mailbox,
      binding,
      this.catalog,
      this.authority,
      {
        authorizeSender: options.authorizeSender,
        onDiagnostic: (error) => options.onDiagnostic?.(error),
      },
    );
    return new ForkHostImportOwnerWorker(
      endpoint,
      this.exceptionCapabilities,
      Object.freeze(
        [...this.registrations.values()].map(cloneWireRegistration),
      ),
    );
  }
}

export class ForkHostImportOwnerWorker {
  readonly init: ForkHostImportWorkerInit;
  private closed = false;

  constructor(
    private readonly endpoint: ForkExternrefImportOwnerEndpoint,
    private readonly exceptionCapabilities:
      ForkWorkerExceptionCapabilityOwner,
    ownerImports: readonly ForkOwnerImportWireRegistration[],
  ) {
    this.init = Object.freeze({
      mailbox: endpoint.mailbox,
      senderId: endpoint.binding.senderId,
      ownerImports,
    });
  }

  get binding(): ForkExternrefImportBinding {
    return this.endpoint.binding;
  }

  dispatch(wake: ForkExternrefImportWake): boolean {
    if (this.closed) return false;
    // This method is called only by the listener attached to this exact Worker
    // object; pass that independently observed binding into the core endpoint.
    return this.endpoint.dispatch(wake, this.endpoint.binding);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.exceptionCapabilities.clearBinding(this.endpoint.binding);
    this.endpoint.close();
  }
}

/**
 * One Worker-side caller shared by its main module and every side module.
 */
export class ForkHostImportWorkerRuntime {
  readonly caller: ForkExternrefImportWorkerCaller;
  readonly localExceptions: ForkWorkerLocalImportExceptionNormalizer;
  private readonly ownerImports =
    new Map<string, ForkOwnerImportWireRegistration>();

  constructor(
    init: ForkHostImportWorkerInit,
    pid: number,
    generationId: number,
    tokens: ForkExternrefTokenCache,
    notifyOwner: (wake: ForkExternrefImportWake) => void,
    normalizerOptions:
      ForkWorkerLocalImportExceptionNormalizerOptions = {},
  ) {
    const binding: ForkExternrefImportBinding = {
      pid,
      generationId,
      senderId: init.senderId,
    };
    this.caller = new ForkExternrefImportWorkerCaller(
      init.mailbox,
      binding,
      tokens,
      notifyOwner,
    );
    this.localExceptions = new ForkWorkerLocalImportExceptionNormalizer(
      this.caller,
      tokens,
      normalizerOptions,
    );
    for (const raw of init.ownerImports) {
      validateImportName(raw.module, "fork owner import module");
      validateImportName(raw.name, "fork owner import name");
      const registration = cloneWireRegistration(raw);
      if (
        registration.descriptor.ordinal
          >= FORK_WORKER_EXCEPTION_RESERVED_ORDINAL_START
      ) {
        throw new Error(
          `fork owner import ${raw.module}.${raw.name} uses reserved ordinal `
          + `${registration.descriptor.ordinal}`,
        );
      }
      const key = importKey(raw.module, raw.name);
      if (this.ownerImports.has(key)) {
        throw new Error(`duplicate fork owner import ${raw.module}.${raw.name}`);
      }
      this.ownerImports.set(key, registration);
    }
  }

  /**
   * Select the owner RPC for a registered opaque-value import, otherwise wrap
   * the same-Worker intrinsic so nested Wasm traps retain trap semantics.
   * Ordinary thrown values remain exact until fork capture.
   */
  routeFunction(
    imported: WasmFunctionImportType,
    localImplementation: CallableFunction,
  ): CallableFunction {
    const owner = this.ownerImports.get(
      importKey(imported.module, imported.name),
    );
    if (owner) {
      if (!signatureMatchesDescriptor(imported.signature, owner.descriptor)) {
        throw new Error(
          `owner import ${imported.module}.${imported.name} descriptor does `
          + `not match artifact signature ${signatureText(imported.signature)}`,
        );
      }
      return this.caller.bind(owner.descriptor);
    }
    if (signatureRequiresDirectWasmBoundary(imported.signature)) {
      // WHY: wrapping creates a JavaScript host function. The JS embedding
      // rejects v128/exnref (and has no continuation-reference conversion),
      // while a direct imported Wasm function is valid and preserves its
      // instance-local typed value. Those values are captured by the typed
      // scalar/exception/module codec path, never by the externref mailbox.
      return localImplementation;
    }
    return this.localExceptions.wrap(
      imported.importOrdinal,
      localImplementation,
    );
  }

  /**
   * Parse the artifact once and route all function imports in a conventional
   * import object. Dynamic-linker Proxies can instead call routeFunction at
   * their final property-resolution boundary.
   */
  routeImportObject(
    programBytes: ArrayBuffer,
    imports: WebAssembly.Imports,
  ): WebAssembly.Imports {
    const grouped = new Map<string, WasmFunctionImportType[]>();
    for (const imported of readWasmFunctionImports(programBytes)) {
      const key = importKey(imported.module, imported.name);
      const entries = grouped.get(key) ?? [];
      entries.push(imported);
      grouped.set(key, entries);
    }

    const routed: WebAssembly.Imports = { ...imports };
    const modules = new Map<string, Record<string, WebAssembly.ImportValue>>();
    for (const entries of grouped.values()) {
      const imported = entries[0]!;
      const originalModule = imports[imported.module] as
        | Record<string, WebAssembly.ImportValue>
        | undefined;
      if (!originalModule) continue;
      let routedModule = modules.get(imported.module);
      if (!routedModule) {
        routedModule = { ...originalModule };
        modules.set(imported.module, routedModule);
        routed[imported.module] = routedModule;
      }
      const implementation = originalModule[imported.name];
      if (typeof implementation !== "function") continue;

      const owner = this.ownerImports.get(
        importKey(imported.module, imported.name),
      );
      if (
        owner
        && entries.some(
          (entry) =>
            !signatureMatchesDescriptor(entry.signature, owner.descriptor),
        )
      ) {
        throw new Error(
          `owner import ${imported.module}.${imported.name} has multiple `
          + "artifact signatures that do not share its exact descriptor",
        );
      }
      routedModule[imported.name] = this.routeFunction(
        imported,
        implementation,
      ) as WebAssembly.ImportValue;
    }
    return routed;
  }

  clear(): void {
    this.localExceptions.clear();
  }
}
