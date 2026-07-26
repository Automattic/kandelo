import assert from "node:assert/strict";
import test from "node:test";

import type { LazyDownloadEvent } from "../../host/src/vfs/memory-fs";
import {
  HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
} from "./homebrew_guest_lifecycle_contract";
import {
  type HomebrewGuestLifecycleMachine,
  runHomebrewGuestLifecycle,
  runHomebrewGuestLifecycleProcess,
} from "./homebrew_guest_lifecycle_runner";
import type {
  HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

test("runs one shared lifecycle contract across export and reboot", async () => {
  const bootstrapUrl = "https://example.test/homebrew-bootstrap.zip";
  const exportedImage = new Uint8Array([9, 8, 7]);
  const scripts: Array<{ phase: string; marker: string; script: string }> = [];
  const phaseImages: Array<{
    phase: string;
    beforeTransfer: number;
    afterTransfer: number;
  }> = [];
  const runtime: HomebrewGuestLifecycleRuntimeInputs = {
    imageBytes: new Uint8Array([1]),
    shellPath: "/bin/bash",
    shellArgv0: "bash",
    takeImageOwnership: true,
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
    deadlineMs: Date.now() + 1_000,
    hashExportedImage: async (image) => {
      assert.equal(image, exportedImage);
      assert.equal(image.byteLength, 3);
      return "a".repeat(64);
    },
    createMachine: (machineRuntime, phase) => {
      const events: LazyDownloadEvent[] = [];
      return {
        lazyDownloads: events,
        diagnostics: [],
        start: async () => {
          const beforeTransfer = machineRuntime.imageBytes.byteLength;
          structuredClone(machineRuntime.imageBytes.buffer, {
            transfer: [machineRuntime.imageBytes.buffer as ArrayBuffer],
          });
          phaseImages.push({
            phase,
            beforeTransfer,
            afterTransfer: machineRuntime.imageBytes.byteLength,
          });
        },
        readFile: async () =>
          phase === "phase-two"
            ? shellConfigBytes("/bin/reboot-bash", "reboot-bash")
            : shellConfigBytes(),
        runShellScript: async ({ shellPath, marker, script }) => {
          assert.equal(
            shellPath,
            phase === "phase-two" ? "/bin/reboot-bash" : "/bin/bash",
          );
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
  assert.equal(result.exportedImageBytes, 3);
  assert.equal(result.exportedImageSha256, "a".repeat(64));
  assert.deepEqual(phaseImages, [
    { phase: "phase-one", beforeTransfer: 1, afterTransfer: 0 },
    { phase: "phase-two", beforeTransfer: 3, afterTransfer: 0 },
  ]);
  assert.equal(scripts.length, 4);
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
        marker: "homebrew-lifecycle-reboot-shell-ok",
      },
      {
        phase: "phase-two",
        marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
      },
    ],
  );
  assert.ok(scripts[0]!.script.includes("test -x '/bin/bash'"));
  assert.ok(scripts[2]!.script.includes("test -x '/bin/reboot-bash'"));
  assert.match(scripts[1]!.script, /brew install --no-ask --force-bottle/);
  assert.match(scripts[1]!.script, /brew reinstall --force-bottle/);
  assert.match(scripts[3]!.script, /brew upgrade --force-bottle/);
  assert.match(scripts[3]!.script, /brew uninstall /);
  assert.match(scripts[3]!.script, /brew untap/);
});

test("rejects a preflight that materializes a supposedly image-owned shell", async () => {
  const runtime: HomebrewGuestLifecycleRuntimeInputs = {
    imageBytes: new Uint8Array([1]),
    shellPath: "/bin/bash",
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
        deadlineMs: Date.now() + 1_000,
        createMachine: () => {
          const events: LazyDownloadEvent[] = [];
          const machine: HomebrewGuestLifecycleMachine = {
            lazyDownloads: events,
            diagnostics: [],
            start: async () => {},
            readFile: async () => shellConfigBytes(),
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

test("spends one decreasing deadline budget across both lifecycle phases", async () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const timeouts: number[] = [];
  const bootstrapUrl = "https://example.test/bootstrap.zip";
  try {
    await runHomebrewGuestLifecycle({
      runtime: {
        imageBytes: new Uint8Array([1]),
        shellPath: "/bin/bash",
        shellArgv0: "bash",
        lazyUrlBase: "https://example.test/",
        bootstrapTransportUrl: bootstrapUrl,
        bootstrapBytes: 1,
      },
      revisions: {
        coreRevision: "1".repeat(40),
        canaryRevision: "2".repeat(40),
      },
      deadlineMs: 2_000,
      createMachine: (_runtime, phase) => {
        const events: LazyDownloadEvent[] = [];
        return {
          lazyDownloads: events,
          diagnostics: [],
          start: async () => {
            now += 100;
          },
          readFile: async () => {
            now += 10;
            return shellConfigBytes();
          },
          runShellScript: async ({ marker, timeoutMs }) => {
            timeouts.push(timeoutMs);
            now += 100;
            if (
              phase === "phase-one" &&
              marker === HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER
            ) {
              events.push(
                event(bootstrapUrl, "started", 0),
                event(bootstrapUrl, "complete", 1),
              );
            }
          },
          exportRootfsImage: async () => {
            now += 100;
            return new Uint8Array([2]);
          },
          destroy: async () => {
            now += 10;
          },
        };
      },
    });
  } finally {
    Date.now = realNow;
  }

  assert.equal(timeouts.length, 4);
  for (let index = 1; index < timeouts.length; index += 1) {
    assert.ok(
      timeouts[index]! < timeouts[index - 1]!,
      `timeout ${index} did not consume the prior phase's budget`,
    );
  }
});

test("does not report success when phase-two teardown exceeds the total deadline", async () => {
  const bootstrapUrl = "https://example.test/bootstrap.zip";
  await assert.rejects(
    () =>
      runHomebrewGuestLifecycle({
        runtime: {
          imageBytes: new Uint8Array([1]),
          shellPath: "/bin/bash",
          shellArgv0: "bash",
          lazyUrlBase: "https://example.test/",
          bootstrapTransportUrl: bootstrapUrl,
          bootstrapBytes: 1,
        },
        revisions: {
          coreRevision: "1".repeat(40),
          canaryRevision: "2".repeat(40),
        },
        deadlineMs: Date.now() + 100,
        createMachine: (_runtime, phase) => {
          const events: LazyDownloadEvent[] = [];
          return {
            lazyDownloads: events,
            diagnostics: [],
            start: async () => {},
            readFile: async () => shellConfigBytes(),
            runShellScript: async ({ marker }) => {
              if (
                phase === "phase-one" &&
                marker === HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER
              ) {
                events.push(
                  event(bootstrapUrl, "started", 0),
                  event(bootstrapUrl, "complete", 1),
                );
              }
            },
            exportRootfsImage: async () => new Uint8Array([2]),
            destroy: phase === "phase-two"
              ? () => new Promise<void>(() => {})
              : async () => {},
          };
        },
      }),
    /machine teardown exceeded the Homebrew guest lifecycle total deadline/,
  );
});

test("starts a process timeout before waiting for its spawn acknowledgement", async () => {
  let resolveSpawn:
    ((value: { pid: number; exit: Promise<number> }) => void) | undefined;
  let terminateCalls = 0;
  const spawn = new Promise<{ pid: number; exit: Promise<number> }>((resolve) => {
    resolveSpawn = resolve;
  });
  await assert.rejects(
    () =>
      runHomebrewGuestLifecycleProcess({
        label: "stalled VFS spawn",
        timeoutMs: 5,
        spawn: () => spawn,
        terminate: async () => {
          terminateCalls += 1;
        },
      }),
    /stalled VFS spawn timed out after 5ms/,
  );
  resolveSpawn!({ pid: 42, exit: Promise.resolve(0) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    terminateCalls,
    0,
    "a late spawn acknowledgement must not resume a settled adapter",
  );
});

test("terminates a known process when the shared spawn-and-exit budget expires", async () => {
  const terminated: Array<{ pid: number; exitCode: number }> = [];
  await assert.rejects(
    () =>
      runHomebrewGuestLifecycleProcess({
        label: "stalled guest exit",
        timeoutMs: 5,
        spawn: async () => ({
          pid: 73,
          exit: new Promise<number>(() => {}),
        }),
        terminate: async (pid, exitCode) => {
          terminated.push({ pid, exitCode });
        },
      }),
    /stalled guest exit timed out after 5ms/,
  );
  assert.deepEqual(terminated, [{ pid: 73, exitCode: 124 }]);
});

test("revalidates the exported shell config inside the rebooted worker", async () => {
  const bootstrapUrl = "https://example.test/bootstrap.zip";
  await assert.rejects(
    () =>
      runHomebrewGuestLifecycle({
        runtime: {
          imageBytes: new Uint8Array([1]),
          shellPath: "/bin/bash",
          shellArgv0: "bash",
          lazyUrlBase: "https://example.test/",
          bootstrapTransportUrl: bootstrapUrl,
          bootstrapBytes: 1,
        },
        revisions: {
          coreRevision: "1".repeat(40),
          canaryRevision: "2".repeat(40),
        },
        deadlineMs: Date.now() + 1_000,
        createMachine: (_runtime, phase) => {
          const events: LazyDownloadEvent[] = [];
          return {
            lazyDownloads: events,
            diagnostics: [],
            start: async () => {},
            readFile: async () =>
              phase === "phase-two" ? null : shellConfigBytes(),
            runShellScript: async ({ marker }) => {
              if (marker === HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER) {
                events.push(
                  event(bootstrapUrl, "started", 0),
                  event(bootstrapUrl, "complete", 1),
                );
              }
            },
            exportRootfsImage: async () => new Uint8Array([2]),
            destroy: async () => {},
          };
        },
      }),
    /rebooted lifecycle is missing .*shell\.json/,
  );
});

function shellConfigBytes(
  path = "/bin/bash",
  argv0 = "bash",
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    path,
    argv: [argv0, "-l", "-i"],
  }));
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
