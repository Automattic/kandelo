import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  snapshotClosedLazyAssets,
  type ClosedLazyAsset,
} from "../../host/src/vfs/closed-lazy-assets";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
  type LazyDownloadStatus,
} from "../../host/src/vfs/memory-fs";
import {
  assertHomebrewGuestLifecycleCatalog,
  assertNoRepeatedLazyDownloads,
  assertNoUnexpectedHostDiagnostics,
  completedLazyDownloadUrls,
  omitCompletedClosedLazyAssets,
  resolveHomebrewGuestLifecycleShell,
} from "./homebrew_guest_lifecycle_runtime_contract";

const textEncoder = new TextEncoder();

test("binds the lifecycle revision to the exact embedded core catalog", () => {
  const revision = "1".repeat(40);
  const manifest = {
    schema: 1,
    catalog: {
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      checkout_commit: revision,
    },
  };
  assert.doesNotThrow(() =>
    assertHomebrewGuestLifecycleCatalog(manifest, revision)
  );

  for (const [key, value, message] of [
    ["tap_repository", "someone/else", "tap_repository"],
    ["tap_name", "someone/else", "tap_name"],
    ["checkout_commit", "2".repeat(40), "checkout_commit"],
  ] as const) {
    const changed = structuredClone(manifest);
    changed.catalog[key] = value;
    assert.throws(
      () => assertHomebrewGuestLifecycleCatalog(changed, revision),
      new RegExp(message),
    );
  }
});

test("resolves the image-owned shell from the rebooted filesystem", async () => {
  const source = createShellFileSystem(new Uint8Array([0, 97, 115, 109]));
  const rebooted = MemoryFileSystem.fromImage(await source.saveImage());
  const resolved = resolveHomebrewGuestLifecycleShell(rebooted);

  assert.deepEqual(resolved, {
    bytes: new Uint8Array([0, 97, 115, 109]),
    argv0: "bash",
  });
});

test("rejects a shell that export left deferred or non-executable", () => {
  const deferred = createBaseFileSystem();
  writeFile(
    deferred,
    "/etc/kandelo/shell.json",
    textEncoder.encode(JSON.stringify({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    })),
  );
  deferred.registerLazyFile(
    "/bin/bash",
    "https://example.test/bash.wasm",
    123,
    0o755,
  );
  assert.throws(
    () => resolveHomebrewGuestLifecycleShell(deferred),
    /must be image-owned.*deferred/,
  );

  const nonExecutable = createShellFileSystem(new Uint8Array([1]), 0o644);
  assert.throws(
    () => resolveHomebrewGuestLifecycleShell(nonExecutable),
    /not an executable regular file/,
  );
});

test("removes phase-one materialized assets and rejects every repeated event", () => {
  const firstUrl = "https://example.test/first";
  const secondUrl = "https://example.test/second";
  const phaseOne = [
    event(firstUrl, "started"),
    event(firstUrl, "complete"),
    event(secondUrl, "complete"),
  ];
  const completed = completedLazyDownloadUrls(phaseOne);
  assert.deepEqual([...completed], [firstUrl, secondUrl]);

  const assets: ClosedLazyAsset[] = [
    asset(firstUrl, 1),
    asset(secondUrl, 2),
    asset("https://example.test/unopened", 3),
  ];
  assert.deepEqual(
    omitCompletedClosedLazyAssets(assets, completed),
    [assets[2]],
  );
  const allCompleted = new Set(assets.map(({ url }) => url));
  const guarded = omitCompletedClosedLazyAssets(assets, allCompleted);
  assert.equal(guarded?.length, 1);
  assert.ok(!allCompleted.has(guarded![0]!.url));
  assert.equal(
    createHash("sha256").update(guarded![0]!.bytes).digest("hex"),
    guarded![0]!.sha256,
  );
  assert.doesNotThrow(() => snapshotClosedLazyAssets(guarded!));
  assert.doesNotThrow(() =>
    assertNoRepeatedLazyDownloads(
      completed,
      [event("https://example.test/unopened", "complete")],
      "reboot",
    )
  );
  for (const status of [
    "started",
    "progress",
    "complete",
    "error",
  ] as const) {
    assert.throws(
      () =>
        assertNoRepeatedLazyDownloads(
          completed,
          [event(firstUrl, status)],
          "reboot",
        ),
      new RegExp(`phase-one materialized URL ${firstUrl}.*status ${status}`),
    );
  }
});

test("fails closed on every host diagnostic", () => {
  assert.doesNotThrow(() =>
    assertNoUnexpectedHostDiagnostics([], "lifecycle")
  );
  for (const diagnostic of [
    "ordinary protocol failure",
    "bytes 65536..131072 (FORK_SAVE_BUFFER_SIZE) are reserved",
  ]) {
    assert.throws(
      () => assertNoUnexpectedHostDiagnostics([diagnostic], "lifecycle"),
      /unexpected host diagnostics/,
    );
  }
});

function createBaseFileSystem(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  fs.mkdir("/bin", 0o755);
  return fs;
}

function createShellFileSystem(
  bytes: Uint8Array,
  mode = 0o755,
): MemoryFileSystem {
  const fs = createBaseFileSystem();
  writeFile(
    fs,
    "/etc/kandelo/shell.json",
    textEncoder.encode(JSON.stringify({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    })),
  );
  writeFile(fs, "/bin/bash", bytes, mode);
  return fs;
}

function writeFile(
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode = 0o644,
): void {
  const fd = fs.open(path, 0o1101, mode);
  try {
    assert.equal(fs.write(fd, bytes, null, bytes.byteLength), bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

function event(
  url: string,
  status: LazyDownloadStatus,
): LazyDownloadEvent {
  return {
    id: url,
    kind: "tree",
    status,
    url,
    loadedBytes: status === "complete" ? 1 : 0,
    t: 0,
  };
}

function asset(url: string, byte: number): ClosedLazyAsset {
  return {
    url,
    sha256: byte.toString(16).padStart(64, "0"),
    size: 1,
    bytes: new Uint8Array([byte]),
  };
}
