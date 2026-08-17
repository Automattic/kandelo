import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHCONF_NAMES } from "../src/generated/abi";
import { filesystemPathconf } from "../src/pathconf";
import { DeviceFileSystem } from "../src/vfs/device-fs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import {
  ENOENT,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  SFSError,
} from "../src/vfs/sharedfs-vendor";
import type { StatResult } from "../src/types";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function memoryFileSystem(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
}

describe("pathconf capability values", () => {
  const regularStat: StatResult = {
    dev: 1,
    ino: 1,
    mode: 0o100644,
    nlink: 1,
    uid: 0,
    gid: 0,
    size: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
  };
  const fifoStat = { ...regularStat, mode: 0o010644 };
  const directoryStat = { ...regularStat, mode: 0o040755 };
  const memoryProfile = {
    supportsSymlinks: true,
    timestampResolutionNs: 1_000_000,
  };
  const opfsProfile = {
    supportsSymlinks: false,
    timestampResolutionNs: null,
  };

  it("keeps the generated name table complete and unique", () => {
    expect(Object.keys(PATHCONF_NAMES)).toHaveLength(24);
    expect(new Set(Object.values(PATHCONF_NAMES)).size).toBe(24);
    expect(Math.min(...Object.values(PATHCONF_NAMES))).toBe(0);
    expect(Math.max(...Object.values(PATHCONF_NAMES))).toBe(23);
  });

  it("reports enforced namespace limits and backend capabilities", () => {
    expect(
      filesystemPathconf(regularStat, PATHCONF_NAMES.NAME_MAX, memoryProfile),
    ).toBe(255);
    expect(
      filesystemPathconf(regularStat, PATHCONF_NAMES.PATH_MAX, memoryProfile),
    ).toBe(4096);
    expect(
      filesystemPathconf(regularStat, PATHCONF_NAMES.NO_TRUNC, memoryProfile),
    ).toBe(1);
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.CHOWN_RESTRICTED,
        opfsProfile,
      ),
    ).toBe(1);
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.POSIX2_SYMLINKS,
        memoryProfile,
      ),
    ).toBe(1);
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.POSIX2_SYMLINKS,
        opfsProfile,
      ),
    ).toBeNull();
    expect(
      filesystemPathconf(regularStat, PATHCONF_NAMES.ASYNC_IO, memoryProfile),
    ).toBe(1);
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.TIMESTAMP_RESOLUTION,
        memoryProfile,
      ),
    ).toBe(1_000_000);
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.TIMESTAMP_RESOLUTION,
        opfsProfile,
      ),
    ).toBeNull();
  });

  it("distinguishes indeterminate values from invalid associations", () => {
    expect(
      filesystemPathconf(regularStat, PATHCONF_NAMES.LINK_MAX, memoryProfile),
    ).toBeNull();
    expect(
      filesystemPathconf(
        regularStat,
        PATHCONF_NAMES.FILESIZEBITS,
        memoryProfile,
      ),
    ).toBeNull();
    expect(() =>
      filesystemPathconf(regularStat, PATHCONF_NAMES.PIPE_BUF, memoryProfile),
    ).toThrow(/EINVAL/);
    expect(
      filesystemPathconf(fifoStat, PATHCONF_NAMES.PIPE_BUF, memoryProfile),
    ).toBeNull();
    expect(
      filesystemPathconf(
        directoryStat,
        PATHCONF_NAMES.PIPE_BUF,
        memoryProfile,
      ),
    ).toBeNull();
    expect(() => filesystemPathconf(regularStat, 999, memoryProfile)).toThrow(
      /EINVAL/,
    );
  });
});

describe("pathconf VFS routing", () => {
  it("uses the longest-prefix mount for pathname queries", () => {
    const root = memoryFileSystem();
    const mounted = memoryFileSystem();
    const rootQuery = vi.spyOn(root, "pathconf").mockReturnValue(111);
    const mountedQuery = vi.spyOn(mounted, "pathconf").mockReturnValue(222);
    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/mnt", backend: mounted },
        { mountPoint: "/", backend: root },
      ],
      new NodeTimeProvider(),
    );

    expect(io.pathconf("/mnt/file", PATHCONF_NAMES.PATH_MAX)).toBe(222);
    expect(mountedQuery).toHaveBeenCalledWith("/file", PATHCONF_NAMES.PATH_MAX);
    expect(rootQuery).not.toHaveBeenCalled();
  });

  it("keeps fpathconf on the open handle's backend after unlink", () => {
    const root = memoryFileSystem();
    const mounted = memoryFileSystem();
    root.mkdir("/mnt", 0o755);
    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/mnt", backend: mounted },
        { mountPoint: "/", backend: root },
      ],
      new NodeTimeProvider(),
    );
    const fd = io.open("/mnt/file", O_CREAT | O_RDWR, 0o644);
    io.unlink("/mnt/file");

    expect(io.fpathconf(fd, PATHCONF_NAMES.NAME_MAX)).toBe(255);
    try {
      io.pathconf("/mnt/file", PATHCONF_NAMES.NAME_MAX);
      throw new Error("pathconf unexpectedly accepted an unlinked path");
    } catch (error) {
      expect(error).toBeInstanceOf(SFSError);
      expect((error as SFSError).code).toBe(ENOENT);
    }
    io.close(fd);
  });

  it("validates device paths and live device handles", () => {
    const device = new DeviceFileSystem();
    expect(device.pathconf("/null", PATHCONF_NAMES.NAME_MAX)).toBe(255);
    const fd = device.open("/null", O_RDONLY, 0);
    expect(device.fpathconf(fd, PATHCONF_NAMES.CHOWN_RESTRICTED)).toBe(1);
    device.close(fd);
    expect(() => device.fpathconf(fd, PATHCONF_NAMES.NAME_MAX)).toThrow(/EBADF/);
  });
});

describe("HostFileSystem fpathconf", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses the live descriptor after its pathname is unlinked", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-pathconf-"));
    roots.push(root);
    writeFileSync(join(root, "file"), "data");
    const fs = new HostFileSystem(root);
    const fd = fs.open("/file", O_RDONLY, 0);
    fs.unlink("/file");

    expect(fs.fpathconf(fd, PATHCONF_NAMES.PATH_MAX)).toBe(4096);
    expect(() => fs.pathconf("/file", PATHCONF_NAMES.PATH_MAX)).toThrow(/ENOENT/);
    fs.close(fd);
  });
});

describe("pathconf guest ABI", () => {
  it.each([".wasm", ".wasm64.wasm"])(
    "preserves values, errno, and pointer safety (%s)",
    async (suffix) => {
      if (suffix === ".wasm64.wasm") {
        ensureWasm64ExampleFixture("pathconf_test.c");
      }
      const result = await runCentralizedProgram({
        programPath: join(repoRoot, `examples/pathconf_test${suffix}`),
        argv: ["pathconf-test"],
        timeout: 15_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("PATHCONF_PASS");
      expect(result.stderr).toBe("");
    },
  );
});
