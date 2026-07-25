import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CAPTURED_STDIO,
  CentralizedKernelWorker,
} from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";
import {
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
  HOST_INTERCEPTED_SYSCALLS,
} from "../src/generated/abi";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("kernel task-ID authority", () => {
  it("does not substitute the process leader for a pthread missing its TID mapping", () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const mainChannel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const threadChannel = {
      pid: parentPid,
      channelOffset: 2 * WASM_PAGE_SIZE,
      memory,
    };
    const onFork = vi.fn();
    const onResolveSpawn = vi.fn();
    const onSpawn = vi.fn();
    const kernelForkProcess = vi.fn(() => 100);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onFork, onResolveSpawn, onSpawn },
        processes: new Map([
          [parentPid, { channels: [mainChannel, threadChannel] }],
        ]),
        channelTids: new Map(),
        kernelInstance: {
          exports: { kernel_fork_process: kernelForkProcess },
        },
      },
    ) as CentralizedKernelWorker;
    const expected =
      `No kernel-validated TID for non-main channel ${threadChannel.channelOffset} ` +
      `of process ${parentPid}`;

    expect(() => (kernelWorker as any).handleFork(threadChannel, [0]))
      .toThrow(expected);
    expect(() => (kernelWorker as any).handleSpawn(threadChannel, [0, 0, 0, 0, 0, 0]))
      .toThrow(expected);
    expect(kernelForkProcess).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    expect(onResolveSpawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("does not let an untracked pthread replace the leader's program image", () => {
    const pid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const mainChannel = { pid, channelOffset: WASM_PAGE_SIZE, memory };
    const threadChannel = { pid, channelOffset: 2 * WASM_PAGE_SIZE, memory };
    const pathPtr = 16;
    new Uint8Array(memory.buffer).set(
      new TextEncoder().encode("/bin/program\0"),
      pathPtr,
    );
    const onExec = vi.fn(async () => 0);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onExec },
        processes: new Map([
          [pid, { channels: [mainChannel, threadChannel], ptrWidth: 4 }],
        ]),
        channelTids: new Map(),
        completeChannel: vi.fn(),
      },
    ) as CentralizedKernelWorker;
    const expected =
      `No kernel-validated TID for non-main channel ${threadChannel.channelOffset} ` +
      `of process ${pid}`;

    expect(() => (kernelWorker as any).handleExec(
      threadChannel,
      [pathPtr, 0, 0],
    )).toThrow(expected);
    expect(() => (kernelWorker as any).handleExecveat(
      threadChannel,
      [-100, pathPtr, 0, 0, 0],
    )).toThrow(expected);
    expect(onExec).not.toHaveBeenCalled();
  });

  it("rejects a zero fork result before launching a child Worker", () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const completeChannel = vi.fn();
    const onFork = vi.fn();
    const kernelForkProcess = vi.fn(() => 0);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onFork },
        processes: new Map([[parentPid, { channels: [channel] }]]),
        channelTids: new Map(),
        threadForkContexts: new Map(),
        sharedMappings: new Map(),
        tcpListenerTargets: new Map(),
        epollInterests: new Map(),
        completeChannel,
        kernelInstance: {
          exports: {
            kernel_fork_process: kernelForkProcess,
            kernel_get_process_exit_signal: vi.fn(() => -1),
          },
        },
      },
    ) as CentralizedKernelWorker;
    const origArgs = [0];

    (kernelWorker as any).handleFork(channel, origArgs);

    expect(onFork).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("rejects zero before a host callback can attach an unallocated spawn child", () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const kernelMemory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const completeChannel = vi.fn();
    const onSpawn = vi.fn(async () => 0);
    const kernelSpawnProcess = vi.fn(() => 0);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onSpawn },
        kernel: {
          toKernelPtr(value: number | bigint): number {
            return Number(value);
          },
        },
        kernelMemory,
        scratchOffset: 0,
        completeChannel,
        kernelInstance: {
          exports: { kernel_spawn_process: kernelSpawnProcess },
        },
      },
    ) as CentralizedKernelWorker;
    const origArgs = [1, 2, 3, 4, 5, 0];

    (kernelWorker as any).handleSpawnAfterResolve(
      channel,
      origArgs,
      parentPid,
      parentPid,
      5,
      new Uint8Array([1]),
      1,
      {},
      [],
    );

    expect(kernelSpawnProcess).toHaveBeenCalledWith(parentPid, parentPid, 0, 1);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_SPAWN,
      origArgs,
      undefined,
      -1,
      5,
    );
  });

  it("uses the PID returned by Rust while fork registration is pending", async () => {
    const parentPid = 77;
    const childPid = 347;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const completeChannel = vi.fn();
    let finishForkRegistration!: (offsets: number[]) => void;
    const forkRegistration = new Promise<number[]>((resolve) => {
      finishForkRegistration = resolve;
    });
    const onFork = vi.fn(() => forkRegistration);
    const kernelForkProcess = vi.fn(() => childPid);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onFork },
        processes: new Map([[parentPid, { channels: [channel] }]]),
        channelTids: new Map(),
        threadForkContexts: new Map(),
        sharedMappings: new Map(),
        tcpListenerTargets: new Map(),
        epollInterests: new Map(),
        completeChannel,
        kernelInstance: {
          exports: {
            kernel_fork_process: kernelForkProcess,
            kernel_clear_fork_child: vi.fn(() => 0),
            kernel_get_process_exit_signal: vi.fn(() => -1),
          },
        },
      },
    ) as CentralizedKernelWorker;

    (kernelWorker as any).handleFork(channel, [0]);

    expect(kernelForkProcess).toHaveBeenCalledOnce();
    expect(kernelForkProcess).toHaveBeenCalledWith(parentPid, parentPid);
    expect(onFork).toHaveBeenCalledWith(parentPid, childPid, memory, undefined);
    expect((kernelWorker as any).processes.has(childPid)).toBe(false);
    expect("allocateTopLevelSpawnPid" in kernelWorker).toBe(false);

    finishForkRegistration([WASM_PAGE_SIZE]);
    await forkRegistration;
    await Promise.resolve();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
      undefined,
      childPid,
      0,
    );
  });

  it("returns the kernel-assigned PID for top-level process creation", () => {
    const createProcess = vi.fn(() => 912);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        initialized: true,
        kernelInstance: {
          exports: { kernel_create_process_with_stdio: createProcess },
        },
      },
    ) as CentralizedKernelWorker;

    expect(kernelWorker.createProcess(CAPTURED_STDIO)).toBe(912);
    expect(createProcess).toHaveBeenCalledWith(0, 0, 0);
  });

  it("accepts ESRCH as idempotent success when Rust already removed a process", () => {
    const removeProcess = vi.fn(() => -3);
    const drainWakeups = vi.fn();
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        initialized: true,
        kernelInstance: {
          exports: { kernel_remove_process: removeProcess },
        },
        drainAndProcessWakeupEvents: drainWakeups,
      },
    ) as CentralizedKernelWorker;

    expect(() => kernelWorker.removeProcessFromKernelTable(912)).not.toThrow();
    expect(removeProcess).toHaveBeenCalledWith(912);
    expect(drainWakeups).toHaveBeenCalledOnce();
  });

  it("fails closed when Rust rejects process removal for any other reason", () => {
    const removeProcess = vi.fn(() => -5);
    const drainWakeups = vi.fn();
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        initialized: true,
        kernelInstance: {
          exports: { kernel_remove_process: removeProcess },
        },
        drainAndProcessWakeupEvents: drainWakeups,
      },
    ) as CentralizedKernelWorker;

    expect(() => kernelWorker.removeProcessFromKernelTable(913)).toThrow(
      "Kernel could not remove process 913: errno 5",
    );
    expect(removeProcess).toHaveBeenCalledWith(913);
    expect(drainWakeups).not.toHaveBeenCalled();
  });

  it("routes Node and browser top-level spawns through Rust creation", () => {
    const nodeEntry = readFileSync(
      join(repoRoot, "host", "src", "node-kernel-worker-entry.ts"),
      "utf8",
    );
    const browserEntry = readFileSync(
      join(repoRoot, "host", "src", "browser-kernel-worker-entry.ts"),
      "utf8",
    );
    const browserProtocol = readFileSync(
      join(repoRoot, "host", "src", "browser-kernel-protocol.ts"),
      "utf8",
    );
    const spawnMessage = browserProtocol.match(
      /export interface SpawnMessage \{[\s\S]*?\n\}/,
    )?.[0];

    expect(nodeEntry).toContain("kernelWorker.createProcess(");
    expect(browserEntry).toContain("kernelWorker.createProcess(");
    expect(nodeEntry).not.toMatch(/next(?:Child|Spawn)Pid/);
    expect(browserEntry).not.toMatch(/next(?:Child|Spawn)Pid/);
    expect(spawnMessage).toBeDefined();
    expect(spawnMessage).not.toMatch(/\bpid\??:/);
  });

  it("requires every kernel child-allocation path at startup and artifact validation", () => {
    const requiredAuthorityExports = [
      "kernel_exec_prepare",
      "kernel_exec_setup_for_thread",
      "kernel_fork_process",
      "kernel_spawn_process",
      "kernel_thread_exit",
    ];
    for (const exportName of requiredAuthorityExports) {
      expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toContain(exportName);
    }

    const resolverWrapper = readFileSync(
      join(repoRoot, "scripts", "resolve-binary.sh"),
      "utf8",
    );
    // The shell entrypoint deliberately delegates artifact policy to the
    // generated standalone resolver. Check that boundary and inspect the
    // executable bundle instead of requiring a second hard-coded export list.
    expect(resolverWrapper).toContain(
      'exec node "$script_dir/resolve-binary.bundle.mjs" "$1"',
    );

    const artifactGuards = [
      "run.sh",
      "scripts/resolve-binary.bundle.mjs",
      "packages/registry/kernel/build-kernel.sh",
    ].map((path) => readFileSync(join(repoRoot, path), "utf8"));
    for (const source of artifactGuards) {
      for (const exportName of requiredAuthorityExports) {
        expect(source).toContain(exportName);
      }
    }
  });
});
