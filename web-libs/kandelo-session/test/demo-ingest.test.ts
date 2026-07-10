import { describe, expect, it, vi } from "vitest";
import {
  parseKandeloDemoConfig,
  resolveDemoIngest,
  validateKandeloDemoConfig,
  type DemoIngestConfig,
} from "../src/demo-config";
import {
  IngestError,
  runDemoIngest,
  waitForProcessExit,
  type IngestFileLike,
} from "../src/demo-ingest";
import type {
  KernelHost,
  ProcessEvent,
  ProcessInfo,
} from "../src/kernel-host";

const INGEST: DemoIngestConfig = {
  accept: [".wad"],
  targetPath: "/user.wad",
  maxBytes: 8,
  onLoad: { restart: "fbdoom -iwad /user.wad" },
};

function file(
  name: string,
  declaredSize: number,
  bytes: readonly number[],
): IngestFileLike {
  return {
    name,
    size: declaredSize,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

function ingestHost(overrides: Partial<KernelHost> = {}): KernelHost {
  return {
    writeFile: vi.fn(async () => {}),
    signalProcess: vi.fn(async () => true),
    dispatchShellCommand: vi.fn(async () => {}),
    ...overrides,
  } as unknown as KernelHost;
}

describe("image-owned demo ingest metadata", () => {
  it("resolves a validated fixed-path capability", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        emulator: {
          ingest: {
            accept: [".ROM"],
            targetPath: "/inputs/game.rom",
            maxBytes: 1024,
            onLoad: { restart: "emulator /inputs/game.rom" },
          },
        },
      },
    }));
    expect(config).not.toBeNull();
    validateKandeloDemoConfig(config!);
    expect(resolveDemoIngest(config!, "emulator")).toEqual({
      accept: [".rom"],
      targetPath: "/inputs/game.rom",
      maxBytes: 1024,
      onLoad: { restart: "emulator /inputs/game.rom" },
    });
  });

  it("eagerly rejects an unsafe capability in an unselected profile", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        selected: {},
        unselected: {
          ingest: {
            accept: [".rom"],
            targetPath: "/inputs/../escape.rom",
            maxBytes: 1024,
          },
        },
      },
    }));
    expect(config).not.toBeNull();
    expect(() => validateKandeloDemoConfig(config!)).toThrow(
      "profiles.unselected.ingest.targetPath must be a normalized file path",
    );
  });
});

describe("demo ingest transaction", () => {
  it("writes before stopping and dispatches only after release", async () => {
    const events: string[] = [];
    const host = ingestHost({
      writeFile: vi.fn(async (path, bytes, mode) => {
        events.push(`write:${path}:${bytes.byteLength}:${mode}`);
      }),
      signalProcess: vi.fn(async (pid, signum) => {
        events.push(`signal:${pid}:${signum}`);
        return true;
      }),
      dispatchShellCommand: vi.fn(async (command) => {
        events.push(`dispatch:${command}`);
      }),
    });

    await runDemoIngest(host, INGEST, file("custom.wad", 4, [1, 2, 3, 4]), {
      targetPid: 41,
      waitForRelease: async (pid) => {
        events.push(`watch:${pid}`);
      },
    });

    expect(events).toEqual([
      "write:/user.wad:4:420",
      "watch:41",
      "signal:41:15",
      "dispatch:fbdoom -iwad /user.wad",
    ]);
  });

  it("rechecks actual bytes before writing", async () => {
    const host = ingestHost();
    await expect(
      runDemoIngest(host, INGEST, file("lying.wad", 1, new Array(9).fill(1))),
    ).rejects.toMatchObject<Partial<IngestError>>({ reason: "too-large" });
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(host.signalProcess).not.toHaveBeenCalled();
  });

  it("does not stop the current process when the VFS write fails", async () => {
    const host = ingestHost({
      writeFile: vi.fn(async () => {
        throw new Error("read-only mount");
      }),
    });
    await expect(
      runDemoIngest(host, INGEST, file("custom.wad", 1, [1]), {
        targetPid: 41,
      }),
    ).rejects.toMatchObject<Partial<IngestError>>({ reason: "write-failed" });
    expect(host.signalProcess).not.toHaveBeenCalled();
    expect(host.dispatchShellCommand).not.toHaveBeenCalled();
  });

  it("surfaces restart dispatch failure", async () => {
    const host = ingestHost({
      dispatchShellCommand: vi.fn(async () => {
        throw new Error("PTY closed");
      }),
    });
    await expect(
      runDemoIngest(host, INGEST, file("custom.wad", 1, [1])),
    ).rejects.toMatchObject<Partial<IngestError>>({ reason: "restart-failed" });
  });

  it("aborts a release observer after the bounded timeout", async () => {
    let releaseSignal: AbortSignal | undefined;
    const host = ingestHost();
    await expect(
      runDemoIngest(host, INGEST, file("custom.wad", 1, [1]), {
        targetPid: 41,
        stopTimeoutMs: 5,
        waitForRelease: (_pid, signal) => {
          releaseSignal = signal;
          return new Promise(() => {});
        },
      }),
    ).rejects.toMatchObject<Partial<IngestError>>({ reason: "restart-failed" });
    expect(releaseSignal?.aborted).toBe(true);
    expect(host.dispatchShellCommand).not.toHaveBeenCalled();
  });
});

describe("process-exit observation", () => {
  it("subscribes before proving that an already-gone pid is absent", async () => {
    const unsubscribe = vi.fn();
    const host = ingestHost({
      subscribeProcessEvents: vi.fn(() => unsubscribe),
      enumProcs: vi.fn(async () => []),
    });
    await waitForProcessExit(host, 41);
    expect(host.subscribeProcessEvents).toHaveBeenCalledOnce();
    expect(host.enumProcs).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not miss an exit racing the initial process-table query", async () => {
    let listener: ((event: ProcessEvent) => void) | undefined;
    let resolveProcesses!: (processes: ProcessInfo[]) => void;
    const unsubscribe = vi.fn();
    const host = ingestHost({
      subscribeProcessEvents: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      enumProcs: vi.fn(() => new Promise((resolve) => {
        resolveProcesses = resolve;
      })),
    });

    const exited = waitForProcessExit(host, 41);
    listener?.({ kind: "exit", pid: 41, exitStatus: 143 });
    resolveProcesses([]);
    await exited;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
