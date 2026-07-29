export const MIB = 1024 * 1024;
export const PROCESS_MEMORY_POST_CONTEXT_CLOSE_OFFSETS_MS = [
  200,
  1_000,
  3_000,
] as const;

export type ProcessMemoryRssPhase =
  | "pre-context"
  | "initialized"
  | "post-warmup"
  | "post-wave"
  | "post-kernel-destroy"
  | "post-context-close";

export type ProcessMemoryRssTrialKind = "retired" | "live-control";

export interface ProcessRssEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly swapBytes: number;
  readonly command: string;
  readonly executablePath: string | null;
  readonly startTicks: number | null;
  readonly exactInstallRoot: string | null;
  readonly launchNonceMatched: boolean;
  readonly attributionSource:
    | "browser-server-root"
    | "root-tree"
    | "reparented-launch-nonce";
}

export interface ProcessMemoryRssSample {
  readonly phase: ProcessMemoryRssPhase;
  readonly completedChildren: number;
  readonly elapsedMs: number;
  readonly rssBytes: number;
  readonly swapBytes: number;
  readonly processAttributionComplete: boolean;
  readonly swapAccountingComplete: boolean;
  readonly hostSwapDisabled: boolean | null;
  readonly exactInstallRoots: readonly string[];
  readonly processes: readonly ProcessRssEntry[];
}

export interface ProcessMemoryRssTrial {
  readonly kind: ProcessMemoryRssTrialKind;
  readonly sequenceIndex: number;
  readonly childMiB: number;
  readonly warmupChildren: number;
  readonly waveChildren: number;
  readonly waves: number;
  readonly samples: readonly ProcessMemoryRssSample[];
}

export interface ProcessMemoryRssMetrics {
  readonly kind: ProcessMemoryRssTrialKind;
  readonly sequenceIndex: number;
  readonly childMiB: number;
  readonly warmupChildren: number;
  readonly waveChildren: number;
  readonly waves: number;
  readonly totalChildren: number;
  readonly lateSlopeBytesPerChild: number;
  readonly lateGrowthBytes: number;
  readonly peakBytes: number;
  readonly endBytes: number;
  readonly largestDescentBytes: number;
  readonly preContextBytes: number;
  readonly initializedBytes: number;
  readonly postWarmupBytes: number;
  readonly postWaveBytes: number;
  readonly postKernelDestroyBytes: number;
  readonly postContextCloseBytes: number;
  readonly postContextCloseSamplesBytes: readonly number[];
}

export interface ProcessMemoryRssReplicateContrast {
  readonly replicateIndex: number;
  readonly retiredLowSequenceIndex: number;
  readonly retiredHighSequenceIndex: number;
  readonly liveLowSequenceIndex: number;
  readonly liveHighSequenceIndex: number;
  readonly liveWarmupBytesPerChild: number;
  readonly liveWaveBytesPerChild: number;
  readonly retiredWarmupBytesPerChild: number;
  readonly retiredWaveBytesPerChild: number;
  readonly retiredDestroyResidualBytes: number;
  readonly retiredCloseResidualBytes: number;
  readonly liveDestroyResidualBytes: number;
  readonly liveCloseResidualBytes: number;
}

export interface ProcessMemoryRssRealmMetrics {
  readonly stabilizedCloseResidualsBytes: readonly number[];
  readonly medianCloseResidualBytes: number;
  readonly upperQuartileCloseResidualBytes: number;
  readonly preContextTheilSenBytesPerContext: number;
  readonly firstLastTwoPreContextDeltaBytes: number;
  readonly medianCloseResidualLimitBytes: number;
  readonly upperQuartileCloseResidualLimitBytes: number;
}

export interface ProcessMemoryRssSizeContrast {
  readonly lowChildMiB: number;
  readonly highChildMiB: number;
  readonly replicates: readonly ProcessMemoryRssReplicateContrast[];
  readonly realm: ProcessMemoryRssRealmMetrics;
}

