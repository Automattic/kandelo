import { expect, test } from "@playwright/test";

import {
  exactPlaywrightInstallRoot,
  linuxBrowserProcessAttributionComplete,
  parseLinuxProcessMemory,
  parseLinuxProcStartTicks,
  parseLinuxSwapDisabled,
  parsePlaywrightInstallation,
  processEnvironmentHasLaunchNonce,
} from "../process-memory-linux-accounting";
import {
  applyProcessMemoryRssHealthErrors,
  classifyProcessMemoryRss,
  MIB,
  PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS,
  type ProcessMemoryRssPhase,
  type ProcessMemoryRssSample,
  type ProcessMemoryRssTrial,
} from "../process-memory-rss-telemetry";

interface TrialShape {
  readonly baselineStepMiB?: number;
  readonly baselineMiBBySequence?: Readonly<Record<number, number>>;
  readonly contextLeakMiB?: number;
  readonly contextResidualMiBBySequence?: Readonly<Record<number, number>>;
  readonly fixedRetiredWarmupMiB?: number;
  readonly liveWarmupRate?: number;
  readonly liveWaveRate?: number;
  readonly liveWaveRates?: readonly [number, number];
  readonly liveDestroyRate?: number;
  readonly liveCloseRate?: number;
  readonly retiredWarmupRate?: number;
  readonly retiredWaveRate?: number;
  readonly retiredWaveRates?: readonly [number, number];
  readonly retiredDestroyRate?: number;
  readonly retiredCloseRate?: number;
  readonly retiredTerminalWarmupChildren?: number;
  readonly retiredTerminalWarmupChildrenByReplicate?:
    readonly [number, number];
  readonly retiredLateLeakMiBPerChild?: number;
  readonly retiredLateLeakMiBBySequence?: Readonly<Record<number, number>>;
  readonly retiredWaveOffsetsMiBBySequence?: Readonly<
    Record<number, readonly number[]>
  >;
  readonly closeTransientMiB?: readonly [number, number];
  readonly useSwap?: boolean;
}

function rssSample(
  phase: ProcessMemoryRssPhase,
  completedChildren: number,
  physicalMiB: number,
  elapsedMs: number,
  useSwap: boolean,
): ProcessMemoryRssSample {
  const rssMiB = useSwap ? 500 : physicalMiB;
  const swapMiB = useSwap ? physicalMiB - rssMiB : 0;
  return {
    phase,
    completedChildren,
    elapsedMs,
    rssBytes: rssMiB * MIB,
    swapBytes: swapMiB * MIB,
    processAttributionComplete: true,
    swapAccountingComplete: true,
    hostSwapDisabled: !useSwap,
    exactInstallRoots: ["/browser-build"],
    processes: [],
  };
}

