/**
 * Durable owner-realm representation of a JavaScript value thrown by a
 * deliberately Worker-local Wasm import.
 *
 * A raw object or function cannot move from a process Worker into the durable
 * process owner, and a fork child cannot inherit the Worker's JavaScript heap.
 * Ordinary imports and WebAssembly.JSTag first retain exact local behavior.
 * If such a value is still live at fork and no activation-local exception
 * codec owns it, capture normalizes the child's payload into this explicit
 * capability. Primitive values are retained exactly behind the capability and
 * are unwrapped when a later owner-side host import consumes the handle.
 */

const WORKER_EXCEPTION_CAPABILITY =
  Symbol("kandelo.fork.worker-exception-capability");

export const FORK_WORKER_EXCEPTION_RECIPE_VERSION = 1;

export type ForkWorkerExceptionKind =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol"
  | "error"
  | "object"
  | "function";

export interface ForkWorkerExceptionCapability {
  readonly recipeVersion: typeof FORK_WORKER_EXCEPTION_RECIPE_VERSION;
  readonly sourceImportOrdinal: number;
  readonly kind: ForkWorkerExceptionKind;
  /**
   * Worker-local Error objects have no transferable original. Preserve the
   * standard observable fields on their stable owner capability.
   */
  readonly name?: string;
  readonly message?: string;
  readonly [WORKER_EXCEPTION_CAPABILITY]: true;
}

class WorkerExceptionCapability
  implements ForkWorkerExceptionCapability
{
  readonly recipeVersion = FORK_WORKER_EXCEPTION_RECIPE_VERSION;
  readonly [WORKER_EXCEPTION_CAPABILITY] = true as const;

  constructor(
    readonly sourceImportOrdinal: number,
    readonly kind: ForkWorkerExceptionKind,
    readonly name?: string,
    readonly message?: string,
    /**
     * Exact owner-side value exposed to a later owner-routed host import.
     * Opaque Worker objects/functions and Worker Errors use this capability
     * itself because no durable original exists outside the Worker.
     */
    private boundaryValue?: unknown,
  ) {
    if (boundaryValue === undefined && kind === "undefined") {
      // Undefined is a real exact boundary value, not an omitted initializer.
      this.boundaryValue = undefined;
    }
    Object.freeze(this);
  }

  unwrap(): unknown {
    if (
      this.kind === "error"
      || this.kind === "object"
      || this.kind === "function"
    ) {
      return this;
    }
    return this.boundaryValue;
  }
}

export interface CreateForkWorkerExceptionCapabilityOptions {
  readonly sourceImportOrdinal: number;
  readonly kind: ForkWorkerExceptionKind;
  readonly name?: string;
  readonly message?: string;
  readonly boundaryValue?: unknown;
}

export function createForkWorkerExceptionCapability(
  options: CreateForkWorkerExceptionCapabilityOptions,
): ForkWorkerExceptionCapability {
  if (
    !Number.isInteger(options.sourceImportOrdinal)
    || options.sourceImportOrdinal < 0
    || options.sourceImportOrdinal > 0x7fff_ffff
  ) {
    throw new RangeError(
      `invalid Worker exception source import ordinal `
      + `${options.sourceImportOrdinal}`,
    );
  }
  return new WorkerExceptionCapability(
    options.sourceImportOrdinal,
    options.kind,
    options.name,
    options.message,
    options.boundaryValue,
  );
}

export function isForkWorkerExceptionCapability(
  value: unknown,
): value is ForkWorkerExceptionCapability {
  return (
    typeof value === "object"
    && value !== null
    && (value as Partial<ForkWorkerExceptionCapability>)[
      WORKER_EXCEPTION_CAPABILITY
    ] === true
  );
}

/**
 * Restore exact primitives at owner-side host boundaries. For values that
 * never had a durable owner-realm original, return the stable capability
 * itself; callers can inspect Error name/message and otherwise treat it as the
 * opaque identity WebAssembly exposes.
 */
export function unwrapForkWorkerExceptionCapability(
  value: unknown,
): unknown {
  if (!isForkWorkerExceptionCapability(value)) return value;
  return (value as WorkerExceptionCapability).unwrap();
}
