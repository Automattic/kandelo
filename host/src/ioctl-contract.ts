/**
 * Host-side mirror of `shared::ioctl_contract::request_contract`.
 *
 * Most ioctls are keyed by an exact request number and resolve straight out
 * of `IOCTL_REQUESTS`. The evdev surface is not: `EVIOCGNAME(len)` and
 * `EVIOCGBIT(ev, len)` encode a caller-chosen length in the request itself,
 * and `EVIOCGABS(axis)` spans 64 axes, so those resolve through
 * `IOCTL_REQUEST_FAMILIES` instead. Both hosts must agree with the kernel on
 * the staged byte count, so the two tables are consulted in the same order
 * here as in Rust.
 */
import {
  IOCTL_REQUESTS,
  IOCTL_REQUEST_FAMILIES,
  type IoctlRequestContract,
} from "./generated/abi";

function familyContract(request: number): IoctlRequestContract | undefined {
  const dir = (request >>> 30) & 0x3;
  const encodedSize = (request >>> 16) & 0x3fff;
  const magic = (request >>> 8) & 0xff;
  const nr = request & 0xff;

  const family = IOCTL_REQUEST_FAMILIES.find(
    (candidate) =>
      candidate.dir === dir &&
      candidate.magic === magic &&
      candidate.nrFirst <= nr &&
      nr <= candidate.nrLast,
  );
  if (!family) return undefined;

  if (family.fixedSize !== null) {
    if (encodedSize !== family.fixedSize) return undefined;
  } else if (family.maxCallerSize !== null) {
    if (encodedSize < 1 || encodedSize > family.maxCallerSize) return undefined;
  } else {
    return undefined;
  }

  return {
    argKind: "pointer",
    direction: family.direction,
    wasm32Size: encodedSize,
    wasm64Size: encodedSize,
  };
}

/**
 * Resolve one ioctl request to its marshalling contract, or `undefined` when
 * the request is unknown and must reach the device with no staged pointer.
 */
export function resolveIoctlContract(
  request: number,
): IoctlRequestContract | undefined {
  return IOCTL_REQUESTS[request >>> 0] ?? familyContract(request >>> 0);
}
