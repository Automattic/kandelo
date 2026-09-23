import { describe, expect, it } from "vitest";
import {
  CONSTRAINED_MEMORY_PROFILE,
  clampImageMemfsMaxBytes,
  clampProcessMaxPages,
  declaredMachineReservationBytes,
  DESKTOP_MEMORY_PROFILE,
  detectRuntimeMemoryProfile,
  runtimeMemoryProfileById,
  runtimeMemoryProfileSignals,
} from "../src/runtime-memory-profile";
import { DEFAULT_KERNEL_MAX_PAGES, DEFAULT_MAX_PAGES } from "../src/constants";

const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 " +
  "Safari/604.1";
// iPadOS Safari advertises a Macintosh user agent; only touch points differ.
const SAFARI_IPADOS = SAFARI_MAC;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Mobile Safari/537.36";
const FIREFOX_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:135.0) Gecko/20100101 " +
  "Firefox/135.0";

describe("detectRuntimeMemoryProfile", () => {
  it("preserves the historical ceilings on engines that reserve lazily", () => {
    expect(DESKTOP_MEMORY_PROFILE.processMaxPages).toBe(DEFAULT_MAX_PAGES);
    expect(DESKTOP_MEMORY_PROFILE.kernelMaxPages).toBe(
      DEFAULT_KERNEL_MAX_PAGES,
    );
    expect(DESKTOP_MEMORY_PROFILE.imageMemfsMaxBytes).toBe(1024 * 1024 * 1024);
  });

  it.each([
    ["Chrome on macOS", CHROME_MAC, 0],
    ["Chrome on Android", CHROME_ANDROID, 5],
    ["Firefox on macOS", FIREFOX_MAC, 0],
    // macOS WebKit fits ~45-60 GiB of declared ceilings (measured), so it does
    // not need a budget even though JavaScriptCore charges them.
    ["Safari on macOS", SAFARI_MAC, 0],
  ])("uses the desktop budget for %s", (_label, userAgent, maxTouchPoints) => {
    expect(
      detectRuntimeMemoryProfile({ userAgent, maxTouchPoints }).id,
    ).toBe("desktop");
  });

  it.each([
    ["Safari on iOS", SAFARI_IOS, 5],
    ["Safari on iPadOS (Macintosh user agent)", SAFARI_IPADOS, 5],
  ])(
    "uses the constrained budget for %s",
    (_label, userAgent, maxTouchPoints) => {
      expect(
        detectRuntimeMemoryProfile({ userAgent, maxTouchPoints }).id,
      ).toBe("constrained");
    },
  );

  it("tells iPadOS from macOS by touch points, not the user agent", () => {
    // Both send the identical Macintosh user agent; only the device differs.
    expect(
      detectRuntimeMemoryProfile({ userAgent: SAFARI_MAC, maxTouchPoints: 0 })
        .id,
    ).toBe("desktop");
    expect(
      detectRuntimeMemoryProfile({ userAgent: SAFARI_MAC, maxTouchPoints: 5 })
        .id,
    ).toBe("constrained");
  });

  it("does not mistake a touch Chromebook or Android phone for iPadOS", () => {
    expect(
      detectRuntimeMemoryProfile({
        userAgent: CHROME_ANDROID,
        maxTouchPoints: 5,
      }).id,
    ).toBe("desktop");
  });

  it("reports that WebKit charges ceilings even where the pool is large", () => {
    const mac = runtimeMemoryProfileSignals({
      userAgent: SAFARI_MAC,
      maxTouchPoints: 0,
    });
    expect(mac.chargesDeclaredCeilings).toBe(true);
    expect(mac.smallReservationPool).toBe(false);
    const chrome = runtimeMemoryProfileSignals({ userAgent: CHROME_MAC });
    expect(chrome.chargesDeclaredCeilings).toBe(false);
  });

  it("falls back to the desktop budget with no user agent (Node)", () => {
    expect(detectRuntimeMemoryProfile({}).id).toBe("desktop");
  });

  it("lets an explicit override win so the choice stays inspectable", () => {
    expect(
      detectRuntimeMemoryProfile({ userAgent: CHROME_MAC }, "constrained").id,
    ).toBe("constrained");
    expect(
      detectRuntimeMemoryProfile(
        { userAgent: SAFARI_IOS, maxTouchPoints: 5 },
        "desktop",
      ).id,
    ).toBe("desktop");
  });

  it("rejects an unknown override rather than silently guessing", () => {
    expect(() =>
      detectRuntimeMemoryProfile({ userAgent: CHROME_MAC }, "tiny"),
    ).toThrow(/unknown runtime memory profile: tiny/);
    expect(runtimeMemoryProfileById("tiny")).toBeUndefined();
  });
});

