import { describe, expect, it } from "vitest";

import { LiveKernelHost } from "../src/kernel-host";
import type { BootProgress, KernelLike } from "../src/kernel-host";

function loading(overrides: Partial<BootProgress> = {}): BootProgress {
  return {
    phase: "image",
    label: "wordpress-sqlite.vfs.zst",
    loadedBytes: 1024,
    totalBytes: 4096,
    status: "loading",
    ...overrides,
  };
}

/** Minimal kernel stand-in; attachKernel only needs the optional hooks absent. */
function stubKernel(): KernelLike {
  return {} as KernelLike;
}

describe("LiveKernelHost boot progress", () => {
  it("reports no boot progress before an image load starts", () => {
    expect(new LiveKernelHost().getBootProgress()).toBeNull();
  });

  it("exposes the latest record to a late reader", () => {
    const host = new LiveKernelHost({ status: "booting" });

    host.setBootProgress(loading());

    expect(host.getBootProgress()).toEqual(loading());
  });

  it("fans out each update to subscribers", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<BootProgress | null> = [];
    host.subscribeBootProgress((progress) => seen.push(progress));

    host.setBootProgress(loading({ loadedBytes: 1024 }));
    host.setBootProgress(loading({ loadedBytes: 2048 }));

    expect(seen.map((p) => p?.loadedBytes)).toEqual([1024, 2048]);
  });

  it("stops notifying an unsubscribed listener", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<BootProgress | null> = [];
    const off = host.subscribeBootProgress((progress) => seen.push(progress));

    off();
    host.setBootProgress(loading());

    expect(seen).toEqual([]);
  });

  it("survives attachKernel, which clears the kernel-lifecycle download ledger", () => {
    // WHY: the image is fully loaded before the kernel exists, so routing boot
    // progress through the lazy-download ledger would erase it at attach time.
    const host = new LiveKernelHost({ status: "booting" });
    host.setBootProgress(loading({ status: "complete", loadedBytes: 4096 }));

    host.attachKernel(stubKernel());

    expect(host.getBootProgress()).toEqual(
      loading({ status: "complete", loadedBytes: 4096 }),
    );
  });

  it("clears itself once the machine finishes booting", () => {
    const host = new LiveKernelHost({ status: "booting" });
    const seen: Array<BootProgress | null> = [];
    host.subscribeBootProgress((progress) => seen.push(progress));
    host.setBootProgress(loading());

    host.setStatus("running");

    expect(host.getBootProgress()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it("clears itself when a boot fails", () => {
    const host = new LiveKernelHost({ status: "booting" });
    host.setBootProgress(loading({ status: "error", error: "offline" }));

    host.setStatus("error");

    expect(host.getBootProgress()).toBeNull();
  });

  it("keeps the record while the machine is still booting", () => {
    const host = new LiveKernelHost({ status: "idle" });
    host.setStatus("booting");

    host.setBootProgress(loading());

    expect(host.getBootProgress()).toEqual(loading());
  });

  it("stores only scalars, so no image bytes are retained on the main thread", () => {
    const host = new LiveKernelHost({ status: "booting" });

    host.setBootProgress(loading());

    for (const value of Object.values(host.getBootProgress()!)) {
      expect(["string", "number"]).toContain(typeof value);
    }
  });
});
