import assert from "node:assert/strict";
import test from "node:test";

import { ABI_VERSION } from "../../host/src/generated/abi";
import {
  type LazyDownloadEvent,
  MemoryFileSystem,
} from "../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "../../host/src/vfs/image-helpers";
import type { HomebrewGuestLifecycleMachine } from
  "./homebrew_guest_lifecycle_runner";
import {
  HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER,
  runHomebrewFlatVfsStartupProof,
  runHomebrewFlatVfsShippingProof,
  validateHomebrewFlatVfsEmbeddedRuntime,
} from "./homebrew_flat_vfs_shipping_proof";

const textEncoder = new TextEncoder();
const TAP_REVISION = "1".repeat(40);
const SELECTION_SHA256 = "a".repeat(64);

test("runs one fully embedded core proof without transport inputs", async () => {
  const scripts: Array<{ marker: string; script: string }> = [];
  let started = false;
  let destroyed = false;
  const result = await runHomebrewFlatVfsShippingProof({
    runtime: {
      imageBytes: await createEmbeddedRuntimeImage(),
      shellPath: "/bin/bash",
      shellArgv0: "bash",
    },
    tapRevision: TAP_REVISION,
    deadlineMs: Date.now() + 1_000,
    createMachine: (runtime) => {
      assert.equal(runtime.lazyAssets, undefined);
      assert.match(runtime.lazyUrlBase, /^https:\/\/.*\.invalid\//);
      const machine: HomebrewGuestLifecycleMachine = {
        lazyDownloads: [],
        diagnostics: [],
        start: async () => {
          started = true;
        },
        readFile: async () => {
          throw new Error("embedded shipping proof must not read reboot state");
        },
        runShellScript: async ({ marker, script }) => {
          scripts.push({ marker, script });
        },
        exportRootfsImage: async () => {
          throw new Error("embedded shipping proof must not export the rootfs");
        },
        destroy: async () => {
          destroyed = true;
        },
      };
      return machine;
    },
  });

  assert.equal(started, true);
  assert.equal(destroyed, true);
  assert.deepEqual(result, {
    tapRevision: TAP_REVISION,
    kandeloAbi: ABI_VERSION,
    selectionSha256: SELECTION_SHA256,
    lazyDownloads: [],
  });
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0]!.marker, HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER);
  assert.match(scripts[0]!.script, /\/usr\/bin\/brew --version/);
  assert.match(scripts[1]!.script, new RegExp(TAP_REVISION));
  assert.match(scripts[1]!.script, /brew uninstall --ignore-dependencies/);
  assert.match(scripts[1]!.script, /brew install --no-ask --force-bottle/);
  assert.match(scripts[1]!.script, /assert_poured/);
  assert.match(scripts[1]!.script, /assert_bzip2_roundtrip/);
  assert.doesNotMatch(scripts[1]!.script, /m4-canary/);
});

test("runs only bounded embedded startup without the stock lifecycle", async () => {
  const scripts: Array<{ marker: string; script: string }> = [];
  let started = false;
  let destroyed = false;
  const result = await runHomebrewFlatVfsStartupProof({
    runtime: {
      imageBytes: await createEmbeddedRuntimeImage(),
      shellPath: "/bin/bash",
      shellArgv0: "bash",
    },
    tapRevision: TAP_REVISION,
    deadlineMs: Date.now() + 1_000,
    createMachine: (runtime) => {
      assert.equal(runtime.lazyAssets, undefined);
      assert.match(runtime.lazyUrlBase, /^https:\/\/.*\.invalid\//);
      return {
        lazyDownloads: [],
        diagnostics: [],
        start: async () => {
          started = true;
        },
        readFile: async () => null,
        runShellScript: async ({ marker, script }) => {
          scripts.push({ marker, script });
        },
        exportRootfsImage: async () => new Uint8Array(),
        destroy: async () => {
          destroyed = true;
        },
      };
    },
  });

  assert.equal(started, true);
  assert.equal(destroyed, true);
  assert.deepEqual(result, {
    tapRevision: TAP_REVISION,
    kandeloAbi: ABI_VERSION,
    selectionSha256: SELECTION_SHA256,
    lazyDownloads: [],
  });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]!.marker, HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER);
  assert.match(scripts[0]!.script, /\/usr\/bin\/brew --version/);
  assert.doesNotMatch(
    scripts[0]!.script,
    /brew tap|brew install|brew uninstall|assert_poured/,
  );
});

