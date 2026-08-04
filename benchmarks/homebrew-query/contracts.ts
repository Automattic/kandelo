import type { LazyDownloadEvent } from "../../host/src/vfs/memory-fs";

export interface HomebrewQueryArtifact {
  file: string;
  bytes: number;
  sha256: string;
}

export interface HomebrewQueryLazyArtifact extends HomebrewQueryArtifact {
  url: string;
}

export interface HomebrewQueryTap {
  name: string;
  repository: string;
  commit: string;
}

export interface HomebrewQueryCommand {
  id: string;
  argv: string[];
}

export interface HomebrewQueryFixtureManifest {
  schema: 1;
  kind: "kandelo-homebrew-query-benchmark";
  createdAt: string;
  sourceCommit: string;
  rootfs: HomebrewQueryArtifact;
  eagerRootfs?: HomebrewQueryArtifact;
  kernel: HomebrewQueryArtifact;
  lazyUrlBase: string;
  lazyAssets: HomebrewQueryLazyArtifact[];
  shell: {
    path: string;
    argv0: string;
  };
  homebrew: {
    prefix: string;
    environment: string[];
    trustedFormulae: string[];
  };
  taps: HomebrewQueryTap[];
  commands: HomebrewQueryCommand[];
  focusCommandId: string;
}

export interface HomebrewQueryProcessCounts {
  spawn: number;
  exec: number;
  exit: number;
}

export interface HomebrewQueryLazySummary {
  fetches: number;
  completed: number;
  /** The current VFS reports transfers, not individual cached path accesses. */
  cacheHits: null;
  bytes: number;
  urls: string[];
}

export interface HomebrewQueryCommandResult {
  id: string;
  argv: string[];
  elapsedMs: number;
  status: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  processCounts: HomebrewQueryProcessCounts;
  lazy: HomebrewQueryLazySummary;
}

export interface HomebrewQueryNetworkAudit {
  commands: Array<{
    id: string;
    status: number;
    networkSyscalls: Record<string, number>;
  }>;
}

export interface HomebrewQueryScenarioResult {
  cold: {
    machineBootMs: number;
    machineBootAndFirstBrewMs: number;
    first: HomebrewQueryCommandResult;
    warm: HomebrewQueryCommandResult;
  };
  booted: {
    machineBootMs: number;
    shellBootMs: number;
    first: HomebrewQueryCommandResult[];
    warm: HomebrewQueryCommandResult[];
  };
  eager?: {
    machineBootMs: number;
    shellBootMs: number;
    first: HomebrewQueryCommandResult;
    warm: HomebrewQueryCommandResult;
  };
  networkAudit?: HomebrewQueryNetworkAudit;
}

export interface HomebrewQueryBenchmarkResult {
  schema: 1;
  kind: "kandelo-homebrew-query-benchmark-result";
  host: "node" | "chromium";
  hostVersion: string;
  kandeloCommit: string;
  recordedAt: string;
  machine: {
    platform: string;
    architecture: string;
    cpu: string;
  };
  fixture: HomebrewQueryFixtureManifest;
  rounds: HomebrewQueryScenarioResult[];
  median: Record<string, number>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_RELATIVE_PATH_RE = /^[^\\\0/]+(?:\/[^\\\0/]+)*$/;

export function assertHomebrewQueryFixture(
  value: unknown,
): asserts value is HomebrewQueryFixtureManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Homebrew query fixture must be an object");
  }
  const fixture = value as Partial<HomebrewQueryFixtureManifest>;
  if (
    fixture.schema !== 1 ||
    fixture.kind !== "kandelo-homebrew-query-benchmark" ||
    typeof fixture.createdAt !== "string" ||
    !Number.isFinite(Date.parse(fixture.createdAt)) ||
    typeof fixture.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(fixture.sourceCommit) ||
    typeof fixture.lazyUrlBase !== "string" ||
    !Array.isArray(fixture.lazyAssets) ||
    !Array.isArray(fixture.commands) ||
    !Array.isArray(fixture.taps) ||
    typeof fixture.focusCommandId !== "string" ||
    typeof fixture.shell?.path !== "string" ||
    !fixture.shell.path.startsWith("/") ||
    typeof fixture.shell.argv0 !== "string" ||
    typeof fixture.homebrew?.prefix !== "string" ||
    !fixture.homebrew.prefix.startsWith("/") ||
    !Array.isArray(fixture.homebrew.environment) ||
    !Array.isArray(fixture.homebrew.trustedFormulae)
  ) {
    throw new Error("Homebrew query fixture has invalid top-level fields");
  }
  new URL(fixture.lazyUrlBase);
  assertArtifact(fixture.rootfs, "rootfs");
  assertArtifact(fixture.kernel, "kernel");
  if (fixture.eagerRootfs !== undefined) {
    assertArtifact(fixture.eagerRootfs, "eagerRootfs");
  }
  const commandIds = new Set<string>();
  for (const command of fixture.commands) {
    if (
      typeof command?.id !== "string" || command.id === "" ||
      !Array.isArray(command.argv) || command.argv.length === 0 ||
      command.argv.some((argument) => typeof argument !== "string") ||
      commandIds.has(command.id)
    ) {
      throw new Error("Homebrew query fixture has an invalid command");
    }
    commandIds.add(command.id);
  }
  if (!commandIds.has(fixture.focusCommandId)) {
    throw new Error("Homebrew query fixture focus command is missing");
  }
  const tapNames = new Set<string>();
  for (const tap of fixture.taps) {
    if (
      typeof tap?.name !== "string" || tap.name === "" ||
      typeof tap.repository !== "string" || tap.repository === "" ||
      typeof tap.commit !== "string" || !/^[0-9a-f]{40}$/.test(tap.commit) ||
      tapNames.has(tap.name)
    ) {
      throw new Error("Homebrew query fixture has an invalid tap");
    }
    tapNames.add(tap.name);
  }
  const lazyUrls = new Set<string>();
  for (const asset of fixture.lazyAssets) {
    assertArtifact(asset, "lazy asset");
    if (typeof asset.url !== "string" || lazyUrls.has(asset.url)) {
      throw new Error("Homebrew query fixture has an invalid lazy URL");
    }
    new URL(asset.url);
    lazyUrls.add(asset.url);
  }
  for (const value of fixture.homebrew.environment) {
    if (typeof value !== "string" || !value.includes("=")) {
      throw new Error("Homebrew query fixture has an invalid environment");
    }
  }
  for (const value of fixture.homebrew.trustedFormulae) {
    if (typeof value !== "string" || value.split("/").length !== 3) {
      throw new Error("Homebrew query fixture has invalid Formula trust state");
    }
  }
}

