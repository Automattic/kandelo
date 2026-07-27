const intrinsicApply = Reflect.apply;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const appendContractErrors = new WeakSet<object>();

/**
 * A backing mutated and then proved that it could not supply the exact append
 * outcome it promised.
 *
 * This is not an errno-bearing I/O failure: continuing the kernel generation
 * would publish an unknowable open-file-description cursor.
 */
export class HostAppendContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostAppendContractError";
    intrinsicApply(intrinsicWeakSetAdd, appendContractErrors, [this]);
  }
}

/**
 * Check the private module brand without invoking constructors, prototypes, or
 * `Symbol.hasInstance` hooks that a host callback could have replaced.
 */
export function isHostAppendContractError(
  value: unknown,
): value is HostAppendContractError {
  return intrinsicApply(
    intrinsicWeakSetHas,
    appendContractErrors,
    [value as object],
  );
}
