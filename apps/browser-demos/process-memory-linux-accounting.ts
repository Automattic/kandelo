import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type BrowserEngineName = "chromium" | "firefox" | "webkit";

export interface PlaywrightInstallation {
  readonly cacheRoot: string;
  readonly revision: string;
}

export interface LinuxProcessMemory {
  readonly rssBytes: number;
  readonly swapBytes: number;
}

export interface LinuxBrowserProcessAttribution {
  readonly scanComplete: boolean;
  readonly rootIdentityStable: boolean;
  readonly rootNonceMatched: boolean;
  readonly rootTreeProcessCount: number;
  readonly exactInstallProcessCount: number;
  readonly unattributedExactBuildProcessCount: number;
  readonly reparentedProcesses: readonly {
    readonly exactInstallRoot: boolean;
    readonly launchNonceMatched: boolean;
  }[];
}

/**
 * Decide whether one Linux browser launch has a complete physical-memory set.
 *
 * WHY: Chromium can sanitize inherited environment variables in child
 * processes. Stable ancestry from the nonce-authenticated BrowserServer root
 * still identifies those descendants; requiring every descendant to retain
 * the nonce makes a valid Chromium tree permanently inconclusive. A process
 * outside that tree has no ancestry proof, so it must retain the nonce and
 * resolve inside the exact Playwright engine revision. An exact-build process
 * satisfying neither rule is ambiguity, not evidence to omit it.
 */
export function linuxBrowserProcessAttributionComplete(
  attribution: LinuxBrowserProcessAttribution,
): boolean {
  return (
    attribution.scanComplete
    && attribution.rootIdentityStable
    && attribution.rootNonceMatched
    && attribution.rootTreeProcessCount >= 2
    && attribution.exactInstallProcessCount > 0
    && attribution.unattributedExactBuildProcessCount === 0
    && attribution.reparentedProcesses.every((process) => {
      return process.exactInstallRoot && process.launchNonceMatched;
    })
  );
}

export function exactPlaywrightInstallRoots(
  engine: BrowserEngineName,
  installation: PlaywrightInstallation,
): readonly string[] {
  const names =
    engine === "chromium"
      ? ["chromium", "chromium_headless_shell"]
      : [engine];
  return names.map(
    (name) => join(
      installation.cacheRoot,
      `${name}-${installation.revision}`,
    ),
  );
}

function buildDirectoryMatch(
  engine: BrowserEngineName,
  name: string,
): RegExpMatchArray | null {
  const pattern =
    engine === "chromium"
      ? /^chromium(?:_headless_shell)?-(\d+)$/
      : new RegExp(`^${engine}-(\\d+)$`);
  return name.match(pattern);
}

export function parsePlaywrightInstallation(
  engine: BrowserEngineName,
  executablePath: string,
): PlaywrightInstallation | null {
  const parts = resolve(executablePath).split(sep);
  let buildIndex = -1;
  // WHY: a parent directory can coincidentally look like a Playwright build
  // directory. The executable lives below the final matching component.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (buildDirectoryMatch(engine, parts[index]!) !== null) {
      buildIndex = index;
      break;
    }
  }
  if (buildIndex <= 0) return null;
  const match = buildDirectoryMatch(engine, parts[buildIndex]!);
  if (!match?.[1]) return null;
  return {
    cacheRoot: parts.slice(0, buildIndex).join(sep) || sep,
    revision: match[1],
  };
}

export function exactPlaywrightInstallRoot(
  engine: BrowserEngineName,
  installation: PlaywrightInstallation,
  executablePath: string,
): string | null {
  const withinCache = relative(
    installation.cacheRoot,
    executablePath,
  );
  if (
    withinCache === ""
    || withinCache === ".."
    || withinCache.startsWith(`..${sep}`)
    || isAbsolute(withinCache)
  ) {
    return null;
  }
  const buildDirectory = withinCache.split(sep)[0];
  if (!buildDirectory) return null;
  const match = buildDirectoryMatch(engine, buildDirectory);
  if (match?.[1] !== installation.revision) return null;
  const root = join(installation.cacheRoot, buildDirectory);
  return exactPlaywrightInstallRoots(engine, installation).includes(root)
    ? root
    : null;
}

export function parseLinuxProcStartTicks(stat: string): number | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // Fields after the executable name begin with field 3 (`state`).
  // Linux starttime is field 22, hence index 19 in this suffix.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = Number(fields[19]);
  return Number.isSafeInteger(startTicks) && startTicks >= 0
    ? startTicks
    : null;
}

export function parseLinuxProcessMemory(
  rollup: string,
): LinuxProcessMemory | null {
  const rssKiB = Number(rollup.match(/^Rss:\s+(\d+)\s+kB$/m)?.[1]);
  const swapKiB = Number(rollup.match(/^Swap:\s+(\d+)\s+kB$/m)?.[1]);
  if (
    !Number.isSafeInteger(rssKiB)
    || rssKiB < 0
    || !Number.isSafeInteger(swapKiB)
    || swapKiB < 0
  ) {
    return null;
  }
  return {
    rssBytes: rssKiB * 1024,
    swapBytes: swapKiB * 1024,
  };
}

export function parseLinuxSwapDisabled(swaps: string): boolean | null {
  const lines = swaps.split("\n");
  if (
    !/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/.test(
      lines[0] ?? "",
    )
  ) {
    return null;
  }
  return lines.slice(1).every((line) => line.trim() === "");
}

export function processEnvironmentHasLaunchNonce(
  environment: string,
  key: string,
  nonce: string,
): boolean {
  return environment.split("\0").includes(`${key}=${nonce}`);
}
