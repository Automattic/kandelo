import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
import {
  HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
} from "./homebrew_guest_lifecycle_contract";
import {
  type HomebrewGuestLifecycleMachine,
  runHomebrewGuestLifecycle,
} from "./homebrew_guest_lifecycle_runner";
import type {
  HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

test("runs one shared lifecycle contract across export and reboot", async () => {
  const bootstrapUrl = "https://example.test/homebrew-bootstrap.zip";
  const exportedImage = await createExportedImage();
  const scripts: Array<{ phase: string; marker: string; script: string }> = [];
  const runtime: HomebrewGuestLifecycleRuntimeInputs = {
    imageBytes: new Uint8Array([1]),
    shellBytes: new Uint8Array([0, 97, 115, 109]),
    shellArgv0: "bash",
    lazyUrlBase: "https://example.test/",
    bootstrapTransportUrl: bootstrapUrl,
    bootstrapBytes: 7,
  };

  const result = await runHomebrewGuestLifecycle({
    runtime,
    revisions: {
      coreRevision: "1".repeat(40),
      canaryRevision: "2".repeat(40),
    },
    timeoutMs: 1_000,
    createMachine: (_machineRuntime, phase) => {
      const events: LazyDownloadEvent[] = [];
      return {
        lazyDownloads: events,
        diagnostics: [],
        start: async () => {},
        runShellScript: async ({ marker, script }) => {
          scripts.push({ phase, marker, script });
          if (marker === HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER) {
            events.push(
              event(bootstrapUrl, "started", 0),
              event(bootstrapUrl, "complete", 7),
            );
          }
        },
        exportRootfsImage: async () => exportedImage,
        destroy: async () => {},
      };
    },
  });

  assert.deepEqual([...result.phaseOneCompletedUrls], [bootstrapUrl]);
  assert.deepEqual(result.exportedImage, exportedImage);
  assert.equal(scripts.length, 3);
  assert.deepEqual(
    scripts.map(({ phase, marker }) => ({ phase, marker })),
    [
      { phase: "phase-one", marker: "homebrew-lifecycle-offline-ok" },
      {
        phase: "phase-one",
        marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
      },
      {
        phase: "phase-two",
        marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
      },
    ],
  );
  assert.match(scripts[1]!.script, /brew install --no-ask --force-bottle/);
  assert.match(scripts[1]!.script, /brew reinstall --force-bottle/);
  assert.match(scripts[2]!.script, /brew upgrade --force-bottle/);
  assert.match(scripts[2]!.script, /brew uninstall /);
  assert.match(scripts[2]!.script, /brew untap/);
});

test("rejects a preflight that materializes a supposedly image-owned shell", async () => {
  const runtime: HomebrewGuestLifecycleRuntimeInputs = {
    imageBytes: new Uint8Array([1]),
    shellBytes: new Uint8Array([0, 97, 115, 109]),
    shellArgv0: "bash",
    lazyUrlBase: "https://example.test/",
    bootstrapTransportUrl: "https://example.test/homebrew-bootstrap.zip",
    bootstrapBytes: 1,
  };
  await assert.rejects(
    () =>
      runHomebrewGuestLifecycle({
        runtime,
        revisions: {
          coreRevision: "1".repeat(40),
          canaryRevision: "2".repeat(40),
        },
        timeoutMs: 1_000,
        createMachine: () => {
          const events: LazyDownloadEvent[] = [];
          const machine: HomebrewGuestLifecycleMachine = {
            lazyDownloads: events,
            diagnostics: [],
            start: async () => {},
            runShellScript: async () => {
              events.push(
                event("https://example.test/bash.wasm", "complete", 1),
              );
            },
            exportRootfsImage: async () => new Uint8Array(),
            destroy: async () => {},
          };
          return machine;
        },
      }),
    /image-owned shell preflight unexpectedly fetched/,
  );
});

async function createExportedImage(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  fs.mkdir("/bin", 0o755);
  writeFile(
    fs,
    "/etc/kandelo/shell.json",
    new TextEncoder().encode(JSON.stringify({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    })),
  );
  writeFile(fs, "/bin/bash", new Uint8Array([0, 97, 115, 109]), 0o755);
  return fs.saveImage();
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
  status: "started" | "complete",
  loadedBytes: number,
): LazyDownloadEvent {
  return {
    id: url,
    kind: "tree",
    status,
    url,
    loadedBytes,
    t: 0,
  };
}