function rssTrials(shape: TrialShape = {}): ProcessMemoryRssTrial[] {
  const plan = [
    { kind: "retired" as const, childMiB: 1 },
    { kind: "live-control" as const, childMiB: 1 },
    { kind: "retired" as const, childMiB: 32 },
    { kind: "live-control" as const, childMiB: 32 },
    { kind: "live-control" as const, childMiB: 32 },
    { kind: "retired" as const, childMiB: 32 },
    { kind: "live-control" as const, childMiB: 1 },
    { kind: "retired" as const, childMiB: 1 },
  ];
  return plan.map(({ kind, childMiB }, sequenceIndex) => {
    const retired = kind === "retired";
    const replicateIndex = sequenceIndex < 4 ? 0 : 1;
    const warmupChildren = retired ? 4 : 1;
    const waveChildren = retired ? 8 : 1;
    const waves = retired ? 12 : 4;
    const baseline =
      500
      + (
        shape.baselineMiBBySequence?.[sequenceIndex]
        ?? sequenceIndex * (shape.baselineStepMiB ?? 0)
      );
    const initialized = baseline + 20;
    const fixedWarmup =
      retired ? shape.fixedRetiredWarmupMiB ?? 0 : 0;
    const warmupRate = retired
      ? shape.retiredWarmupRate ?? 0
      : shape.liveWarmupRate ?? 1;
    const waveRate = retired
      ? (
          shape.retiredWaveRates?.[replicateIndex]
          ?? shape.retiredWaveRate
          ?? 0
        )
      : (
          shape.liveWaveRates?.[replicateIndex]
          ?? shape.liveWaveRate
          ?? 1
        );
    const destroyRate = retired
      ? shape.retiredDestroyRate ?? 0
      : shape.liveDestroyRate ?? 0;
    const closeRate = retired
      ? shape.retiredCloseRate ?? 0
      : shape.liveCloseRate ?? 0;
    const lateLeak =
      retired
        ? (
            shape.retiredLateLeakMiBBySequence?.[sequenceIndex]
            ?? shape.retiredLateLeakMiBPerChild
            ?? 0
          )
        : 0;
    const useSwap = shape.useSwap ?? false;
    let elapsedMs = sequenceIndex * 10_000;
    const sample = (
      phase: ProcessMemoryRssPhase,
      completedChildren: number,
      physicalMiB: number,
    ): ProcessMemoryRssSample => {
      elapsedMs += 100;
      return rssSample(
        phase,
        completedChildren,
        physicalMiB,
        elapsedMs,
        useSwap,
      );
    };
    const terminalWarmupChildren =
      retired
        ? (
            shape.retiredTerminalWarmupChildrenByReplicate?.[replicateIndex]
            ?? shape.retiredTerminalWarmupChildren
            ?? 0
          )
        : 0;
    const stabilizedClose =
      baseline
      + (
        shape.contextResidualMiBBySequence?.[sequenceIndex]
        ?? shape.contextLeakMiB
        ?? 0
      )
      + terminalWarmupChildren * childMiB
      + (warmupChildren + waveChildren * waves)
        * childMiB
        * closeRate;
    const closeTransient = shape.closeTransientMiB ?? [20, 5];
    const samples = [
      sample("pre-context", 0, baseline),
      sample("initialized", 0, initialized),
      sample(
        "post-warmup",
        0,
        initialized
          + fixedWarmup
          + warmupChildren * childMiB * warmupRate,
      ),
      ...Array.from({ length: waves }, (_unused, index) => {
        const completed = (index + 1) * waveChildren;
        const activeChildren = warmupChildren + completed;
        const waveOffsets =
          shape.retiredWaveOffsetsMiBBySequence?.[sequenceIndex];
        const waveOffset = waveOffsets?.[index] ?? 0;
        return sample(
          "post-wave",
          completed,
          initialized
            + fixedWarmup
            + activeChildren * childMiB * waveRate
            + completed * lateLeak
            + waveOffset,
        );
      }),
      sample(
        "post-kernel-destroy",
        waveChildren * waves,
        initialized
          + terminalWarmupChildren * childMiB
          + (warmupChildren + waveChildren * waves)
            * childMiB
            * destroyRate,
      ),
      sample(
        "post-context-close",
        waveChildren * waves,
        stabilizedClose + closeTransient[0],
      ),
      sample(
        "post-context-close",
        waveChildren * waves,
        stabilizedClose + closeTransient[1],
      ),
      sample(
        "post-context-close",
        waveChildren * waves,
        stabilizedClose,
      ),
    ];
    return {
      kind,
      sequenceIndex,
      childMiB,
      warmupChildren,
      waveChildren,
      waves,
      samples,
    };
  });
}

