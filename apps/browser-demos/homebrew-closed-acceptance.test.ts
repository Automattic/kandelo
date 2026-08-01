import assert from "node:assert/strict";
import test from "node:test";

import {
  HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
  homebrewBootstrapClosedBinding,
  homebrewClosedAcceptanceAssetRoot,
  homebrewClosedAcceptanceInputNames,
} from "./lib/homebrew-closed-acceptance";

const root = "/homebrew-main-shell-bottles";
const bootstrapBinding = {
  id: "homebrew-bootstrap/source-tree",
  state: "deferred",
  package: {
    name: "homebrew-bootstrap",
    output: "homebrew-bootstrap.zip",
  },
  archive: {
    output: "homebrew-bootstrap.zip",
    url: "homebrew-bootstrap.zip",
    sha256: "a".repeat(64),
    bytes: 123,
  },
};

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
    ["main", "homebrew-vfs-test"],
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

test("closed shell-derived images require one package source tree", () => {
  assert.throws(
    () => homebrewBootstrapClosedBinding({ version: 1 }),
    /omits packageDeferredTrees metadata/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [],
      }),
    /0 Homebrew bootstrap bindings/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [42, { id: "another-package/source-tree" }],
      }),
    /0 Homebrew bootstrap bindings/,
  );
});

test("closed images select one exact deferred Homebrew bootstrap binding", () => {
  assert.deepEqual(
    homebrewBootstrapClosedBinding({
      version: 1,
      packageDeferredTrees: [bootstrapBinding],
    }),
    {
      output: "homebrew-bootstrap.zip",
      url: "homebrew-bootstrap.zip",
      sha256: "a".repeat(64),
      bytes: 123,
    },
  );
});

test("closed images reject malformed or ambiguous bootstrap claims", () => {
  assert.throws(
    () => homebrewBootstrapClosedBinding(null),
    /omits image metadata/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: null,
      }),
    /invalid packageDeferredTrees metadata/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [
          {
            id: "homebrew-bootstrap/source-tree",
            package: null,
          },
        ],
      }),
    /invalid Homebrew bootstrap binding/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [
          {
            ...bootstrapBinding,
            id: "wrong/source-tree",
          },
        ],
      }),
    /invalid Homebrew bootstrap binding/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [
          {
            ...bootstrapBinding,
            archive: {
              ...bootstrapBinding.archive,
              sha256: "not-a-digest",
            },
          },
        ],
      }),
    /invalid Homebrew bootstrap binding/,
  );
  assert.throws(
    () =>
      homebrewBootstrapClosedBinding({
        version: 1,
        packageDeferredTrees: [bootstrapBinding, { ...bootstrapBinding }],
      }),
    /2 Homebrew bootstrap bindings/,
  );
});
