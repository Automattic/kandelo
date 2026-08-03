import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createTransitionalPagesShellFetchPlan,
  inspectTransitionalPagesShell,
} from "./inspect-transitional-homebrew-pages-shell";

const lock = JSON.parse(
  readFileSync(
    new URL(
      "../homebrew/transitional-pages-shell-rev22-lock.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

test("derives only the locked public release reads", () => {
  const plan = createTransitionalPagesShellFetchPlan(lock);
  const gallery = plan.gallery_compatibility as Array<{
    archive: { url: string };
  }>;
  const sourceProjection = plan.source_projection_compatibility as Array<{
    archive: { url: string };
  }>;
  assert.deepEqual(
    [
      (plan.shell_archive as { url: string }).url,
      (plan.bootstrap_archive as { url: string }).url,
      ...gallery.map(({ archive }) => archive.url),
      ...sourceProjection.map(({ archive }) => archive.url),
      (plan.mirror_plan as { url: string }).url,
    ],
    [
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "shell-0.1.0-rev22-abi42-wasm32-25d260da.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "homebrew-bootstrap-6.0.3-4-g4ead861-rev3-abi42-wasm32-" +
        "1ec4e97d.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "lamp-0.1.0-rev11-abi42-wasm32-71448393.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "nginx-php-vfs-0.1.0-rev2-abi42-wasm32-35a5f89c.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "nginx-vfs-0.1.0-rev2-abi42-wasm32-a9f6fb18.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "node-vfs-0.1.0-rev14-abi42-wasm32-80d64061.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "wordpress-7.0-rev12-abi42-wasm32-ff4ab900.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "kandelo-sdk-0.1.0-rev4-abi42-wasm32-5d2aa9c9.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "mariadb-test-0.1.0-rev5-abi42-wasm32-a967a54c.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "mariadb-vfs-0.1.0-rev6-abi42-wasm32-2eb50e31.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "mariadb-vfs-0.1.0-rev6-abi42-wasm64-884db9a8.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "redis-vfs-0.1.0-rev2-abi42-wasm32-f16e5aa9.tar.zst",
      "https://github.com/Automattic/kandelo/releases/download/" +
        "binaries-abi-v42/" +
        "rootfs-0.1.0-rev9-abi42-wasm32-8712ba10.tar.zst",
      "https://github.com/Kandelo-dev/homebrew-tap-core/releases/" +
        "download/homebrew-shell-bottles-sha256-" +
        "fd15162a8c9c06e6d7936af470cd16ba916528708356750751b55bac567a0ce2/" +
        "kandelo-homebrew-bottle-mirror-plan.json",
    ],
  );
});

test("rejects an expanded or redirected transition lock", () => {
  const projectionAssets = (
    candidate: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    const projection = candidate.source_projection_compatibility as {
      assets: Array<Record<string, unknown>>;
    };
    return projection.assets;
  };
  const projectionArchive = (
    candidate: Record<string, unknown>,
    index = 0,
  ): Record<string, unknown> =>
    projectionAssets(candidate)[index]!.archive as Record<string, unknown>;
  const cases: Array<(candidate: Record<string, unknown>) => void> = [
    (candidate) => {
      candidate.unreviewed = true;
    },
    (candidate) => {
      (candidate.package_release as Record<string, unknown>).repository =
        "someone/else";
    },
    (candidate) => {
      (candidate.package_release as Record<string, unknown>).authority =
        "trust-the-tag";
    },
    (candidate) => {
      candidate.guest_prefix = "/opt/kandelo/homebrew";
    },
    (candidate) => {
      (candidate.bottle_mirror as Record<string, unknown>).immutable = false;
    },
    (candidate) => {
      projectionAssets(candidate).pop();
    },
    (candidate) => {
      projectionAssets(candidate)[0]!.package = "wrong-package";
    },
    (candidate) => {
      projectionAssets(candidate)[0]!.arch = "wasm64";
    },
    (candidate) => {
      projectionAssets(candidate)[0]!.output = "wrong-output.vfs.zst";
    },
    (candidate) => {
      projectionArchive(candidate).member = "artifacts/wrong.vfs.zst";
    },
    (candidate) => {
      projectionArchive(candidate).member_sha256 = "invalid";
    },
    (candidate) => {
      projectionArchive(candidate).member_bytes = 0;
    },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(lock);
    mutate(candidate);
    assert.throws(
      () => createTransitionalPagesShellFetchPlan(candidate),
      /invalid|unsupported fields/,
    );
  }
});

test("checks package identity before parsing candidate image bytes", () => {
  assert.throws(
    () =>
      inspectTransitionalPagesShell({
        lock,
        shellArchive: new Uint8Array([1]),
        image: new Uint8Array([2]),
        bootstrapArchive: new Uint8Array([3]),
        bootstrapZip: new Uint8Array([4]),
        bootstrapEnvironment: new Uint8Array([5]),
        mirrorPlan: new Uint8Array([6]),
        galleryCompatibility: [],
        sourceProjectionCompatibility: [],
      }),
    /shell package archive differs from its locked identity/,
  );
});
