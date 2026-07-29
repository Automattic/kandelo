export const MIB = 1024 * 1024;

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

export interface ProcessMemoryRssMetrics {
  readonly lateSlopeBytesPerChild: number;
  readonly lateGrowthBytes: number;
  readonly peakBytes: number;
  readonly endBytes: number;
  readonly largestDescentBytes: number;
}

export type ProcessMemoryRssVerdict =
  | {
      readonly status: "pass";
      readonly reason: string;
      readonly production: readonly ProcessMemoryRssMetrics[];
      readonly control: ProcessMemoryRssMetrics;
    }
  | {
      readonly status: "inconclusive";
      readonly reason: string;
      readonly production: readonly ProcessMemoryRssMetrics[];
      readonly control: ProcessMemoryRssMetrics;
    }
  | {
      readonly status: "regression";
      readonly reason: string;
      readonly production: readonly ProcessMemoryRssMetrics[];
      readonly control: ProcessMemoryRssMetrics;
    };

function lateSamples(
  samples: readonly ProcessMemoryRssSample[],
): readonly ProcessMemoryRssSample[] {
  if (samples.length < 4) {
    throw new Error("RSS telemetry needs at least four samples");
  }
  return samples.slice(Math.max(1, Math.floor(samples.length / 3)));
}

export function analyzeProcessMemoryRss(
  samples: readonly ProcessMemoryRssSample[],
): ProcessMemoryRssMetrics {
  // WHY: a retained backing can leave RSS by being swapped out without
  // becoming collectible. Treat resident and swapped bytes as one physical
  // trend so eviction can never masquerade as process-memory retirement.
  // PSS would apportion resident pages shared by OS processes, but Linux
  // excludes swapped pages of underlying shmem objects from SwapPss. That is
  // the SharedArrayBuffer case this test protects. RSS plus full Swap is
  // intentionally conservative and may double-count shared pages, so its
  // result is trend evidence rather than exact physical-memory usage.
  const late = lateSamples(samples);
  const xMean = late.reduce(
    (sum, sample) => sum + sample.completedChildren,
    0,
  ) / late.length;
  const yMean = late.reduce(
    (sum, sample) => sum + sample.rssBytes + sample.swapBytes,
    0,
  ) / late.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of late) {
    const dx = sample.completedChildren - xMean;
    covariance += dx * (
      sample.rssBytes + sample.swapBytes - yMean
    );
    variance += dx * dx;
  }

  let peakBytes = 0;
  let largestDescentBytes = 0;
  for (const sample of samples) {
    const residentAndSwapBytes = sample.rssBytes + sample.swapBytes;
    peakBytes = Math.max(peakBytes, residentAndSwapBytes);
    largestDescentBytes = Math.max(
      largestDescentBytes,
      peakBytes - residentAndSwapBytes,
    );
  }

  return {
    lateSlopeBytesPerChild: variance === 0 ? 0 : covariance / variance,
    lateGrowthBytes:
      (
        late[late.length - 1]!.rssBytes
        + late[late.length - 1]!.swapBytes
      ) - (
        late[0]!.rssBytes + late[0]!.swapBytes
      ),
    peakBytes,
    endBytes:
      samples[samples.length - 1]!.rssBytes
      + samples[samples.length - 1]!.swapBytes,
    largestDescentBytes,
  };
}

/**
 * Judge only a matched physical-memory run from one engine and one runner.
 *
 * WHY: browser helpers, just-in-time compilation, shared-page accounting,
 * and garbage-collection timing make cross-engine or absolute RSS limits
 * unstable. The live-process control must first prove that this run's sampler
 * sees resident or swapped backing. Only then may two production trials be
 * compared with that control. See the dated measurement record for the
 * empirical basis.
 */
export function classifyProcessMemoryRss(
  productionSamples: readonly (readonly ProcessMemoryRssSample[])[],
  controlSamples: readonly ProcessMemoryRssSample[],
): ProcessMemoryRssVerdict {
  if (productionSamples.length < 2) {
    throw new Error("RSS telemetry needs two production trials");
  }
  const production = productionSamples.map(analyzeProcessMemoryRss);
  const control = analyzeProcessMemoryRss(controlSamples);
  const minimumControlSlope = 4 * MIB;
  const minimumControlGrowth = 48 * MIB;
  // WHY: relative separation alone would accept a smaller unbounded leak.
  // These are the repository's existing canonical late-window limits; every
  // production trial must satisfy them as well as separating from its control.
  const maximumProductionSlope = 2 * MIB;
  const maximumProductionGrowth = 64 * MIB;

  if (
    control.lateSlopeBytesPerChild < minimumControlSlope
    || control.lateGrowthBytes < minimumControlGrowth
  ) {
    return {
      status: "inconclusive",
      reason:
        "the live-process control did not produce a measurable physical " +
        "memory signal",
      production,
      control,
    };
  }

  const trialKinds = production.map((trial) => {
    const slopeSeparated =
      trial.lateSlopeBytesPerChild
        < control.lateSlopeBytesPerChild * 0.5;
    const growthSeparated =
      trial.lateGrowthBytes < control.lateGrowthBytes * 0.5;
    const absolutelyBounded =
      trial.lateSlopeBytesPerChild <= maximumProductionSlope
      && trial.lateGrowthBytes <= maximumProductionGrowth;
    const descended =
      trial.largestDescentBytes >= control.lateGrowthBytes * 0.25;
    if (slopeSeparated && growthSeparated && absolutelyBounded) {
      return "separated";
    }
    if (!slopeSeparated && !growthSeparated && !descended) {
      return "control-like";
    }
    return "uncertain";
  });
  if (trialKinds.every((kind) => kind === "control-like")) {
    return {
      status: "regression",
      reason:
        "both retirement trials grew like the matched live-process control",
      production,
      control,
    };
  }
  if (!trialKinds.every((kind) => kind === "separated")) {
    return {
      status: "inconclusive",
      reason:
        "the retirement trials did not agree on bounded trend separation",
      production,
      control,
    };
  }
  return {
    status: "pass",
    reason:
      "both retirement trials stayed absolutely bounded and separated " +
      "from the matched control",
    production,
    control,
  };
}
