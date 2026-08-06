import { expect, test } from "@playwright/test";

import {
  resolveHomebrewFlatVfsChromiumConfig,
} from "./homebrew-flat-vfs-shipping-config";

const REPO_ROOT = "/work/kandelo";
const ASSET_ROOT = "/work/assets";
const TAP_REVISION = "1".repeat(40);

test("derives every exact Chromium proof input from the sealed workflow roots", () => {
  expect(resolveHomebrewFlatVfsChromiumConfig({
    ASSET_ROOT,
    TAP_REVISION,
    SELECTION_PATH: "selections/experimental.json",
  }, REPO_ROOT)).toEqual({
    assetRoot: ASSET_ROOT,
    tapRoot: "/work/kandelo/tap",
    tapRevision: TAP_REVISION,
    selectionPath: "/work/assets/homebrew-selection.json",
    selectionSourcePath: "/work/kandelo/tap/selections/experimental.json",
    reportPath: "/work/assets/homebrew-vfs-build-report.json",
    kernelPath: "/work/kandelo/local-binaries/kernel.wasm",
    evidencePath: "/work/assets/homebrew-chromium-evidence.json",
    timeoutMs: 30 * 60_000,
  });
});

test("skips only a completely unconfigured heavy Chromium proof", () => {
  expect(resolveHomebrewFlatVfsChromiumConfig({}, REPO_ROOT)).toBeNull();
  expect(() => resolveHomebrewFlatVfsChromiumConfig({
    ASSET_ROOT,
  }, REPO_ROOT)).toThrow(/ASSET_ROOT, TAP_REVISION, and SELECTION_PATH/);
});

test("rejects non-exact roots, revisions, selection paths, and timeouts", () => {
  for (const environment of [
    {
      ASSET_ROOT: "relative/assets",
      TAP_REVISION,
      SELECTION_PATH: "selection.json",
    },
    {
      ASSET_ROOT,
      TAP_REVISION: "A".repeat(40),
      SELECTION_PATH: "selection.json",
    },
    {
      ASSET_ROOT,
      TAP_REVISION,
      SELECTION_PATH: "../selection.json",
    },
    {
      ASSET_ROOT,
      TAP_REVISION,
      SELECTION_PATH: "selection.json",
      KANDELO_HOMEBREW_FLAT_VFS_TIMEOUT_MS: "1800001",
    },
  ]) {
    expect(() => resolveHomebrewFlatVfsChromiumConfig(
      environment,
      REPO_ROOT,
    )).toThrow(/Chromium proof/);
  }
});
