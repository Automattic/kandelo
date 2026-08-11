import { isAbsolute, join, resolve } from "node:path";

const TAP_REVISION_RE = /^[0-9a-f]{40}$/;
const SAFE_SELECTION_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface HomebrewFlatVfsChromiumConfig {
  assetRoot: string;
  tapRoot: string;
  tapRevision: string;
  selectionPath: string;
  selectionSourcePath: string;
  reportPath: string;
  kernelPath: string;
  evidencePath: string;
  timeoutMs: number;
}

export function resolveHomebrewFlatVfsChromiumConfig(
  environment: Record<string, string | undefined>,
  repoRoot: string,
): HomebrewFlatVfsChromiumConfig | null {
  const assetRoot = environment.ASSET_ROOT;
  const tapRevision = environment.TAP_REVISION;
  const selectionRelativePath = environment.SELECTION_PATH;
  const configured = [assetRoot, tapRevision, selectionRelativePath]
    .some((value) => value !== undefined);
  if (!configured) return null;
  if (
    assetRoot === undefined ||
    tapRevision === undefined ||
    selectionRelativePath === undefined
  ) {
    throw new Error(
      "flat Homebrew VFS Chromium proof requires ASSET_ROOT, " +
        "TAP_REVISION, and SELECTION_PATH together",
    );
  }
  if (!isAbsolute(assetRoot) || resolve(assetRoot) !== assetRoot) {
    throw new Error(
      "flat Homebrew VFS Chromium proof ASSET_ROOT must be an exact " +
        "absolute path",
    );
  }
  if (!TAP_REVISION_RE.test(tapRevision)) {
    throw new Error(
      "flat Homebrew VFS Chromium proof TAP_REVISION is invalid",
    );
  }
  if (
    !SAFE_SELECTION_PATH_RE.test(selectionRelativePath) ||
    selectionRelativePath.startsWith("/") ||
    selectionRelativePath.endsWith("/") ||
    selectionRelativePath.split("/").some(
      (part) => part === "" || part === "." || part === "..",
    )
  ) {
    throw new Error(
      "flat Homebrew VFS Chromium proof SELECTION_PATH is invalid",
    );
  }
  const timeoutText =
    environment.KANDELO_HOMEBREW_FLAT_VFS_TIMEOUT_MS ??
    String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9][0-9]*$/.test(timeoutText)) {
    throw new Error("flat Homebrew VFS Chromium proof timeout is invalid");
  }
  const timeoutMs = Number(timeoutText);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    throw new Error("flat Homebrew VFS Chromium proof timeout is invalid");
  }
  const exactRepoRoot = resolve(repoRoot);
  const tapRoot = join(exactRepoRoot, "tap");
  return {
    assetRoot,
    tapRoot,
    tapRevision,
    selectionPath: join(assetRoot, "homebrew-selection.json"),
    selectionSourcePath: join(tapRoot, selectionRelativePath),
    reportPath: join(assetRoot, "homebrew-vfs-build-report.json"),
    kernelPath: join(exactRepoRoot, "local-binaries/kernel.wasm"),
    evidencePath: join(assetRoot, "homebrew-chromium-evidence.json"),
    timeoutMs,
  };
}
