import { expect, test } from "@playwright/test";

import {
  exactPlaywrightInstallRoot,
  parseLinuxProcessMemory,
  parseLinuxProcStartTicks,
  parseLinuxSwapDisabled,
  parsePlaywrightInstallation,
  processEnvironmentHasLaunchNonce,
} from "../process-memory-linux-accounting";
import {
  classifyProcessMemoryRss,
  MIB,
  type ProcessMemoryRssSample,
} from "../process-memory-rss-telemetry";

function rssSamples(
  valuesMiB: readonly number[],
  childrenPerSample = 8,
  swapValuesMiB: readonly number[] = valuesMiB.map(() => 0),
): ProcessMemoryRssSample[] {
  expect(swapValuesMiB).toHaveLength(valuesMiB.length);
  return valuesMiB.map((rssMiB, index) => {
    return {
      completedChildren: index * childrenPerSample,
      elapsedMs: index * 100,
      rssBytes: rssMiB * MIB,
      swapBytes: swapValuesMiB[index]! * MIB,
      processAttributionComplete: true,
      swapAccountingComplete: true,
      hostSwapDisabled: true,
      exactInstallRoots: ["/browser-build"],
      processes: [],
    };
  });
}

test.describe("engine-local process-memory physical classification", () => {
  test("accepts two bounded trials against a sensitive live control", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 520, 515, 510, 505, 500, 495]),
        rssSamples([510, 530, 525, 520, 515, 510, 505]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("pass");
  });

  test("reports an insensitive control instead of trusting a flat trace", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 505, 510, 515]),
        rssSamples([500, 505, 510, 515]),
      ],
      rssSamples([500, 505, 510, 515]),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("rejects two trials that grow like retained live processes", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 580, 660, 740, 820]),
        rssSamples([510, 590, 670, 750, 830]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("regression");
  });

  test("requires agreement before reporting a regression", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([500, 580, 660, 740, 820]),
        rssSamples([510, 500, 490, 480, 470]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("does not call a rising trial green only because it descended", () => {
    const verdict = classifyProcessMemoryRss(
      [
        rssSamples([900, 500, 600, 700, 800, 900, 1000]),
        rssSamples([910, 510, 610, 710, 810, 910, 1010]),
      ],
      rssSamples([500, 580, 660, 740, 820]),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("does not accept a smaller but still unbounded leak", () => {
    const production = rssSamples(
      [500, 524, 548, 572, 596, 620, 644],
      8,
    );
    const control = rssSamples([500, 580, 660, 740, 820], 4);
    const verdict = classifyProcessMemoryRss(
      [production, production.map((sample) => ({
        ...sample,
        rssBytes: sample.rssBytes + 10 * MIB,
      }))],
      control,
    );
    expect(verdict.status).toBe("inconclusive");
  });

  test("counts swapped production backing instead of treating it as freed", () => {
    const production = rssSamples(
      [500, 500, 500, 500, 500, 500, 500],
      8,
      [0, 24, 48, 72, 96, 120, 144],
    );
    const control = rssSamples([500, 580, 660, 740, 820], 4);
    const verdict = classifyProcessMemoryRss(
      [production, production],
      control,
    );
    expect(verdict.status).toBe("inconclusive");
  });
});

test.describe("Linux browser-memory process accounting", () => {
  test("parses start ticks after a process name containing spaces and )", () => {
    const fields = [
      "S",
      ...Array.from({ length: 18 }, () => "0"),
      "987654",
    ];
    expect(parseLinuxProcStartTicks(
      `42 (browser helper ) name) ${fields.join(" ")}`,
    )).toBe(987654);
    expect(parseLinuxProcStartTicks("malformed")).toBeNull();
  });

  test("binds Chromium helpers to the exact engine revision", () => {
    const installation = parsePlaywrightInstallation(
      "chromium",
      "/cache/ms-playwright/chromium-1228/chrome-linux/chrome",
    );
    expect(installation).toEqual({
      cacheRoot: "/cache/ms-playwright",
      revision: "1228",
    });
    expect(exactPlaywrightInstallRoot(
      "chromium",
      installation!,
      "/cache/ms-playwright/chromium_headless_shell-1228/" +
        "chrome-linux/headless_shell",
    )).toBe(
      "/cache/ms-playwright/chromium_headless_shell-1228",
    );
    expect(exactPlaywrightInstallRoot(
      "chromium",
      installation!,
      "/cache/ms-playwright/chromium_headless_shell-1229/" +
        "chrome-linux/headless_shell",
    )).toBeNull();
    expect(exactPlaywrightInstallRoot(
      "chromium",
      installation!,
      "/cache/ms-playwright/firefox-1228/firefox/firefox",
    )).toBeNull();
  });

  test("recognizes exact Firefox and WebKit installations", () => {
    const firefox = parsePlaywrightInstallation(
      "firefox",
      "/cache/ms-playwright/firefox-1532/firefox/firefox",
    );
    const webkit = parsePlaywrightInstallation(
      "webkit",
      "/cache/ms-playwright/webkit-2311/pw_run.sh",
    );
    expect(exactPlaywrightInstallRoot(
      "firefox",
      firefox!,
      "/cache/ms-playwright/firefox-1532/firefox/plugin-container",
    )).toBe("/cache/ms-playwright/firefox-1532");
    expect(exactPlaywrightInstallRoot(
      "webkit",
      webkit!,
      "/cache/ms-playwright/webkit-2311/minibrowser-gtk/" +
        "MiniBrowser",
    )).toBe("/cache/ms-playwright/webkit-2311");
  });

  test("uses the final build component in an adversarial path", () => {
    expect(parsePlaywrightInstallation(
      "firefox",
      "/cache/firefox-111/wrappers/ms-playwright/" +
        "firefox-1532/firefox/firefox",
    )).toEqual({
      cacheRoot: "/cache/firefox-111/wrappers/ms-playwright",
      revision: "1532",
    });
  });

  test("rejects a concurrent same-build launch with another nonce", () => {
    const environment =
      "PATH=/usr/bin\0KANDELO_MEMORY_TELEMETRY_NONCE=exact-run\0";
    expect(processEnvironmentHasLaunchNonce(
      environment,
      "KANDELO_MEMORY_TELEMETRY_NONCE",
      "exact-run",
    )).toBe(true);
    expect(processEnvironmentHasLaunchNonce(
      environment,
      "KANDELO_MEMORY_TELEMETRY_NONCE",
      "other-run",
    )).toBe(false);
  });

  test("parses both RSS and Swap from smaps_rollup", () => {
    expect(parseLinuxProcessMemory(
      "Rss:                1234 kB\nSwap:                 56 kB\n",
    )).toEqual({
      rssBytes: 1234 * 1024,
      swapBytes: 56 * 1024,
    });
    expect(parseLinuxProcessMemory("Rss: 1234 kB\n")).toBeNull();
  });

  test("proves swap is disabled only from a complete proc header", () => {
    expect(parseLinuxSwapDisabled(
      "Filename Type Size Used Priority\n",
    )).toBe(true);
    expect(parseLinuxSwapDisabled(
      "Filename Type Size Used Priority\n/swap file 1024 0 -2\n",
    )).toBe(false);
    expect(parseLinuxSwapDisabled("")).toBeNull();
    expect(parseLinuxSwapDisabled("Filename\n")).toBeNull();
  });
});
