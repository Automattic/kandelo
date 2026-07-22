import { describe, expect, it } from "vitest";
import type { LazyDownloadEvent, LazyDownloadSummary } from "../src/kernel-host";
import {
  activeLazyDownloadSummaries,
  advanceLazyDownloadSummary,
  lazyDownloadAssetLabel,
} from "../src/lazy-download";

function event(overrides: Partial<LazyDownloadEvent>): LazyDownloadEvent {
  return {
    id: "download:1",
    kind: "file",
    status: "started",
    url: "https://example.test/releases/asset.bin",
    loadedBytes: 0,
    t: 1,
    ...overrides,
  };
}

describe("lazyDownloadAssetLabel", () => {
  it("uses a file's VFS path", () => {
    expect(lazyDownloadAssetLabel(event({
      path: "/usr/bin/tool",
    }))).toBe("tool");
  });

  it("uses the immutable payload URL for a deferred tree", () => {
    expect(lazyDownloadAssetLabel(event({
      kind: "tree",
      mountPrefix: "/",
      url: "https://github.com/example/project/releases/download/v1/" +
        "kandelo-homebrew-bottle-python-layer.bin?ignored=1",
    }))).toBe("kandelo-homebrew-bottle-python-layer.bin");
  });

  it("uses the payload URL for an archive", () => {
    expect(lazyDownloadAssetLabel(event({
      kind: "archive",
      mountPrefix: "/opt/runtime",
      url: "https://example.test/releases/runtime.zip",
    }))).toBe("runtime.zip");
  });
});

describe("lazy download summaries", () => {
  it("treats a progress event as the observed start when no started event exists", () => {
    expect(advanceLazyDownloadSummary(undefined, event({
      status: "progress",
      loadedBytes: 512,
      t: 20,
    }))).toMatchObject({
      status: "progress",
      firstSeenAt: 20,
      startedAt: 20,
      eventCount: 1,
    });
  });

  it("collapses an asset's full lifecycle without losing its first event", () => {
    const started = advanceLazyDownloadSummary(undefined, event({
      status: "started",
      loadedBytes: 0,
      totalBytes: 4096,
      t: 10,
    }));
    const progress = advanceLazyDownloadSummary(started, event({
      status: "progress",
      loadedBytes: 1024,
      t: 20,
    }));
    const complete = advanceLazyDownloadSummary(progress, event({
      status: "complete",
      loadedBytes: 4096,
      t: 30,
    }));

    expect(complete).toMatchObject({
      status: "complete",
      loadedBytes: 4096,
      totalBytes: 4096,
      firstSeenAt: 10,
      startedAt: 10,
      t: 30,
      eventCount: 3,
    });
  });

  it("reports the latest retry state while retaining asset-level evidence", () => {
    const failed: LazyDownloadSummary = {
      ...event({
        status: "error",
        loadedBytes: 2048,
        totalBytes: 4096,
        error: "connection reset",
        t: 20,
      }),
      firstSeenAt: 10,
      startedAt: 10,
      eventCount: 4,
    };
    const restarted = advanceLazyDownloadSummary(failed, event({
      status: "started",
      loadedBytes: 0,
      t: 50,
    }));

    expect(restarted).toMatchObject({
      status: "started",
      loadedBytes: 0,
      totalBytes: 4096,
      firstSeenAt: 10,
      startedAt: 50,
      t: 50,
      eventCount: 5,
    });
    expect(restarted.error).toBeUndefined();
  });

  it("preserves optional target identity when later events omit it", () => {
    const started = advanceLazyDownloadSummary(undefined, event({
      path: "/usr/bin/tool",
      mountPrefix: "/usr",
      totalBytes: 1024,
      t: 10,
    }));
    const progress = advanceLazyDownloadSummary(started, event({
      status: "progress",
      loadedBytes: 512,
      t: 20,
    }));

    expect(progress).toMatchObject({
      path: "/usr/bin/tool",
      mountPrefix: "/usr",
      totalBytes: 1024,
    });
  });

  it("selects every active asset from a summary snapshot, newest first", () => {
    const summary = (
      id: string,
      status: LazyDownloadEvent["status"],
      t: number,
    ): LazyDownloadSummary => ({
      ...event({ id, status, t }),
      firstSeenAt: t,
      startedAt: t,
      eventCount: 1,
    });

    expect(activeLazyDownloadSummaries([
      summary("complete", "complete", 40),
      summary("old-progress", "progress", 10),
      summary("failed", "error", 50),
      summary("new-start", "started", 30),
    ]).map(({ id }) => id)).toEqual(["new-start", "old-progress"]);
  });
});