describe("clampProcessMaxPages", () => {
  it("returns the profile default when the caller asks for nothing", () => {
    expect(clampProcessMaxPages(undefined, CONSTRAINED_MEMORY_PROFILE)).toEqual(
      { pages: CONSTRAINED_MEMORY_PROFILE.processMaxPages },
    );
  });

  it("honours a request that fits", () => {
    expect(clampProcessMaxPages(1024, CONSTRAINED_MEMORY_PROFILE)).toEqual({
      pages: 1024,
    });
  });

  it("reports the original request when it does not fit", () => {
    // A demo asking for 1 GiB on a constrained host really does get less
    // address space; callers must be able to say so.
    expect(clampProcessMaxPages(16384, CONSTRAINED_MEMORY_PROFILE)).toEqual({
      pages: 4096,
      clampedFrom: 16384,
    });
  });

  it("never clamps under the desktop budget", () => {
    expect(clampProcessMaxPages(16384, DESKTOP_MEMORY_PROFILE)).toEqual({
      pages: 16384,
    });
  });

  it("rejects nonsense page counts", () => {
    expect(() => clampProcessMaxPages(0, DESKTOP_MEMORY_PROFILE)).toThrow(
      /invalid process maximum pages/,
    );
    expect(() => clampProcessMaxPages(-1, DESKTOP_MEMORY_PROFILE)).toThrow(
      /invalid process maximum pages/,
    );
    expect(() => clampProcessMaxPages(1.5, DESKTOP_MEMORY_PROFILE)).toThrow(
      /invalid process maximum pages/,
    );
  });
});

describe("clampImageMemfsMaxBytes", () => {
  it("keeps every shipped image's recorded capacity within budget", () => {
    // The largest image Kandelo ships (wordpress, lamp) records 768 MiB.
    const shipped = 768 * 1024 * 1024;
    expect(
      clampImageMemfsMaxBytes(shipped, CONSTRAINED_MEMORY_PROFILE),
    ).toEqual({ bytes: shipped });
  });

  it("reports a clamp instead of silently shrinking the filesystem", () => {
    const oversized = 2 * 1024 * 1024 * 1024;
    expect(
      clampImageMemfsMaxBytes(oversized, CONSTRAINED_MEMORY_PROFILE),
    ).toEqual({
      bytes: CONSTRAINED_MEMORY_PROFILE.imageMemfsMaxBytes,
      clampedFrom: oversized,
    });
  });
});

describe("declaredMachineReservationBytes", () => {
  const MiB = 1024 * 1024;

  it("shows the constrained budget fits several machines in WebKit's pool", () => {
    // Measured on iOS 27 Safari: once any shared wasm memory exists, declared
    // ceilings share a ~6 GiB pool. A two-process machine must leave room for
    // at least one more generation during a boot/destroy/boot cycle.
    const perMachine = declaredMachineReservationBytes(
      { ...CONSTRAINED_MEMORY_PROFILE, imageMemfsMaxBytes: 256 * MiB },
      2,
    );
    expect(perMachine).toBeLessThan(1.5 * 1024 * MiB);
    expect(perMachine * 3).toBeLessThan(6 * 1024 * MiB);
  });

  it("shows why the desktop budget exhausts that pool in one boot", () => {
    const perMachine = declaredMachineReservationBytes(
      DESKTOP_MEMORY_PROFILE,
      2,
    );
    // 1 GiB rootfs + 1 GiB kernel + 2 x 1 GiB process = exactly 4 GiB, so a
    // second generation cannot fit alongside the first in a ~6 GiB pool.
    expect(perMachine).toBe(4 * 1024 * MiB);
    expect(perMachine * 2).toBeGreaterThan(6 * 1024 * MiB);
  });

  it("rejects a nonsense process count", () => {
    expect(() =>
      declaredMachineReservationBytes(DESKTOP_MEMORY_PROFILE, -1),
    ).toThrow(/invalid live process count/);
  });
});