test.describe("engine-local process-memory physical classification", () => {
  test("accepts bounded retired trials against sensitive size controls", () => {
    const verdict = classifyProcessMemoryRss(rssTrials());
    expect(verdict.status).toBe("pass");
  });

  test("rejects a sequence that no longer counterbalances engine drift", () => {
    const trials = rssTrials().map((trial) => ({
      ...trial,
      sequenceIndex:
        trial.sequenceIndex === 0
          ? 1
          : trial.sequenceIndex === 1
            ? 0
            : trial.sequenceIndex,
    }));
    expect(() => classifyProcessMemoryRss(trials)).toThrow(
      /symmetric sequence positions/,
    );
  });

  test("does not trust insensitive low/high live controls", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      liveWarmupRate: 0,
      liveWaveRate: 0,
    }));
    expect(verdict.status).toBe("inconclusive");
  });

  test("requires both ABBA live-control replicates to be sensitive", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      liveWaveRates: [1, 0],
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.sizeContrast.replicates).toHaveLength(2);
  });

  test("requires each live pair to be sensitive before and after warm-up", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      liveWarmupRate: 0,
      liveWaveRate: 1,
    }));
    expect(verdict.status).toBe("inconclusive");
  });

  test("does not average one leaking retirement replicate away", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveRates: [1, 0],
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("replicates disagreed");
  });

  test("reports two leaking retirement replicates as a regression", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveRates: [1, 1],
    }));
    expect(verdict.status).toBe("regression");
  });

  test("enforces the absolute active-effect bound independently", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveRate: 4.25 / 31,
    }));
    expect(verdict.status).toBe("regression");
  });

  test("enforces the relative active-effect bound independently", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      liveWaveRate: 10 / 31,
      retiredWaveRate: 2 / 31,
    }));
    expect(verdict.status).toBe("regression");
  });

  test("rejects size-proportional backing through context teardown", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWarmupRate: 1,
      retiredWaveRate: 1,
      retiredDestroyRate: 1,
      retiredCloseRate: 1,
    }));
    expect(verdict.status).toBe("regression");
  });

  test("records a size-proportional early plateau that later clears", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWarmupRate: 1,
    }));
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("retired warm-up"),
    );
  });

  test("keeps a fixed size-independent warm-up level advisory", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      fixedRetiredWarmupMiB: 400,
    }));
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("size-independent warm-up"),
    );
  });

  test("does not pass one MiB of size-independent growth per child", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredLateLeakMiBPerChild: 1,
    }));
    expect(verdict.status).toBe("inconclusive");
  });

  test("requires every retirement trial to meet the late-trend bound", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredLateLeakMiBBySequence: { 0: 1 },
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("retirement trial 1");
  });

  test("rejects a median-window late-trend violation", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveOffsetsMiBBySequence: {
        0: [0, 0, 0, 0, 0, 0, 30, 30, 30, 30, 30, 30],
      },
    }));
    const trial = verdict.trials.find((candidate) => {
      return candidate.sequenceIndex === 0;
    })!;
    expect(trial.lateSlopeBytesPerChild).toBeGreaterThan(0.5 * MIB);
    expect(trial.lateGrowthBytes).toBeLessThanOrEqual(32 * MIB);
    expect(verdict.status).toBe("inconclusive");
  });

  test("does not mistake one collection-cycle peak for a leak", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveOffsetsMiBBySequence: {
        0: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300],
      },
    }));
    const trial = verdict.trials.find((candidate) => {
      return candidate.sequenceIndex === 0;
    })!;
    expect(trial.lateSlopeBytesPerChild).toBeLessThanOrEqual(0.5 * MIB);
    expect(trial.lateGrowthBytes).toBeLessThanOrEqual(32 * MIB);
    expect(verdict.status).toBe("pass");
  });

  test("does not dilute four retained warm-up children by 100", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineMiBBySequence: {
        0: 0,
        1: 4,
        2: 4,
        3: 132,
        4: 132,
        5: 132,
        6: 260,
        7: 260,
      },
      retiredTerminalWarmupChildren: 4,
    }));
    expect(verdict.status).toBe("regression");
    expect(verdict.reason).toContain("context teardown");
  });

  test("treats one terminally leaking replicate as disagreement", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineMiBBySequence: {
        0: 0,
        1: 4,
        2: 4,
        3: 132,
        4: 132,
        5: 132,
        6: 132,
        7: 132,
      },
      retiredTerminalWarmupChildrenByReplicate: [4, 0],
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("browser baseline");
  });

  test("does not mistake a negative terminal contrast for retention", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredCloseRate: -0.1,
    }));
    expect(verdict.status).toBe("pass");
  });

  test("records a bounded live-control terminal cache", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      liveCloseRate: 1,
    }));
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("live-control size signal"),
    );
  });

  test("does not trust a live-control signal that accumulates", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineStepMiB: 10,
      liveCloseRate: 1,
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("live-control teardown");
  });

  test("records delayed kernel cleanup when context teardown clears it", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredDestroyRate: 1,
      liveDestroyRate: 1,
    }));
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("kernel destruction"),
    );
  });

  test("rejects backing introduced only during destroy and realm close", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineMiBBySequence: {
        0: 0,
        1: 100,
        2: 100,
        3: 3_300,
        4: 3_300,
        5: 3_300,
        6: 6_500,
        7: 6_500,
      },
      retiredDestroyRate: 1,
      retiredCloseRate: 1,
    }));
    expect(verdict.status).toBe("regression");
  });

  test("rejects a fixed ten MiB leak from each warmed context", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineStepMiB: 10,
      contextLeakMiB: 10,
    }));
    expect(verdict.status).toBe("regression");
    expect(verdict.reason).toContain("context residue accumulated");
  });

  test("records median realm residue without baseline growth", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      contextResidualMiBBySequence: {
        0: 5,
        1: 5,
        2: 5,
        3: 5,
        5: 5,
        7: 5,
      },
    }));
    expect(verdict.sizeContrast.realm.medianCloseResidualBytes)
      .toBeGreaterThan(4 * MIB);
    expect(verdict.sizeContrast.realm.upperQuartileCloseResidualBytes)
      .toBeLessThanOrEqual(8 * MIB);
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("fixed context-close residue"),
    );
  });

  test("records upper-quartile realm residue without baseline growth", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      contextResidualMiBBySequence: { 0: 40, 2: 40 },
    }));
    expect(verdict.sizeContrast.realm.medianCloseResidualBytes)
      .toBeLessThanOrEqual(4 * MIB);
    expect(verdict.sizeContrast.realm.upperQuartileCloseResidualBytes)
      .toBeGreaterThan(8 * MIB);
    expect(verdict.status).toBe("pass");
    expect(verdict.advisories).toContainEqual(
      expect.stringContaining("fixed context-close residue"),
    );
  });

  test("hard-gates a Theil-Sen baseline slope alone", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineStepMiB: 1,
    }));
    expect(verdict.sizeContrast.realm.preContextTheilSenBytesPerContext)
      .toBeGreaterThan(0.5 * MIB);
    expect(verdict.sizeContrast.realm.firstLastTwoPreContextDeltaBytes)
      .toBeLessThanOrEqual(32 * MIB);
    expect(verdict.status).toBe("inconclusive");
  });

  test("hard-gates first/last baseline growth alone", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineMiBBySequence: { 6: 40, 7: 40 },
    }));
    expect(verdict.sizeContrast.realm.preContextTheilSenBytesPerContext)
      .toBeLessThanOrEqual(0.5 * MIB);
    expect(verdict.sizeContrast.realm.firstLastTwoPreContextDeltaBytes)
      .toBeGreaterThan(32 * MIB);
    expect(verdict.status).toBe("inconclusive");
  });

  test("uses the stabilized third context-close sample", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      closeTransientMiB: [200, 100],
    }));
    expect(verdict.status).toBe("pass");
    expect(verdict.trials[0]!.postContextCloseSamplesBytes).toEqual([
      700 * MIB,
      600 * MIB,
      500 * MIB,
    ]);
  });

  test("pins the three post-close sampling offsets", () => {
    expect(PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS).toEqual([
      200,
      1_000,
      3_000,
    ]);
  });

  test("rejects missing or unordered post-close samples", () => {
    const missing = rssTrials();
    const missingClose = missing[0]!.samples.filter((sample) => {
      return sample.phase === "post-context-close";
    });
    const missingTrial = {
      ...missing[0]!,
      samples: missing[0]!.samples.filter((sample) => {
        return sample !== missingClose[2];
      }),
    };
    expect(() => classifyProcessMemoryRss([
      missingTrial,
      ...missing.slice(1),
    ])).toThrow(/three ordered post-context-close samples/);

    const unordered = rssTrials();
    const unorderedClose = unordered[0]!.samples.filter((sample) => {
      return sample.phase === "post-context-close";
    });
    const unorderedTrial = {
      ...unordered[0]!,
      samples: unordered[0]!.samples.map((sample) => {
        return sample === unorderedClose[1]
          ? { ...sample, elapsedMs: 0 }
          : sample;
      }),
    };
    expect(() => classifyProcessMemoryRss([
      unorderedTrial,
      ...unordered.slice(1),
    ])).toThrow(/three ordered post-context-close samples/);
  });

  test("treats a noisy descent against one leaking pair as disagreement", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      retiredWaveRates: [0.25, -1],
    }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("replicates disagreed");
  });

  test("counts swapped size-proportional backing as still retained", () => {
    const verdict = classifyProcessMemoryRss(rssTrials({
      baselineMiBBySequence: {
        0: 0,
        1: 4,
        2: 4,
        3: 132,
        4: 132,
        5: 132,
        6: 260,
        7: 260,
      },
      retiredTerminalWarmupChildren: 4,
      useSwap: true,
    }));
    expect(verdict.status).toBe("regression");
  });

  test("preserves a physical regression when later health checks fail", () => {
    const regression = classifyProcessMemoryRss(rssTrials({
      retiredWaveRates: [1, 1],
    }));
    const final = applyProcessMemoryRssHealthErrors(
      regression,
      ["browser disconnected"],
    );
    expect(final.status).toBe("regression");
    expect(final.reason).toContain("workload validation also failed");
  });

  test("downgrades a physical pass when later health checks fail", () => {
    const pass = classifyProcessMemoryRss(rssTrials());
    const final = applyProcessMemoryRssHealthErrors(
      pass,
      ["browser disconnected"],
    );
    expect(final.status).toBe("inconclusive");
    expect(final.reason).toContain("workload validation failed");
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

  test("accepts root-tree helpers that sanitize the launch nonce", () => {
    expect(linuxBrowserProcessAttributionComplete({
      scanComplete: true,
      rootIdentityStable: true,
      rootNonceMatched: true,
      rootTreeProcessCount: 5,
      exactInstallProcessCount: 5,
      unattributedExactBuildProcessCount: 0,
      reparentedProcesses: [],
    })).toBe(true);
  });

  test("requires exact nonce proof for every reparented helper", () => {
    const base = {
      scanComplete: true,
      rootIdentityStable: true,
      rootNonceMatched: true,
      rootTreeProcessCount: 5,
      exactInstallProcessCount: 6,
      unattributedExactBuildProcessCount: 0,
    };
    expect(linuxBrowserProcessAttributionComplete({
      ...base,
      reparentedProcesses: [{
        exactInstallRoot: true,
        launchNonceMatched: true,
      }],
    })).toBe(true);
    expect(linuxBrowserProcessAttributionComplete({
      ...base,
      reparentedProcesses: [{
        exactInstallRoot: true,
        launchNonceMatched: false,
      }],
    })).toBe(false);
    expect(linuxBrowserProcessAttributionComplete({
      ...base,
      reparentedProcesses: [{
        exactInstallRoot: false,
        launchNonceMatched: true,
      }],
    })).toBe(false);
  });

  test("rejects an exact-build process outside both attribution paths", () => {
    expect(linuxBrowserProcessAttributionComplete({
      scanComplete: true,
      rootIdentityStable: true,
      rootNonceMatched: true,
      rootTreeProcessCount: 5,
      exactInstallProcessCount: 5,
      unattributedExactBuildProcessCount: 1,
      reparentedProcesses: [],
    })).toBe(false);
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