export type ProcessMemoryRssVerdict = {
  readonly status: "pass" | "inconclusive" | "regression";
  readonly reason: string;
  readonly trials: readonly ProcessMemoryRssMetrics[];
  readonly sizeContrast: ProcessMemoryRssSizeContrast;
  readonly advisories: readonly string[];
};

function physicalBytes(sample: ProcessMemoryRssSample): number {
  // WHY: a retained backing can leave RSS by being swapped out without
  // becoming collectible. Treat resident and swapped bytes as one physical
  // trend so eviction can never masquerade as process-memory retirement.
  // PSS would apportion resident pages shared by OS processes, but Linux
  // excludes swapped pages of underlying shmem objects from SwapPss. That is
  // the SharedArrayBuffer case this test protects. RSS plus full Swap is
  // intentionally conservative and may double-count shared pages, so its
  // result is trend evidence rather than exact physical-memory usage.
  return sample.rssBytes + sample.swapBytes;
}

function onePhase(
  trial: ProcessMemoryRssTrial,
  phase: Exclude<
    ProcessMemoryRssPhase,
    "post-wave" | "post-context-close"
  >,
): ProcessMemoryRssSample {
  const matches = trial.samples.filter((sample) => sample.phase === phase);
  if (matches.length !== 1) {
    throw new Error(
      `${trial.kind} trial ${trial.sequenceIndex} needs exactly one ` +
        `${phase} sample`,
    );
  }
  return matches[0]!;
}

function postContextCloseSamples(
  trial: ProcessMemoryRssTrial,
): readonly ProcessMemoryRssSample[] {
  const samples = trial.samples.filter((sample) => {
    return sample.phase === "post-context-close";
  });
  if (
    samples.length !== 3
    || samples.some((sample, index) => {
      return index > 0 && sample.elapsedMs <= samples[index - 1]!.elapsedMs;
    })
  ) {
    throw new Error(
      `${trial.kind} trial ${trial.sequenceIndex} needs three ordered ` +
        "post-context-close samples",
    );
  }
  return samples;
}

function waveSamples(
  trial: ProcessMemoryRssTrial,
): readonly ProcessMemoryRssSample[] {
  const samples = trial.samples.filter((sample) => {
    return sample.phase === "post-wave";
  });
  if (samples.length !== trial.waves || samples.length < 4) {
    throw new Error(
      `${trial.kind} trial ${trial.sequenceIndex} needs exactly ` +
        `${trial.waves} post-wave samples and at least four`,
    );
  }
  return samples;
}

