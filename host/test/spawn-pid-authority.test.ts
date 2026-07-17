import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WASM_PAGE_SIZE } from "../src/constants";
import { HOST_INTERCEPTED_SYSCALLS } from "../src/generated/abi";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("top-level spawn pid authority", () => {
  it("does not reuse a pid while Node fork registration is still pending", async () => {
    const parentPid = 77;
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const channel = { pid: parentPid, channelOffset: WASM_PAGE_SIZE, memory };
    const completeChannel = vi.fn();
    const kernelPids = new Set([parentPid]);
    let finishForkRegistration!: (offsets: number[]) => void;
    const forkRegistration = new Promise<number[]>((resolve) => {
      finishForkRegistration = resolve;
    });
    const onFork = vi.fn(() => forkRegistration);
    const kernelWorker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        callbacks: { onFork },
        nextChildPid: 101,
        processes: new Map([[parentPid, { channels: [channel] }]]),
        threadForkContexts: new Map(),
        sharedMappings: new Map(),
        tcpListenerTargets: new Map(),
        epollInterests: new Map(),
        completeChannel,
        kernelInstance: {
          exports: {
            kernel_fork_process: vi.fn((_parent: number, child: number) => {
              if (kernelPids.has(child)) return -17;
              kernelPids.add(child);
              return 0;
            }),
            kernel_clear_fork_child: vi.fn(() => 0),
            kernel_reset_signal_mask: vi.fn(() => 0),
            kernel_get_process_exit_signal: vi.fn(() => -1),
          },
        },
      },
    ) as CentralizedKernelWorker;

    // This is the real fork state transition. It commits pid 101 in the Rust
    // kernel, then calls Node's async onFork path. Keep that callback pending
    // at the exact point before registerProcess adds the child host mapping.
    (kernelWorker as any).handleFork(channel, [0]);
    expect(onFork).toHaveBeenCalledWith(parentPid, 101, memory, undefined);
    expect(kernelPids.has(101)).toBe(true);
    expect((kernelWorker as any).processes.has(101)).toBe(false);

    // Node handleSpawn uses this same allocator. The old worker-local counter
    // would still see pid 101 as absent from its process map and reuse it.
    expect(kernelWorker.allocateTopLevelSpawnPid()).toBe(102);

    finishForkRegistration([WASM_PAGE_SIZE]);
    await forkRegistration;
    await Promise.resolve();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      HOST_INTERCEPTED_SYSCALLS.SYS_FORK,
      [0],
      undefined,
      101,
      0,
    );
  });

  it("routes Node top-level spawns through the kernel-worker allocator", () => {
    const nodeEntry = readFileSync(
      join(repoRoot, "host", "src", "node-kernel-worker-entry.ts"),
      "utf8",
    );

    expect(nodeEntry).toContain(
      "const pid = kernelWorker.allocateTopLevelSpawnPid();",
    );
    expect(nodeEntry).not.toContain("nextSpawnPid");
  });

  it("does not let browser main-thread callers choose a pid", () => {
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

    expect(browserEntry).toContain(
      "const pid = kernelWorker.allocateTopLevelSpawnPid();",
    );
    expect(browserEntry).not.toContain("msg.pid ??");
    expect(spawnMessage).toBeDefined();
    expect(spawnMessage).not.toMatch(/\bpid\??:/);
  });
});
