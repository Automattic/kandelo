import { describe, expect, it } from "vitest";
import { LiveKernelHost } from "../src/kernel-host";
import type { KernelLike, MachineProgress } from "../src/kernel-host";

function loadingImage(overrides: Partial<MachineProgress> = {}): MachineProgress {
  return {
    phase: "image",
    label: "wordpress-sqlite.vfs.zst",
    completed: 1024,
    total: 4096,
    unit: "bytes",
    status: "loading",
    ...overrides,
  };
}

function unloading(overrides: Partial<MachineProgress> = {}): MachineProgress {
  return {
    phase: "destroying",
    label: "Bare shell",
    completed: 3,
    total: 7,
    totalProvisional: true,
    unit: "processes",
    status: "loading",
    ...overrides,
  };
}

function stubKernel(): KernelLike {
  return {} as KernelLike;
}

describe("LiveKernelHost machine progress", () => {
  it("reports nothing before a switch starts", () => {
    expect(new LiveKernelHost().getMachineProgress()).toBeNull();
  });

  it("carries image progress in bytes", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage());
    expect(host.getMachineProgress()).toEqual(loadingImage());
  });

  it("carries teardown progress in processes", () => {
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading());
    expect(host.getMachineProgress()).toEqual(unloading());
  });

  it("keeps a provisional total distinguishable from a final one", () => {
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading({ totalProvisional: true }));
    expect(host.getMachineProgress()?.totalProvisional).toBe(true);
    host.setMachineProgress(unloading({
      completed: 9, total: 9, totalProvisional: false,
    }));
    expect(host.getMachineProgress()?.totalProvisional).toBe(false);
  });

  it("treats an absent total as indeterminate", () => {
    // Review Focus 1: a teardown with nothing to reap must not read as 100%.
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading({ completed: 0, total: undefined }));
    expect(host.getMachineProgress()?.total).toBeUndefined();
  });

  it("fans out each update to subscribers", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    host.subscribeMachineProgress((p) => seen.push(p));
    host.setMachineProgress(loadingImage({ completed: 1024 }));
    host.setMachineProgress(loadingImage({ completed: 2048 }));
    expect(seen.map((p) => p?.completed)).toEqual([1024, 2048]);
  });

  it("stops notifying an unsubscribed listener", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    const off = host.subscribeMachineProgress((p) => seen.push(p));
    off();
    host.setMachineProgress(loadingImage());
    expect(seen).toEqual([]);
  });

  it("survives attachKernel, which clears the kernel-lifecycle ledger", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage({ status: "complete" }));
    host.attachKernel(stubKernel());
    expect(host.getMachineProgress()).toEqual(loadingImage({ status: "complete" }));
  });

  it("survives the whole teardown, when status is still running", () => {
    // Teardown publishes while the outgoing machine is still `running`; the
    // clear must not fire until the switch finishes.
    const host = new LiveKernelHost({ status: "running" });
    host.setMachineProgress(unloading());
    host.setStatus("booting");
    expect(host.getMachineProgress()).toEqual(unloading());
  });

  it("clears once the machine finishes booting", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<MachineProgress | null> = [];
    host.subscribeMachineProgress((p) => seen.push(p));
    host.setMachineProgress(loadingImage());
    host.setStatus("running");
    expect(host.getMachineProgress()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it("stores only scalars, so no machine memory is retained", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setMachineProgress(loadingImage());
    for (const value of Object.values(host.getMachineProgress()!)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});
