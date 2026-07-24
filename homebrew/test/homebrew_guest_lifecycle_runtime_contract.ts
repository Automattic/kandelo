import type { ClosedLazyAsset } from "../../host/src/vfs/closed-lazy-assets";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../../web-libs/kandelo-session/src/shell-config";
import { assertMainShellGuestCatalogIdentity } from
  "../../scripts/homebrew-main-shell-catalog-contract";
import {
  HOMEBREW_GUEST_LIFECYCLE_CORE_REPOSITORY,
  HOMEBREW_GUEST_LIFECYCLE_CORE_TAP,
} from "./homebrew_guest_lifecycle_contract";

export interface HomebrewGuestLifecycleShell {
  path: string;
  argv0: string;
}

export function parseHomebrewGuestLifecycleShellConfig(
  bytes: Uint8Array,
): HomebrewGuestLifecycleShell {
  const shellConfig = parseKandeloShellConfig(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (shellConfig === null) {
    throw new Error(`${KANDELO_SHELL_CONFIG_PATH} has an unsupported schema`);
  }
  return {
    path: shellConfig.path,
    argv0: shellConfig.argv[0]!,
  };
}

export function assertHomebrewGuestLifecycleCatalog(
  guestManifest: unknown,
  coreRevision: string,
): void {
  assertMainShellGuestCatalogIdentity(guestManifest, {
    tapRepository: HOMEBREW_GUEST_LIFECYCLE_CORE_REPOSITORY,
    tapName: HOMEBREW_GUEST_LIFECYCLE_CORE_TAP,
    tapCommit: coreRevision,
  });
}

/**
 * Resolve the executable from the supplied filesystem rather than carrying
 * bytes over from an earlier boot. A reboot proof must fail if export omitted
 * or re-deferred the image-owned shell. Callers launch this path through the
 * owning worker instead of copying the executable back to the main thread.
 */
export function resolveHomebrewGuestLifecycleShell(
  fs: MemoryFileSystem,
): HomebrewGuestLifecycleShell {
  const shell = parseHomebrewGuestLifecycleShellConfig(
    readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH),
  );
  if (fs.isPathDeferred(shell.path)) {
    throw new Error(
      `lifecycle shell must be image-owned, but ${shell.path} is deferred`,
    );
  }
  const stat = fs.stat(shell.path);
  if ((stat.mode & 0xf000) !== 0x8000 || (stat.mode & 0o111) === 0) {
    throw new Error(`${shell.path} is not an executable regular file`);
  }
  return shell;
}

export function completedLazyDownloadUrls(
  events: readonly LazyDownloadEvent[],
): ReadonlySet<string> {
  return new Set(
    events
      .filter((event) => event.status === "complete")
      .map((event) => event.url),
  );
}

/**
 * Remove materialized phase-one payloads from the closed reboot transport.
 * If export accidentally restores one as deferred, phase two must fail closed
 * instead of hiding the durability regression with the original local bytes.
 */
export function omitCompletedClosedLazyAssets(
  assets: readonly ClosedLazyAsset[] | undefined,
  completedUrls: ReadonlySet<string>,
): readonly ClosedLazyAsset[] | undefined {
  if (assets === undefined) return undefined;
  const remaining = assets.filter((asset) => !completedUrls.has(asset.url));
  if (remaining.length !== 0) return remaining;
  // WHY: the host's exhaustive closed transport intentionally rejects an
  // empty binding set. Keep that transport active with one unreachable guard
  // identity; no VFS descriptor names it, while every phase-one URL remains
  // absent and therefore fails closed if export accidentally re-defers it.
  return [{
    url: "https://closed.kandelo.invalid/homebrew-guest-lifecycle/reboot-guard",
    sha256:
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    size: 1,
    bytes: new Uint8Array([0]),
  }];
}

export function assertNoRepeatedLazyDownloads(
  phaseOneCompletedUrls: ReadonlySet<string>,
  phaseTwoEvents: readonly LazyDownloadEvent[],
  label: string,
): void {
  const repeated = phaseTwoEvents.find((event) =>
    phaseOneCompletedUrls.has(event.url)
  );
  if (repeated !== undefined) {
    throw new Error(
      `${label} fetched phase-one materialized URL ${repeated.url} ` +
        `with status ${repeated.status}`,
    );
  }
}

export function assertNoUnexpectedHostDiagnostics(
  diagnostics: readonly string[],
  label: string,
): void {
  if (diagnostics.length !== 0) {
    throw new Error(
      `${label} emitted unexpected host diagnostics: ${JSON.stringify(diagnostics)}`,
    );
  }
}

function readVfsFile(
  fs: MemoryFileSystem,
  path: string,
  expectedSize?: number,
): Uint8Array {
  const stat = fs.stat(path);
  const size = expectedSize ?? stat.size;
  if ((stat.mode & 0xf000) !== 0x8000 || stat.size !== size) {
    throw new Error(`${path} is not the expected regular file`);
  }
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < size) {
      const count = fs.read(fd, bytes.subarray(offset), null, size - offset);
      if (count <= 0) throw new Error(`${path} ended before ${size} bytes`);
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}
