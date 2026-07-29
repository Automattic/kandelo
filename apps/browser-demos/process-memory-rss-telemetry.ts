export const MIB = 1024 * 1024;

export interface ProcessRssEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly command: string;
}

export interface ProcessMemoryRssSample {
  readonly completedChildren: number;
  readonly elapsedMs: number;
  readonly rssBytes: number;
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
  const late = lateSamples(samples);
  const xMean = late.reduce(
    (sum, sample) => sum + sample.completedChildren,
    0,
  ) / late.length;
  const yMean = late.reduce(
    (sum, sample) => sum + sample.rssBytes,
    0,
  ) / late.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of late) {
    const dx = sample.completedChildren - xMean;
    covariance += dx * (sample.rssBytes - yMean);
    variance += dx * dx;
  }

  let peakBytes = 0;
  let largestDescentBytes = 0;
  for (const sample of samples) {
    peakBytes = Math.max(peakBytes, sample.rssBytes);
    largestDescentBytes = Math.max(
      largestDescentBytes,
      peakBytes - sample.rssBytes,
    );
  }

  return {
    lateSlopeBytesPerChild: variance === 0 ? 0 : covariance / variance,
    lateGrowthBytes:
      late[late.length - 1]!.rssBytes - late[0]!.rssBytes,
    peakBytes,
    endBytes: samples[samples.length - 1]!.rssBytes,
    largestDescentBytes,
  };
}

/**
 * Judge only a matched run from one engine and one runner.
 *
 * WHY: browser helpers, just-in-time compilation, shared-page accounting,
 * and garbage-collection timing make cross-engine or absolute RSS limits
 * unstable. The live-process control must first prove that this run's sampler
 * sees resident backing. Only then may two production trials be compared with
 * that control. See the dated measurement record for the empirical basis.
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

  if (
    control.lateSlopeBytesPerChild < minimumControlSlope
    || control.lateGrowthBytes < minimumControlGrowth
  ) {
    return {
      status: "inconclusive",
      reason:
        "the live-process control did not produce a measurable RSS signal",
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
    const descended =
      trial.largestDescentBytes >= control.lateGrowthBytes * 0.25;
    if (slopeSeparated && growthSeparated) return "separated";
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
      "both retirement trials stayed separated from the matched control",
    production,
    control,
  };
}
