import assert from "node:assert/strict";
import test from "node:test";

import {
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
  homebrewClosedAcceptanceAssetRoot,
  homebrewClosedAcceptanceInputNames,
} from "./lib/homebrew-closed-acceptance";

const root = "/homebrew-main-shell-bottles";

test("closed acceptance selects its exact mirror authority and product inputs", () => {
  assert.equal(
    homebrewClosedAcceptanceAssetRoot(
      HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
      ` ${root} `,
    ),
    root,
  );
  assert.deepEqual(
    homebrewClosedAcceptanceInputNames(
      HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
    ),
    ["main", "kandelo", "network", "homebrew-vfs-test"],
  );
});

test("ordinary production, public, and source builds have no acceptance authority", () => {
  for (const mode of ["production", "public", "source-rootfs"]) {
    assert.equal(homebrewClosedAcceptanceAssetRoot(mode, undefined), undefined);
    assert.equal(homebrewClosedAcceptanceInputNames(mode), undefined);
    assert.throws(
      () => homebrewClosedAcceptanceAssetRoot(mode, root),
      /permitted only in homebrew-closed-acceptance/,
    );
  }
});

test("the named mode cannot silently build without its exact mirror root", () => {
  assert.throws(
    () =>
      homebrewClosedAcceptanceAssetRoot(
        HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
        undefined,
      ),
    /requires VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT/,
  );
});