test("bounds startup failures and always tears the machine down", async (t) => {
  for (const scenario of [
    {
      name: "version failure",
      runShellScript: async () => {
        throw new Error("embedded startup version failed");
      },
      failure: /embedded startup version failed/,
    },
    {
      name: "stalled version",
      runShellScript: () => new Promise<void>(() => {}),
      failure: /exceeded the Homebrew guest lifecycle total deadline/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      let destroyed = false;
      const imageBytes = await createEmbeddedRuntimeImage();
      await assert.rejects(
        () => runHomebrewFlatVfsStartupProof({
          runtime: {
            imageBytes,
            shellPath: "/bin/bash",
            shellArgv0: "bash",
          },
          tapRevision: TAP_REVISION,
          deadlineMs: Date.now() + (scenario.name === "stalled version" ? 20 : 1_000),
          createMachine: () => ({
            lazyDownloads: [],
            diagnostics: [],
            start: async () => {},
            readFile: async () => null,
            runShellScript: scenario.runShellScript,
            exportRootfsImage: async () => new Uint8Array(),
            destroy: async () => {
              destroyed = true;
            },
          }),
        }),
        scenario.failure,
      );
      assert.equal(destroyed, true);
    });
  }
});

test("rejects startup diagnostics and lazy downloads", async (t) => {
  await t.test("host diagnostic", async () => {
    const diagnostics: string[] = [];
    let destroyed = false;
    const imageBytes = await createEmbeddedRuntimeImage();
    await assert.rejects(
      () => runHomebrewFlatVfsStartupProof({
        runtime: {
          imageBytes,
          shellPath: "/bin/bash",
          shellArgv0: "bash",
        },
        tapRevision: TAP_REVISION,
        deadlineMs: Date.now() + 1_000,
        createMachine: () => ({
          lazyDownloads: [],
          diagnostics,
          start: async () => {},
          readFile: async () => null,
          runShellScript: async () => {
            diagnostics.push("pid=9 source=process-worker: trapped");
          },
          exportRootfsImage: async () => new Uint8Array(),
          destroy: async () => {
            destroyed = true;
          },
        }),
      }),
      /unexpected host diagnostics/,
    );
    assert.equal(destroyed, true);
  });

  await t.test("lazy download", async () => {
    const lazyDownloads: LazyDownloadEvent[] = [];
    let destroyed = false;
    const imageBytes = await createEmbeddedRuntimeImage();
    await assert.rejects(
      () => runHomebrewFlatVfsStartupProof({
        runtime: {
          imageBytes,
          shellPath: "/bin/bash",
          shellArgv0: "bash",
        },
        tapRevision: TAP_REVISION,
        deadlineMs: Date.now() + 1_000,
        createMachine: () => ({
          lazyDownloads,
          diagnostics: [],
          start: async () => {},
          readFile: async () => null,
          runShellScript: async () => {
            lazyDownloads.push({
              id: "unexpected-startup-fetch",
              kind: "tree",
              status: "started",
              url: "https://example.test/startup.tar.gz",
              loadedBytes: 0,
              t: 0,
            });
          },
          exportRootfsImage: async () => new Uint8Array(),
          destroy: async () => {
            destroyed = true;
          },
        }),
      }),
      /unexpectedly fetched https:\/\/example\.test\/startup\.tar\.gz/,
    );
    assert.equal(destroyed, true);
  });
});

