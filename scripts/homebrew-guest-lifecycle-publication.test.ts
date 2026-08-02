import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import { homebrewRuntimeLayerPayloadAsset } from "../host/src/homebrew-runtime-layer-limits";
import {
  createHomebrewGuestLifecyclePublication,
  verifyHomebrewGuestLifecyclePublication,
} from "./homebrew-guest-lifecycle-publication";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(here);
const refs = {
  kandeloRef: "1".repeat(40),
  tapCatalogRef: "2".repeat(40),
  tapMirrorAuthorityRef: "3".repeat(40),
  tapCallerAuthorityRef: "4".repeat(40),
  canaryRef: "5".repeat(40),
};

test("creates and revalidates one separate immutable lifecycle-input handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "homebrew-lifecycle-publication-"));
  try {
    const inputs = createInputs(root);
    const out = join(root, "handoff");
    const identity = createHomebrewGuestLifecyclePublication({
      ...inputs,
      ...refs,
      out,
    });
    assert.match(identity.collectionSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      identity.releaseRoot,
      "https://github.com/kandelo-dev/homebrew-tap-core/releases/download/" +
        `${identity.tag}/`,
    );
    assert.deepEqual(
      verifyHomebrewGuestLifecyclePublication({
        root: out,
        bottleMirrorPlan: inputs.bottleMirrorPlan,
        ...refs,
      }),
      identity,
    );

    const manifest = JSON.parse(
      readFileSync(join(out, "publish.json"), "utf8"),
    );
    assert.equal(manifest.repository, "kandelo-dev/homebrew-tap-core");
    assert.equal(manifest.target_commitish, refs.tapCallerAuthorityRef);
    assert.match(
      manifest.body,
      /verified support-data bottle.*\/opt\/kandelo\/homebrew/,
    );
    const handoff = JSON.parse(
      readFileSync(join(out, "handoff.json"), "utf8"),
    );
    assert.deepEqual(handoff.bootstrap, {
      state: "formula-owned",
      source_kind: "homebrew-support-data-bottle",
      package: "homebrew-bootstrap",
      guest_prefix: "/opt/kandelo/homebrew",
      stable_entrypoint: "/usr/bin/brew",
    });
    assert.deepEqual(
      manifest.assets.map((asset: { name: string }) => asset.name),
      [
        "main-shell.vfs.zst",
        "main-shell-brew-package-tree.json",
        "homebrew-bootstrap.zip",
        "homebrew-brew.env",
      ],
    );
    assert.ok(
      !manifest.assets.some(
        (asset: { name: string }) =>
          asset.name === HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
      ),
      "the lifecycle-input release must not absorb the bottle-layer mirror",
    );

    const staged = join(root, "staged");
    const normalized = join(root, "normalized.json");
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const validation = spawnSync(
      "python3",
      [
        join(
          repositoryRoot,
          "scripts/validate-immutable-github-release-manifest.py",
        ),
        "--manifest",
        join(out, "publish.json"),
        "--asset-root",
        out,
        "--stage-dir",
        staged,
        "--out-manifest",
        normalized,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(
      validation.status,
      0,
      `${validation.stdout}\n${validation.stderr}`,
    );
    const shellValidation = runShellVerifier(out, inputs.bottleMirrorPlan);
    assert.equal(
      shellValidation.status,
      0,
      `${shellValidation.stdout}\n${shellValidation.stderr}`,
    );

    writeFileSync(join(out, "homebrew-brew.env"), "changed\n");
    assert.throws(
      () =>
        verifyHomebrewGuestLifecyclePublication({
          root: out,
          bottleMirrorPlan: inputs.bottleMirrorPlan,
          ...refs,
        }),
      /publication manifest differs/,
    );
    assert.notEqual(
      runShellVerifier(out, inputs.bottleMirrorPlan).status,
      0,
      "shell verification accepted changed lifecycle-input bytes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds the publication identity to exact refs and bottle plan", () => {
  const root = mkdtempSync(join(tmpdir(), "homebrew-lifecycle-identity-"));
  try {
    const inputs = createInputs(root);
    const out = join(root, "handoff");
    createHomebrewGuestLifecyclePublication({
      ...inputs,
      ...refs,
      out,
    });
    assert.throws(
      () =>
        verifyHomebrewGuestLifecyclePublication({
          root: out,
          bottleMirrorPlan: inputs.bottleMirrorPlan,
          ...refs,
          canaryRef: "6".repeat(40),
        }),
      /publication manifest differs/,
    );
    assert.throws(
      () =>
        verifyHomebrewGuestLifecyclePublication({
          root: out,
          bottleMirrorPlan: inputs.bottleMirrorPlan,
          ...refs,
          tapMirrorAuthorityRef: "7".repeat(40),
        }),
      /publication manifest differs/,
    );
    assert.throws(
      () =>
        verifyHomebrewGuestLifecyclePublication({
          root: out,
          bottleMirrorPlan: inputs.bottleMirrorPlan,
          ...refs,
          tapCallerAuthorityRef: refs.tapMirrorAuthorityRef,
        }),
      /must be distinct commits/,
    );

    const changedPlan = join(root, "changed-plan.json");
    const original = JSON.parse(
      readFileSync(inputs.bottleMirrorPlan, "utf8"),
    ) as HomebrewBottleMirrorPlan;
    const changedPayload = new Uint8Array([8, 9, 10]);
    const changedPackageIdentity = {
      id: original.assets[0]!.id,
      package: original.assets[0]!.package,
      asset: original.assets[0]!.asset,
      sha256: sha256(changedPayload),
      bytes: changedPayload.byteLength,
    };
    const changedCollection = sha256(
      encodeHomebrewBottleMirrorCollectionIdentity(original.repository, [
        changedPackageIdentity,
      ]),
    );
    const changedTag = `homebrew-shell-bottles-sha256-${changedCollection}`;
    const changedReleaseRoot =
      `https://github.com/${original.repository}/releases/download/` +
      changedTag;
    writeFileSync(
      changedPlan,
      encodeHomebrewBottleMirrorPlan({
        ...original,
        collection_sha256: changedCollection,
        tag: changedTag,
        release_root: changedReleaseRoot,
        assets: [
          {
            ...changedPackageIdentity,
            url: `${changedReleaseRoot}/${changedPackageIdentity.asset}`,
          },
        ],
      }),
    );
    assert.throws(
      () =>
        verifyHomebrewGuestLifecyclePublication({
          root: out,
          bottleMirrorPlan: changedPlan,
          ...refs,
        }),
      /publication manifest differs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createInputs(root: string) {
  const inputRoot = join(root, "inputs");
  mkdirSync(inputRoot);
  const image = write(inputRoot, "candidate.vfs.zst", new Uint8Array([1, 2]));
  const bootstrapSpec = write(
    inputRoot,
    "package-tree.json",
    new Uint8Array([3]),
  );
  const bootstrapArchive = write(inputRoot, "source.zip", new Uint8Array([4]));
  const bootstrapEnvironment = write(
    inputRoot,
    "source.env",
    new Uint8Array([5]),
  );
  const payload = new Uint8Array([6, 7]);
  const packageIdentity = {
    id: "test",
    package: "kandelo-dev/tap-core/test",
    asset: homebrewRuntimeLayerPayloadAsset("test"),
    sha256: sha256(payload),
    bytes: payload.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(
      "kandelo-dev/homebrew-tap-core",
      [packageIdentity],
    ),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot =
    "https://github.com/kandelo-dev/homebrew-tap-core/releases/download/" + tag;
  const plan: HomebrewBottleMirrorPlan = {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository: "kandelo-dev/homebrew-tap-core",
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [
      {
        ...packageIdentity,
        url: `${releaseRoot}/${packageIdentity.asset}`,
      },
    ],
  };
  const bottleMirrorPlan = write(
    inputRoot,
    HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    encodeHomebrewBottleMirrorPlan(plan),
  );
  return {
    image,
    bootstrapSpec,
    bootstrapArchive,
    bootstrapEnvironment,
    bottleMirrorPlan,
  };
}

function write(root: string, name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runShellVerifier(root: string, bottleMirrorPlan: string) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return spawnSync(
    "bash",
    [
      join(
        repositoryRoot,
        "scripts/verify-homebrew-guest-lifecycle-publication.sh",
      ),
      "--root",
      root,
      "--bottle-mirror-plan",
      bottleMirrorPlan,
      "--kandelo-ref",
      refs.kandeloRef,
      "--tap-catalog-ref",
      refs.tapCatalogRef,
      "--tap-mirror-authority-ref",
      refs.tapMirrorAuthorityRef,
      "--tap-caller-authority-ref",
      refs.tapCallerAuthorityRef,
      "--canary-ref",
      refs.canaryRef,
    ],
    { encoding: "utf8", env },
  );
}
