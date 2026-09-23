/**
 * Host memory-reservation budgets.
 *
 * WHY THIS EXISTS — a declared ceiling is a spent resource, not a free upper
 * bound. WebKit/JavaScriptCore charges a shared `WebAssembly.Memory`'s
 * `maximum` and a growable `SharedArrayBuffer`'s `maxByteLength` against one
 * process-wide reservation pool at ALLOCATION time, whether or not a single
 * page is ever touched. When the pool is exhausted the constructor throws
 * `Out of memory` — long before real memory pressure, and with no way to
 * recover except declaring smaller ceilings.
 *
 * Measured on the iOS 27 Simulator (iPhone 16 Pro, Safari 27 / WebKit
 * 605.1.15) on 2026-09-23, with host-side RSS sampling as a control:
 *
 * | held                                   | ceiling that fit |
 * |----------------------------------------|------------------|
 * | growable SharedArrayBuffers only       | ~16 GiB          |
 * | shared WebAssembly.Memory only         | ~4-6 GiB         |
 * | both (any shared wasm memory present)  | **~6 GiB**       |
 *
 * Resident memory stayed under 235 MiB while ~6 GiB of ceilings were held, so
 * the limit is reservation accounting, not physical memory. Plain
 * (non-growable) SharedArrayBuffers are not charged this way.
 *
 * A Kandelo machine declaring 1 GiB per process, 1 GiB for the kernel, and
 * 1 GiB for the root filesystem spends most of that pool on a single boot, so
 * the second machine in a page cannot allocate. V8 (Chrome, Node) reserves
 * address space lazily and has no comparable pool, which is why this only
 * surfaces on Safari and Bun.
 *
 * These profiles are honest resource budgets, not per-demo special cases: a
 * machine that does not fit its host's budget must fail visibly rather than be
 * papered over.
 */

import {
  DEFAULT_KERNEL_MAX_PAGES,
  DEFAULT_MAX_PAGES,
  WASM_PAGE_SIZE,
} from "./constants";

export interface RuntimeMemoryProfile {
  /** Stable identifier, surfaced in diagnostics so the choice is visible. */
  readonly id: "desktop" | "constrained";
  /** Per-process wasm address-space ceiling, in 64 KiB pages. */
  readonly processMaxPages: number;
  /** Kernel wasm address-space ceiling, in 64 KiB pages. */
  readonly kernelMaxPages: number;
  /** Growth ceiling for an image-backed root filesystem, in bytes. */
  readonly imageMemfsMaxBytes: number;
}

/**
 * Engines that reserve address space lazily. Preserves the ceilings Kandelo
 * has always declared; nothing here is charged until pages are touched.
 */
export const DESKTOP_MEMORY_PROFILE: RuntimeMemoryProfile = {
  id: "desktop",
  processMaxPages: DEFAULT_MAX_PAGES,
  kernelMaxPages: DEFAULT_KERNEL_MAX_PAGES,
  imageMemfsMaxBytes: 1 * 1024 * 1024 * 1024,
};

/**
 * Budget for hosts with a small reservation pool (measured: ~6 GiB on iOS
 * Safari once any shared wasm memory exists).
 *
 * 256 MiB per process is the ceiling several browser demo profiles already
 * select by hand for WebKit, and 256 MiB for the kernel is far above its
 * observed heap (the kernel Wasm declares 24 initial pages). The filesystem
 * budget stays at 768 MiB so every shipped image can still be restored at the
 * capacity its own superblock records — the large saving there comes from
 * reserving that recorded capacity instead of a flat 1 GiB, not from
 * squeezing the ceiling.
 */
export const CONSTRAINED_MEMORY_PROFILE: RuntimeMemoryProfile = {
  id: "constrained",
  processMaxPages: 4096,
  kernelMaxPages: 4096,
  imageMemfsMaxBytes: 768 * 1024 * 1024,
};

export const RUNTIME_MEMORY_PROFILES: readonly RuntimeMemoryProfile[] = [
  DESKTOP_MEMORY_PROFILE,
  CONSTRAINED_MEMORY_PROFILE,
];

export function runtimeMemoryProfileById(
  id: string,
): RuntimeMemoryProfile | undefined {
  return RUNTIME_MEMORY_PROFILES.find((p) => p.id === id);
}

/** Total address space one machine declares under `profile`, in bytes. */
export function declaredMachineReservationBytes(
  profile: RuntimeMemoryProfile,
  liveProcesses: number,
): number {
  if (!Number.isSafeInteger(liveProcesses) || liveProcesses < 0) {
    throw new Error(`invalid live process count: ${liveProcesses}`);
  }
  return (
    profile.imageMemfsMaxBytes +
    profile.kernelMaxPages * WASM_PAGE_SIZE +
    liveProcesses * profile.processMaxPages * WASM_PAGE_SIZE
  );
}

