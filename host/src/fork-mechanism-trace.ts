/**
 * Fork/vfork mechanism tracing: the one sample the traces need.
 *
 * `traceVforkMechanism` reports what a fork actually DID — whether the child
 * got a distinct address space or an alias of the parent's — and it reports it
 * as a DELTA across the operation. That needs a reading either side, which is
 * this.
 *
 * # Why this is host floor
 *
 * It reads the host's `ProcessMemoryAllocator`, which owns the process memory
 * accounting: how many backing memories are live, and how many explicit leases
 * alias them. The fork-module cannot see either — it has one imported memory
 * and no view of the allocator that handed it out. The enable check is
 * host-side for the same reason.
 *
 * It is deliberately not gated inside `traceVforkMechanism` instead: the point
 * of a delta is that the BEFORE reading is taken before the operation runs, so
 * the caller has to hold both.
 */

import type {
  ProcessMemoryAllocator,
  ProcessMemoryRetirementStats,
} from "./process-memory";

/**
 * The allocator's current accounting, or `null` when mechanism tracing is off.
 *
 * Returning `null` rather than a zeroed record is what lets a caller write
 * `if (before && after)` and skip the trace entirely: a zeroed record would
 * make every delta read as a real measurement of zero change.
 *
 * `enabled` is passed rather than read here because it is checked per call and
 * not cached — a trace turned on mid-run must take effect without restarting
 * the worker.
 */
export function sampleProcessMemoryStats(
  enabled: boolean,
  allocator: ProcessMemoryAllocator,
): ProcessMemoryRetirementStats | null {
  if (!enabled) return null;
  return allocator.getRetirementStats();
}