test("preserves bounded machine failures and always tears the machine down", async (t) => {
  for (const scenario of [
    {
      name: "missing marker",
      error: "embedded proof marker is missing",
    },
    {
      name: "nonzero exit",
      error: "embedded proof exited 9",
    },
    {
      name: "output bound",
      error: "embedded proof exceeded the 8388608-byte output limit",
    },
  ]) {
    await t.test(scenario.name, async () => {
      let destroyed = false;
      const imageBytes = await createEmbeddedRuntimeImage();
      await assert.rejects(
        () =>
          runHomebrewFlatVfsShippingProof({
            runtime: {
              imageBytes,
              shellPath: "/bin/bash",
              shellArgv0: "bash",
            },
            tapRevision: TAP_REVISION,
            deadlineMs: Date.now() + 1_000,
            createMachine: () => ({
              lazyDownloads: [],
              diagnostics: [],
              start: async () => {},
              readFile: async () => null,
              runShellScript: async () => {
                throw new Error(scenario.error);
              },
              exportRootfsImage: async () => new Uint8Array(),
              destroy: async () => {
                destroyed = true;
              },
            }),
          }),
        new RegExp(scenario.error),
      );
      assert.equal(destroyed, true);
    });
  }
});

test("bounds a stalled embedded proof with the shared absolute deadline", async () => {
  let destroyed = false;
  const imageBytes = await createEmbeddedRuntimeImage();
  await assert.rejects(
    () =>
      runHomebrewFlatVfsShippingProof({
        runtime: {
          imageBytes,
          shellPath: "/bin/bash",
          shellArgv0: "bash",
        },
        tapRevision: TAP_REVISION,
        deadlineMs: Date.now() + 20,
        createMachine: () => ({
          lazyDownloads: [],
          diagnostics: [],
          failureContext: () => "stdout tail=\"brew install bzip2\"",
          start: async () => {},
          readFile: async () => null,
          runShellScript: () => new Promise<void>(() => {}),
          exportRootfsImage: async () => new Uint8Array(),
          destroy: async () => {
            destroyed = true;
          },
        }),
      }),
    /exceeded the Homebrew guest lifecycle total deadline.*brew install bzip2/,
  );
  assert.equal(destroyed, true);
});

test("rejects diagnostics and every lazy download on the embedded path", async (t) => {
  await t.test("host diagnostic", async () => {
    const diagnostics: string[] = [];
    let destroyed = false;
    const imageBytes = await createEmbeddedRuntimeImage();
    await assert.rejects(
      () =>
        runHomebrewFlatVfsShippingProof({
          runtime: {
            imageBytes,
            shellPath: "/bin/bash",
            shellArgv0: "bash",
          },
          tapRevision: TAP_REVISION,
          deadlineMs: Date.now() + 1_000,
          createMachine: () => ({
            lazyDownloads: [],
            diagnostics,
            start: async () => {},
            readFile: async () => null,
            runShellScript: async () => {
              diagnostics.push("pid=7 source=process-worker: trapped");
            },
            exportRootfsImage: async () => new Uint8Array(),
            destroy: async () => {
              destroyed = true;
            },
          }),
        }),
      /unexpected host diagnostics/,
    );
    assert.equal(destroyed, true);
  });

  await t.test("lazy bottle download", async () => {
    const lazyDownloads: LazyDownloadEvent[] = [];
    let destroyed = false;
    const imageBytes = await createEmbeddedRuntimeImage();
    await assert.rejects(
      () =>
        runHomebrewFlatVfsShippingProof({
          runtime: {
            imageBytes,
            shellPath: "/bin/bash",
            shellArgv0: "bash",
          },
          tapRevision: TAP_REVISION,
          deadlineMs: Date.now() + 1_000,
          createMachine: () => ({
            lazyDownloads,
            diagnostics: [],
            start: async () => {},
            readFile: async () => null,
            runShellScript: async () => {
              lazyDownloads.push({
                id: "unexpected-bzip2",
                kind: "tree",
                status: "started",
                url: "https://example.test/bzip2.tar.gz",
                loadedBytes: 0,
                t: 0,
              });
            },
            exportRootfsImage: async () => new Uint8Array(),
            destroy: async () => {
              destroyed = true;
            },
          }),
        }),
      /unexpectedly fetched https:\/\/example\.test\/bzip2\.tar\.gz/,
    );
    assert.equal(destroyed, true);
  });
});