export function analyzeProcessMemoryRss(
  trial: ProcessMemoryRssTrial,
): ProcessMemoryRssMetrics {
  const preContext = onePhase(trial, "pre-context");
  const initialized = onePhase(trial, "initialized");
  const postWarmup = onePhase(trial, "post-warmup");
  const waves = waveSamples(trial);
  const postKernelDestroy = onePhase(trial, "post-kernel-destroy");
  const closeSamples = postContextCloseSamples(trial);
  // WHY: collection after realm teardown is asynchronous and differs by
  // engine. The +200 ms sample preserves the immediate transition, while
  // classification uses the stabilized +3 s sample rather than relying on
  // one scheduler-dependent instant.
  const postContextClose = closeSamples[closeSamples.length - 1]!;
  const late = waves.slice(Math.max(1, Math.floor(waves.length / 3)));
  const xMean = late.reduce(
    (sum, sample) => sum + sample.completedChildren,
    0,
  ) / late.length;
  const yMean = late.reduce(
    (sum, sample) => sum + physicalBytes(sample),
    0,
  ) / late.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of late) {
    const dx = sample.completedChildren - xMean;
    covariance += dx * (physicalBytes(sample) - yMean);
    variance += dx * dx;
  }

  let peakBytes = 0;
  let largestDescentBytes = 0;
  for (const sample of trial.samples) {
    const bytes = physicalBytes(sample);
    peakBytes = Math.max(peakBytes, bytes);
    largestDescentBytes = Math.max(
      largestDescentBytes,
      peakBytes - bytes,
    );
  }
  const firstLate = late[0]!;
  const lastLate = late[late.length - 1]!;
  const finalWave = waves[waves.length - 1]!;

  return {
    kind: trial.kind,
    sequenceIndex: trial.sequenceIndex,
    childMiB: trial.childMiB,
    warmupChildren: trial.warmupChildren,
    waveChildren: trial.waveChildren,
    waves: trial.waves,
    totalChildren:
      trial.warmupChildren + trial.waveChildren * trial.waves,
    lateSlopeBytesPerChild:
      variance === 0 ? 0 : covariance / variance,
    lateGrowthBytes: physicalBytes(lastLate) - physicalBytes(firstLate),
    peakBytes,
    endBytes: physicalBytes(postContextClose),
    largestDescentBytes,
    preContextBytes: physicalBytes(preContext),
    initializedBytes: physicalBytes(initialized),
    postWarmupBytes: physicalBytes(postWarmup),
    postWaveBytes: physicalBytes(finalWave),
    postKernelDestroyBytes: physicalBytes(postKernelDestroy),
    postContextCloseBytes: physicalBytes(postContextClose),
    postContextCloseSamplesBytes: closeSamples.map(physicalBytes),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

interface BalancedTrialSet {
  readonly lowChildMiB: number;
  readonly highChildMiB: number;
  readonly low: readonly ProcessMemoryRssMetrics[];
  readonly high: readonly ProcessMemoryRssMetrics[];
  readonly pairs: readonly {
    readonly low: ProcessMemoryRssMetrics;
    readonly high: ProcessMemoryRssMetrics;
  }[];
}

function balancedTrialSet(
  trials: readonly ProcessMemoryRssMetrics[],
  kind: ProcessMemoryRssTrialKind,
): BalancedTrialSet {
  const selected = trials
    .filter((trial) => trial.kind === kind)
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  const sizes = [...new Set(selected.map((trial) => trial.childMiB))]
    .sort((left, right) => left - right);
  if (selected.length !== 4 || sizes.length !== 2) {
    throw new Error(
      `RSS telemetry needs four counterbalanced ${kind} trials at two sizes`,
    );
  }
  const [lowChildMiB, highChildMiB] = sizes;
  const expectedOrder = [
    lowChildMiB,
    highChildMiB,
    highChildMiB,
    lowChildMiB,
  ];
  if (selected.some((trial, index) => {
    return trial.childMiB !== expectedOrder[index];
  })) {
    throw new Error(
      `${kind} trials must use low/high/high/low size order`,
    );
  }
  const low = selected.filter((trial) => trial.childMiB === lowChildMiB);
  const high = selected.filter((trial) => trial.childMiB === highChildMiB);
  if (
    mean(low.map((trial) => trial.sequenceIndex))
    !== mean(high.map((trial) => trial.sequenceIndex))
  ) {
    throw new Error(
      `${kind} low/high trials must have symmetric sequence positions`,
    );
  }
  if (
    new Set(selected.map((trial) => trial.totalChildren)).size !== 1
  ) {
    throw new Error(`${kind} trial workloads must use equal child counts`);
  }
  return {
    lowChildMiB,
    highChildMiB,
    low,
    high,
    pairs: [
      { low: selected[0]!, high: selected[1]! },
      { low: selected[3]!, high: selected[2]! },
    ],
  };
}

function pairContrast(
  pair: {
    readonly low: ProcessMemoryRssMetrics;
    readonly high: ProcessMemoryRssMetrics;
  },
  value: (trial: ProcessMemoryRssMetrics) => number,
): number {
  return value(pair.high) - value(pair.low);
}

function pairPerChild(
  pair: {
    readonly low: ProcessMemoryRssMetrics;
    readonly high: ProcessMemoryRssMetrics;
  },
  value: (trial: ProcessMemoryRssMetrics) => number,
  children: (trial: ProcessMemoryRssMetrics) => number,
): number {
  const count = children(pair.low);
  if (
    count <= 0
    || children(pair.high) !== count
  ) {
    throw new Error("size-contrast phases need equal positive child counts");
  }
  // WHY: retain the sign and both ABBA estimates independently. Averaging or
  // clamping here can let one leaking replicate disappear behind a collection
  // descent in the other replicate.
  return pairContrast(pair, value) / count;
}

function sizeContrast(
  trials: readonly ProcessMemoryRssMetrics[],
): ProcessMemoryRssSizeContrast {
  const retired = balancedTrialSet(trials, "retired");
  const live = balancedTrialSet(trials, "live-control");
  if (
    retired.lowChildMiB !== live.lowChildMiB
    || retired.highChildMiB !== live.highChildMiB
  ) {
    throw new Error("retired and live trials must use the same two sizes");
  }
  const initializedDelta = (
    phase: keyof Pick<
      ProcessMemoryRssMetrics,
      | "postWarmupBytes"
      | "postWaveBytes"
      | "postKernelDestroyBytes"
    >,
  ) => (trial: ProcessMemoryRssMetrics): number => {
    return trial[phase] - trial.initializedBytes;
  };
  const closeResidual = (trial: ProcessMemoryRssMetrics): number => {
    return trial.postContextCloseBytes - trial.preContextBytes;
  };
  const totalChildren = (trial: ProcessMemoryRssMetrics): number => {
    return trial.totalChildren;
  };
  const warmupChildren = (trial: ProcessMemoryRssMetrics): number => {
    return trial.warmupChildren;
  };

  const replicates = retired.pairs.map((retiredPair, replicateIndex) => {
    const livePair = live.pairs[replicateIndex]!;
    return {
      replicateIndex,
      retiredLowSequenceIndex: retiredPair.low.sequenceIndex,
      retiredHighSequenceIndex: retiredPair.high.sequenceIndex,
      liveLowSequenceIndex: livePair.low.sequenceIndex,
      liveHighSequenceIndex: livePair.high.sequenceIndex,
      liveWarmupBytesPerChild: pairPerChild(
        livePair,
        initializedDelta("postWarmupBytes"),
        warmupChildren,
      ),
      liveWaveBytesPerChild: pairPerChild(
        livePair,
        initializedDelta("postWaveBytes"),
        totalChildren,
      ),
      retiredWarmupBytesPerChild: pairPerChild(
        retiredPair,
        initializedDelta("postWarmupBytes"),
        warmupChildren,
      ),
      retiredWaveBytesPerChild: pairPerChild(
        retiredPair,
        initializedDelta("postWaveBytes"),
        totalChildren,
      ),
      // WHY: terminal values are deliberately not divided by all 100 retired
      // children. Otherwise four permanently retained warm-up generations
      // would be diluted enough to look bounded.
      retiredDestroyResidualBytes: pairContrast(
        retiredPair,
        initializedDelta("postKernelDestroyBytes"),
      ),
      retiredCloseResidualBytes: pairContrast(
        retiredPair,
        closeResidual,
      ),
      liveDestroyResidualBytes: pairContrast(
        livePair,
        initializedDelta("postKernelDestroyBytes"),
      ),
      liveCloseResidualBytes: pairContrast(livePair, closeResidual),
    };
  });
  const minimumLiveChildSignal = Math.min(
    ...replicates.map((replicate) => replicate.liveWaveBytesPerChild),
  );
  const closeResiduals = [...trials]
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex)
    .map((trial) => {
      return trial.postContextCloseBytes - trial.preContextBytes;
    });
  const preContext = [...trials]
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex)
    .map((trial) => trial.preContextBytes);

  return {
    lowChildMiB: retired.lowChildMiB,
    highChildMiB: retired.highChildMiB,
    replicates,
    realm: {
      stabilizedCloseResidualsBytes: closeResiduals,
      medianCloseResidualBytes: median(closeResiduals),
      upperQuartileCloseResidualBytes: quantile(closeResiduals, 0.75),
      preContextTheilSenBytesPerContext: theilSenSlope(preContext),
      firstLastTwoPreContextDeltaBytes:
        mean(preContext.slice(-2)) - mean(preContext.slice(0, 2)),
      medianCloseResidualLimitBytes: Math.min(
        4 * MIB,
        minimumLiveChildSignal * 0.15,
      ),
      upperQuartileCloseResidualLimitBytes: Math.min(
        8 * MIB,
        minimumLiveChildSignal * 0.30,
      ),
    },
  };
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("quantile needs at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

function theilSenSlope(values: readonly number[]): number {
  if (values.length < 2) {
    throw new Error("Theil-Sen slope needs at least two values");
  }
  const slopes: number[] = [];
  for (let left = 0; left < values.length - 1; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      slopes.push((values[right]! - values[left]!) / (right - left));
    }
  }
  return median(slopes);
}

