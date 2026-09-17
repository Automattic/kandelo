import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../../src/vfs/host-fs";

const O_RDONLY = 0;
const O_DIRECTORY = 0o200000;

describe("directory fsync", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the native durability barrier for Node-backed directories", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-directory-fsync-"));
    roots.push(root);
    mkdirSync(join(root, "journal"));
    const fs = new HostFileSystem(root);
    const fd = fs.open("/journal", O_RDONLY | O_DIRECTORY, 0);

    try {
      expect(() => fs.fsync(fd)).not.toThrow();
    } finally {
      fs.close(fd);
    }
  });

  // RETIRED 2026-09-17: "accepts directory fsync when memory writes are
  // already synchronous". The subject was `MemoryFileSystem` — a backend with
  // no durable store, for which `fsync` is correctly a no-op success — and the
  // kernel makes the same claim three ways, about the backends that actually
  // serve a guest: `test_fsync_tmpfs_handle_is_noop`,
  // `test_fsync_rootfs_overlay_handle_is_noop` and
  // `test_fsync_directory_delegates_to_host`. The host-backed case above stays,
  // because a real directory fsync does reach the host.
});
