import { describe, expect, it } from "vitest";
import type { LazyDownloadEvent } from "../src/kernel-host";
import { lazyDownloadAssetLabel } from "../src/lazy-download";

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