/** What the host can tell us about its engine and device. */
export interface RuntimeMemoryEnvironment {
  readonly userAgent?: string;
  /**
   * `navigator.maxTouchPoints`. Required to tell iPadOS from macOS: iPadOS
   * Safari deliberately advertises a Macintosh user agent, and touch points
   * are the signal it does not fake.
   */
  readonly maxTouchPoints?: number;
}

export interface RuntimeMemoryProfileSignals {
  /** Engine charges declared ceilings against a shared reservation pool. */
  readonly chargesDeclaredCeilings: boolean;
  /** That pool is small enough that a machine must budget against it. */
  readonly smallReservationPool: boolean;
}

/**
 * Classify this host's reservation-pool behavior.
 *
 * Two independent facts matter, and conflating them gets one of the hosts
 * wrong. The ENGINE decides whether declared ceilings are charged at all:
 * JavaScriptCore charges them everywhere it runs, V8 and SpiderMonkey nowhere.
 * The DEVICE decides whether that pool is small enough to budget against.
 * Measured 2026-09-23 with the same probe on both: macOS WebKit fits ~45-60
 * GiB of declared ceilings, the iOS Simulator only ~6 GiB. Treating all of
 * WebKit as constrained would shrink desktop Safari's address spaces tenfold
 * for no reason.
 */
export function runtimeMemoryProfileSignals(
  env: RuntimeMemoryEnvironment,
): RuntimeMemoryProfileSignals {
  const userAgent = env.userAgent;
  if (userAgent === undefined) {
    return { chargesDeclaredCeilings: false, smallReservationPool: false };
  }
  // Chromium and Firefox both advertise "Safari"; only the absence of their
  // own tokens identifies real WebKit.
  const isWebKit = /Safari/.test(userAgent) &&
    !/Chrome|Chromium|Android|Firefox/.test(userAgent);
  if (!isWebKit) {
    return { chargesDeclaredCeilings: false, smallReservationPool: false };
  }
  const claimsIos = /iPhone|iPod|iPad/.test(userAgent);
  // iPadOS reports a Macintosh user agent but still reports touch points;
  // a Mac reports none.
  const isTouchMac = /Macintosh/.test(userAgent) && (env.maxTouchPoints ?? 0) > 1;
  return {
    chargesDeclaredCeilings: true,
    smallReservationPool: claimsIos || isTouchMac,
  };
}

/**
 * Choose the memory profile for the running host.
 *
 * `override` comes from an explicit caller (a test, or a deliberate product
 * decision) and wins outright so the choice stays inspectable.
 */
export function detectRuntimeMemoryProfile(
  env: RuntimeMemoryEnvironment,
  override?: string,
): RuntimeMemoryProfile {
  if (override !== undefined) {
    const chosen = runtimeMemoryProfileById(override);
    if (chosen === undefined) {
      throw new Error(`unknown runtime memory profile: ${override}`);
    }
    return chosen;
  }
  return runtimeMemoryProfileSignals(env).smallReservationPool
    ? CONSTRAINED_MEMORY_PROFILE
    : DESKTOP_MEMORY_PROFILE;
}

/**
 * Clamp a caller-requested per-process ceiling to the host's budget.
 *
 * Returns the applied value and, when the request did not fit, the reason —
 * callers must surface that rather than silently shrinking a demo's address
 * space.
 */
export function clampProcessMaxPages(
  requested: number | undefined,
  profile: RuntimeMemoryProfile,
): { pages: number; clampedFrom?: number } {
  if (requested === undefined) return { pages: profile.processMaxPages };
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`invalid process maximum pages: ${requested}`);
  }
  if (requested <= profile.processMaxPages) return { pages: requested };
  return { pages: profile.processMaxPages, clampedFrom: requested };
}

/** Byte peer of {@link clampProcessMaxPages} for root filesystem ceilings. */
export function clampImageMemfsMaxBytes(
  requested: number | undefined,
  profile: RuntimeMemoryProfile,
): { bytes: number; clampedFrom?: number } {
  if (requested === undefined) return { bytes: profile.imageMemfsMaxBytes };
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`invalid image filesystem maximum bytes: ${requested}`);
  }
  if (requested <= profile.imageMemfsMaxBytes) return { bytes: requested };
  return { bytes: profile.imageMemfsMaxBytes, clampedFrom: requested };
}