test("does not hide a successful proof behind a failed teardown", async () => {
  const imageBytes = await createEmbeddedRuntimeImage();
  await assert.rejects(
    () =>
      runHomebrewFlatVfsShippingProof({
        runtime: {
          imageBytes,
          shellPath: "/bin/bash",
          shellArgv0: "bash",
        },
        tapRevision: TAP_REVISION,
        deadlineMs: Date.now() + 1_000,
        createMachine: () => ({
          lazyDownloads: [],
          diagnostics: [],
          start: async () => {},
          readFile: async () => null,
          runShellScript: async () => {},
          exportRootfsImage: async () => new Uint8Array(),
          destroy: async () => {
            throw new Error("embedded machine teardown failed");
          },
        }),
      }),
    /embedded machine teardown failed/,
  );
});

test("rejects a non-exact tap revision before starting a guest", async () => {
  let machineCreated = false;
  const imageBytes = await createEmbeddedRuntimeImage();
  await assert.rejects(
    () =>
      runHomebrewFlatVfsShippingProof({
        runtime: {
          imageBytes,
          shellPath: "/bin/bash",
          shellArgv0: "bash",
        },
        tapRevision: "ABC",
        deadlineMs: Date.now() + 1_000,
        createMachine: () => {
          machineCreated = true;
          throw new Error("invalid tap revision reached machine creation");
        },
      }),
    /core revision must be an exact lowercase 40-character SHA/,
  );
  assert.equal(machineCreated, false);
});

test("validates the serialized image-owned shell, brew runtime, ABI, and report", async (t) => {
  for (const scenario of [
    {
      name: "missing image metadata",
      fixture: { imageMetadata: "missing" as const },
    },
    {
      name: "metadata without a kernel ABI",
      fixture: { imageMetadata: "without-kernel-abi" as const },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const imageBytes = await createEmbeddedRuntimeImage(scenario.fixture);
      assert.throws(
        () =>
          validateHomebrewFlatVfsEmbeddedRuntime({
            imageBytes,
            shellPath: "/bin/bash",
            shellArgv0: "bash",
          }),
        new RegExp(
          `must declare kernel ABI ${ABI_VERSION}`,
        ),
      );
    });
  }

  await t.test("shell identity", async () => {
    const imageBytes = await createEmbeddedRuntimeImage();
    assert.throws(
      () =>
        validateHomebrewFlatVfsEmbeddedRuntime({
          imageBytes,
          shellPath: "/bin/zsh",
          shellArgv0: "zsh",
        }),
      /shell is .*expected \/bin\/zsh \(zsh\)/,
    );
  });

  for (const scenario of [
    {
      name: "canonical brew link",
      fixture: { brewLinkTarget: "/tmp/fake-brew" },
      failure: /must be a symlink to \/opt\/kandelo\/homebrew\/bin\/brew/,
    },
    {
      name: "embedded brew executable",
      fixture: { deferredBrew: true },
      failure: /not image-owned and executable/,
    },
    {
      name: "current kernel ABI",
      fixture: { kernelAbi: ABI_VERSION + 1 },
      failure: /requires kernel ABI .*running kernel is ABI/,
    },
    {
      name: "flat report identity",
      fixture: { selectionSha256: "ABC" },
      failure: /report identity is invalid/,
    },
    {
      name: "Bzip2 selection",
      fixture: { includeBzip2: false },
      failure: /must select kandelo-dev\/tap-core\/bzip2 exactly once/,
    },
    {
      name: "tar selection",
      fixture: { includeTar: false },
      failure: /must select kandelo-dev\/tap-core\/tar exactly once/,
    },
    {
      name: "stable gzip extraction link",
      fixture: { omitExtractionCommand: "gzip" },
      failure: /\/usr\/bin\/gzip must be a symlink to \/opt\/kandelo\/homebrew\/bin\/gzip/,
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const imageBytes = await createEmbeddedRuntimeImage(scenario.fixture);
      assert.throws(
        () =>
          validateHomebrewFlatVfsEmbeddedRuntime({
            imageBytes,
            shellPath: "/bin/bash",
            shellArgv0: "bash",
          }),
        scenario.failure,
      );
    });
  }
});