/**
 * Judge one engine/runtime revision without a cross-engine RSS ceiling.
 *
 * WHY: browser helpers, just-in-time compilation, shared-page accounting,
 * and garbage-collection timing make absolute RSS limits unstable. Symmetric
 * 1 MiB/32 MiB trials isolate memory-size-dependent backing from fixed cache
 * levels, while live trials prove that this exact sampler can see touched
 * backing. A pass is evidence of separation in this run, never a promise
 * that an engine will collect a particular object by a portable deadline.
 */
export function classifyProcessMemoryRss(
  input: readonly ProcessMemoryRssTrial[],
): ProcessMemoryRssVerdict {
  if (
    input.length !== 8
    || new Set(input.map((trial) => trial.sequenceIndex)).size !== input.length
  ) {
    throw new Error("RSS telemetry needs eight uniquely ordered trials");
  }
  const trials = input
    .map(analyzeProcessMemoryRss)
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  if (trials.some((trial, index) => trial.sequenceIndex !== index)) {
    throw new Error("RSS telemetry trial sequence must be contiguous");
  }
  const contrast = sizeContrast(trials);
  const advisories: string[] = [];
  const minimumLiveSignal = 8 * MIB;
  const maximumPassEffect = 4 * MIB;
  const maximumPassRatio = 0.15;
  const maximumLateSlope = 512 * 1024;
  const maximumLateGrowth = 32 * MIB;

  const insensitiveLiveReplicate = contrast.replicates.find((replicate) => {
    return (
      replicate.liveWarmupBytesPerChild < minimumLiveSignal
      || replicate.liveWaveBytesPerChild < minimumLiveSignal
    );
  });
  if (insensitiveLiveReplicate) {
    return {
      status: "inconclusive",
      reason:
        `live-control replicate ${
          insensitiveLiveReplicate.replicateIndex + 1
        } did not expose at least 8 MiB per child during both warm-up ` +
        "and sustained churn",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }

  const bounded = (
    effect: number,
    liveSignal: number,
  ): boolean => {
    return effect <= maximumPassEffect
      && effect <= liveSignal * maximumPassRatio;
  };
  if (contrast.replicates.some((replicate) => {
    return !bounded(
      replicate.retiredWarmupBytesPerChild,
      replicate.liveWarmupBytesPerChild,
    );
  })) {
    advisories.push(
      "the retired warm-up retained a size-proportional level that " +
        "cleared at a later lifecycle phase",
    );
  }
  const lowRetiredWarmupLevels = trials
    .filter((trial) => {
      return (
        trial.kind === "retired"
        && trial.childMiB === contrast.lowChildMiB
      );
    })
    .map((trial) => trial.postWarmupBytes - trial.initializedBytes);
  if (mean(lowRetiredWarmupLevels) >= 128 * MIB) {
    advisories.push(
      "retirement trials had a size-independent warm-up level of at least " +
        "128 MiB; preserve it for same-revision longitudinal comparison",
    );
  }

  const activeFailures = contrast.replicates.filter((replicate) => {
    return !bounded(
      replicate.retiredWaveBytesPerChild,
      replicate.liveWaveBytesPerChild,
    );
  });
  if (activeFailures.length === contrast.replicates.length) {
    return {
      status: "regression",
      reason:
        "both retirement replicates retained size-proportional backing " +
        "during sustained churn",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }
  if (activeFailures.length > 0) {
    return {
      status: "inconclusive",
      reason:
        "the two retirement replicates disagreed about size-proportional " +
        "backing during sustained churn",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }

  const terminalBounded = (
    residual: number,
    liveSignal: number,
  ): boolean => {
    return Math.abs(residual) <= Math.min(
      maximumPassEffect,
      liveSignal * maximumPassRatio,
    );
  };
  const unclearedLiveTerminal = contrast.replicates.find((replicate) => {
    return (
      !terminalBounded(
        replicate.liveDestroyResidualBytes,
        replicate.liveWaveBytesPerChild,
      )
      || !terminalBounded(
        replicate.liveCloseResidualBytes,
        replicate.liveWaveBytesPerChild,
      )
    );
  });
  if (unclearedLiveTerminal) {
    return {
      status: "inconclusive",
      reason:
        `live-control replicate ${
          unclearedLiveTerminal.replicateIndex + 1
        } retained a size signal after kernel or context teardown`,
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }

  for (
    const [phase, field] of [
      ["kernel destruction", "retiredDestroyResidualBytes"],
      ["context closure", "retiredCloseResidualBytes"],
    ] as const
  ) {
    const failures = contrast.replicates.filter((replicate) => {
      return !terminalBounded(
        replicate[field],
        replicate.liveWaveBytesPerChild,
      );
    });
    const positiveFailures = failures.filter((replicate) => {
      return replicate[field] > 0;
    });
    if (
      failures.length === contrast.replicates.length
      && positiveFailures.length === failures.length
    ) {
      return {
        status: "regression",
        reason:
          `both retirement replicates retained absolute backing after ` +
          phase,
        trials,
        sizeContrast: contrast,
        advisories,
      };
    }
    if (failures.length > 0) {
      return {
        status: "inconclusive",
        reason:
          `the retirement replicates disagreed or remained noisy after ` +
          phase,
        trials,
        sizeContrast: contrast,
        advisories,
      };
    }
  }

  const retiredTrials = trials.filter((trial) => {
    return trial.kind === "retired";
  });
  const unboundedLateTrial = retiredTrials.find((trial) => {
    return (
      trial.lateSlopeBytesPerChild > maximumLateSlope
      || trial.lateGrowthBytes > maximumLateGrowth
    );
  });
  if (unboundedLateTrial) {
    return {
      status: "inconclusive",
      reason:
        `retirement trial ${unboundedLateTrial.sequenceIndex + 1} exceeded ` +
        "the per-trial late slope or growth limit",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }

  const realm = contrast.realm;
  const realmResidueExceeded =
    realm.medianCloseResidualBytes
      > realm.medianCloseResidualLimitBytes
    || realm.upperQuartileCloseResidualBytes
      > realm.upperQuartileCloseResidualLimitBytes;
  const realmTrendExceeded =
    realm.preContextTheilSenBytesPerContext > maximumLateSlope
    || realm.firstLastTwoPreContextDeltaBytes > maximumLateGrowth;
  if (realmResidueExceeded && realmTrendExceeded) {
    return {
      status: "regression",
      reason:
        "stabilized context residue accumulated across the warmed browser " +
        "realm",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }
  if (realmResidueExceeded || realmTrendExceeded) {
    return {
      status: "inconclusive",
      reason:
        "fixed context residue or the pre-context browser baseline exceeded " +
        "its within-run stability limit",
      trials,
      sizeContrast: contrast,
      advisories,
    };
  }
  return {
    status: "pass",
    reason:
      "retired backing separated from sensitive low/high live controls " +
      "during sustained churn and teardown",
    trials,
    sizeContrast: contrast,
    advisories,
  };
}

export function applyProcessMemoryRssHealthErrors(
  verdict: ProcessMemoryRssVerdict,
  healthErrors: readonly string[],
): ProcessMemoryRssVerdict {
  if (healthErrors.length === 0) return verdict;
  if (verdict.status === "regression") {
    // WHY: a later transcript, attribution, or host-health failure weakens
    // positive evidence, but it must not erase a physical regression already
    // diagnosed from the complete samples we did obtain.
    return {
      ...verdict,
      reason:
        `${verdict.reason}; workload validation also failed: ` +
        healthErrors[0],
    };
  }
  return {
    ...verdict,
    status: "inconclusive",
    reason: `workload validation failed: ${healthErrors[0]}`,
  };
}
