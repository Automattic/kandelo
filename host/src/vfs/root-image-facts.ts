/**
 * What a boot needs to know about its `/` image, read from the SPEC.
 *
 * Both worker entries used to answer this from the `/` mount's backend — a
 * `MemoryFileSystem` the resolver built from the image and the guest mounts
 * then dropped. With no such mount, both entries needed the same two facts
 * derived the same way from the same place, and writing that twice is the
 * peer duplication lane E drove to its audited floor.
 *
 * Imported as a NAMESPACE — `rootImage.has()`, `rootImage.nosuid()` — so the
 * names read as questions about the root image at the call site and cost one
 * import line rather than five in each entry.
 *
 * So it lives here once, state included. Each worker entry bundles its own
 * instance of this module, which is exactly the scope the facts have: one
 * boot, one kernel.
 */
import type { MountSpec } from "./default-mounts";

let present = false;
let declaredNosuid = false;

/**
 * Record what the boot's mount spec declares about `/`.
 *
 * Returns false when the spec declares no image mount at all, which both
 * entries treat as a boot that has no `/` to serve.
 */
export function record(spec: readonly MountSpec[]): boolean {
  const root = spec.find((m) => m.path === "/" && m.source === "image");
  present = root !== undefined;
  declaredNosuid = root?.nosuid === true;
  return present;
}

/** Whether this kernel booted from a `/` image. */
export function has(): boolean {
  return present;
}

/** Whether the boot declared `/` `nosuid`. */
export function nosuid(): boolean {
  return declaredNosuid;
}

/** Forget the boot's facts, for a host that tears its kernel down. */
export function forget(): void {
  present = false;
  declaredNosuid = false;
}