async function createEmbeddedRuntimeImage(options: {
  brewLinkTarget?: string;
  deferredBrew?: boolean;
  kernelAbi?: number;
  imageMetadata?: "missing" | "without-kernel-abi";
  selectionSha256?: string;
  includeBzip2?: boolean;
  includeTar?: boolean;
  omitExtractionCommand?: "tar" | "gzip";
} = {}): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  for (const path of [
    "/bin",
    "/etc/kandelo",
    "/etc/homebrew",
    "/opt/kandelo/homebrew/bin",
    "/usr/bin",
  ]) {
    ensureDirRecursive(fs, path);
  }
  writeVfsFile(
    fs,
    "/etc/kandelo/shell.json",
    JSON.stringify({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    }),
    0o644,
  );
  writeVfsFile(fs, "/bin/bash", new Uint8Array([0, 97, 115, 109]), 0o755);
  if (options.deferredBrew === true) {
    fs.registerLazyFile(
      "/opt/kandelo/homebrew/bin/brew",
      "https://example.test/homebrew-bootstrap.zip",
      12,
      0o755,
    );
  } else {
    writeVfsFile(
      fs,
      "/opt/kandelo/homebrew/bin/brew",
      textEncoder.encode("#!/bin/bash\n"),
      0o755,
    );
  }
  fs.symlink(
    options.brewLinkTarget ?? "/opt/kandelo/homebrew/bin/brew",
    "/usr/bin/brew",
  );
  for (const command of ["tar", "gzip"] as const) {
    writeVfsFile(
      fs,
      `/opt/kandelo/homebrew/bin/${command}`,
      textEncoder.encode(`selected Homebrew ${command}\n`),
      0o755,
    );
    if (options.omitExtractionCommand !== command) {
      fs.symlink(
        `/opt/kandelo/homebrew/bin/${command}`,
        `/usr/bin/${command}`,
      );
    }
  }
  writeVfsFile(
    fs,
    "/etc/homebrew/brew.env",
    textEncoder.encode("HOMEBREW_NO_ANALYTICS=1\n"),
    0o644,
  );
  writeVfsFile(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    JSON.stringify({
      schema: 1,
      name: "experimental-abi42-test",
      arch: "wasm32",
      kandelo_abi: ABI_VERSION,
      selection_sha256: options.selectionSha256 ?? SELECTION_SHA256,
      requested_vfs_filename:
        "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      resource_policy: "kandelo-homebrew-vfs-generous-v1",
      link_policy: "kandelo-homebrew-link-ownership-v1",
      runtime_support: "kandelo-homebrew-bootstrap-v1",
      environment: { PATH: "/opt/kandelo/homebrew/bin" },
      link_owners: [],
      totals: {
        compressed_bytes: 1,
        expanded_bytes: 1,
        entries: 1,
        path_bytes: 1,
        link_bytes: 0,
      },
      packages: [
        { full_name: "kandelo-dev/tap-core/homebrew-bootstrap" },
        ...(options.includeBzip2 === false
          ? []
          : [{ full_name: "kandelo-dev/tap-core/bzip2" }]),
        ...(options.includeTar === false
          ? []
          : [{ full_name: "kandelo-dev/tap-core/tar" }]),
        { full_name: "kandelo-dev/tap-core/gzip" },
      ],
    }),
    0o644,
  );
  const metadata = options.imageMetadata === "missing"
    ? null
    : options.imageMetadata === "without-kernel-abi"
    ? { version: 1 as const }
    : { version: 1 as const, kernelAbi: options.kernelAbi ?? ABI_VERSION };
  return fs.saveImage({ metadata });
}
