import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHCONF_NAMES } from "../src/generated/abi";
import { backendPathconf } from "../src/pathconf";
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
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function memoryFileSystem(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
}

describe("pathconf capability values", () => {
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

  it("answers only the two names a JavaScript backend can source", () => {
    // Everything else is the kernel's: `filesystem_pathconf_value` in
    // crates/runtime-core/src/syscalls.rs is the single authority, and a host
    // that answered those names here would be a second one.
    expect(backendPathconf(PATHCONF_NAMES.POSIX2_SYMLINKS, memoryProfile))
      .toBe(1);
    expect(backendPathconf(PATHCONF_NAMES.POSIX2_SYMLINKS, opfsProfile))
      .toBeNull();
    expect(backendPathconf(PATHCONF_NAMES.TIMESTAMP_RESOLUTION, memoryProfile))
      .toBe(1_000_000);
    expect(backendPathconf(PATHCONF_NAMES.TIMESTAMP_RESOLUTION, opfsProfile))
      .toBeNull();
  });

  it("refuses every kernel-owned name with ENOSYS rather than restating it", () => {
    for (
      const name of [
        PATHCONF_NAMES.NAME_MAX,
        PATHCONF_NAMES.PATH_MAX,
        PATHCONF_NAMES.NO_TRUNC,
        PATHCONF_NAMES.CHOWN_RESTRICTED,
        PATHCONF_NAMES.LINK_MAX,
        PATHCONF_NAMES.FILESIZEBITS,
        PATHCONF_NAMES.PIPE_BUF,
        PATHCONF_NAMES.ASYNC_IO,
        PATHCONF_NAMES.MAX_CANON,
        PATHCONF_NAMES.VDISABLE,
        999,
      ]
    ) {
      expect(() => backendPathconf(name, memoryProfile), String(name))
        .toThrow(/ENOSYS/);
    }
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
    // Routing is what this asserts; the value is the mock's.
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

    expect(io.fpathconf(fd, PATHCONF_NAMES.TIMESTAMP_RESOLUTION))
      .toBe(1_000_000);
    try {
      io.pathconf("/mnt/file", PATHCONF_NAMES.TIMESTAMP_RESOLUTION);
      throw new Error("pathconf unexpectedly accepted an unlinked path");
    } catch (error) {
      expect(error).toBeInstanceOf(SFSError);
      expect((error as SFSError).code).toBe(ENOENT);
    }
    io.close(fd);
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

    expect(fs.fpathconf(fd, PATHCONF_NAMES.TIMESTAMP_RESOLUTION))
      .toBe(1_000_000);
    expect(() => fs.pathconf("/file", PATHCONF_NAMES.TIMESTAMP_RESOLUTION))
      .toThrow(/ENOENT/);
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