function assertArtifact(
  artifact: HomebrewQueryArtifact | undefined,
  label: string,
): void {
  if (
    typeof artifact?.file !== "string" || artifact.file === "" ||
    !SAFE_RELATIVE_PATH_RE.test(artifact.file) ||
    artifact.file.split("/").some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
    typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)
  ) {
    throw new Error(`Homebrew query fixture ${label} is invalid`);
  }
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function commandScript(command: HomebrewQueryCommand): string {
  return command.argv.map(shellQuote).join(" ");
}

export function emptyProcessCounts(): HomebrewQueryProcessCounts {
  return { spawn: 0, exec: 0, exit: 0 };
}

export function summarizeLazyDownloads(
  events: readonly LazyDownloadEvent[],
): HomebrewQueryLazySummary {
  const byId = new Map<string, LazyDownloadEvent[]>();
  for (const event of events) {
    const list = byId.get(event.id) ?? [];
    list.push(event);
    byId.set(event.id, list);
  }
  let completed = 0;
  let bytes = 0;
  const urls = new Set<string>();
  for (const list of byId.values()) {
    const final = list.at(-1)!;
    urls.add(final.url);
    if (final.status === "complete") completed += 1;
    bytes += final.loadedBytes;
  }
  return {
    fetches: byId.size,
    completed,
    cacheHits: null,
    bytes,
    urls: [...urls].sort(),
  };
}

export function medianMetrics(
  rounds: readonly HomebrewQueryScenarioResult[],
): Record<string, number> {
  const values = new Map<string, number[]>();
  const add = (key: string, value: number): void => {
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
  };
  for (const round of rounds) {
    add("cold.machine_boot_ms", round.cold.machineBootMs);
    add(
      "cold.machine_boot_and_first_brew_ms",
      round.cold.machineBootAndFirstBrewMs,
    );
    add("cold.focus_first_ms", round.cold.first.elapsedMs);
    add("cold.focus_warm_ms", round.cold.warm.elapsedMs);
    add("booted.machine_boot_ms", round.booted.machineBootMs);
    add("booted.shell_boot_ms", round.booted.shellBootMs);
    for (const result of round.booted.first) {
      add(`booted.first.${result.id}_ms`, result.elapsedMs);
    }
    for (const result of round.booted.warm) {
      add(`booted.warm.${result.id}_ms`, result.elapsedMs);
    }
    if (round.eager) {
      add("eager.machine_boot_ms", round.eager.machineBootMs);
      add("eager.shell_boot_ms", round.eager.shellBootMs);
      add("eager.focus_first_ms", round.eager.first.elapsedMs);
      add("eager.focus_warm_ms", round.eager.warm.elapsedMs);
    }
  }
  return Object.fromEntries(
    [...values].map(([key, samples]) => [key, median(samples)]),
  );
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return Math.round(value * 100) / 100;
}
