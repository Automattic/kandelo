import { afterAll, describe, expect, it } from "vitest";
import { OPEN_FLAGS } from "../src/generated/abi";
import { NodePlatformIO } from "../src/platform/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../src/vfs/host-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { ST_NOSUID } from "../src/vfs/types";
import { VirtualPlatformIO } from "../src/vfs/vfs";

/**
 * A mount carrying a set-ID file. The SUBJECT is the mount's nosuid policy —
 * whether `VirtualPlatformIO` honours or masks those bits — so what the
 * backend must do is carry mode `0o6755` and gid 42, not be any particular
 * filesystem.
 *
 * `HostFileSystem` records ownership and mode in its own metadata overlay, so
 * a gid of 42 needs no privilege on the machine running the test — which is
 * also why the incumbent's `createFileWithOwner` had an equivalent here.
 */
const setIdRoots: string[] = [];
function createSetIdFileSystem(): HostFileSystem {
  const root = mkdtempSync(join(tmpdir(), "kandelo-nosuid-exec-"));
  setIdRoots.push(root);
  const fs = new HostFileSystem(root);
  fs.mkdir("/bin", 0o755);
  const fd = fs.open("/bin/tool", OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_RDWR, 0o755);
  fs.write(fd, new Uint8Array([0, 97, 115, 109]), null, 4);
  fs.close(fd);
  fs.chown("/bin/tool", 0, 42);
  fs.chmod("/bin/tool", 0o6755);
  return fs;
}

afterAll(() => {
  while (setIdRoots.length > 0) {
    rmSync(setIdRoots.pop()!, { recursive: true, force: true });
  }
});

describe("set-ID mount policy", () => {
  it("keeps the raw host filesystem adapter nosuid", () => {
    const io = new NodePlatformIO();

    expect(io.statfs(process.cwd()).flags & ST_NOSUID).toBe(ST_NOSUID);
  });

  it("honors set-ID bits on an ordinary writable VFS mount", () => {
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: createSetIdFileSystem() }],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/bin/tool").mode & 0o6000).toBe(0o6000);
    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(0);
    expect(vfs.getMountNosuid("/bin/tool")).toBe(false);
  });

  it("suppresses set-ID semantics on an explicitly nosuid mount", () => {
    const vfs = new VirtualPlatformIO(
      [{
        mountPoint: "/",
        backend: createSetIdFileSystem(),
        nosuid: true,
      }],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/bin/tool").mode & 0o6000).toBe(0o6000);
    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(ST_NOSUID);
    expect(vfs.getMountNosuid("/bin/tool")).toBe(true);
  });

  it("binds nosuid evidence to the exact open route", () => {
    const backend = createSetIdFileSystem();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/normal", backend },
        { mountPoint: "/scratch", backend, nosuid: true },
      ],
      new NodeTimeProvider(),
    );

    const normal = vfs.open("/normal/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const scratch = vfs.open("/scratch/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    try {
      expect(vfs.fstatfs(normal).flags & ST_NOSUID).toBe(0);
      expect(vfs.fstatfs(scratch).flags & ST_NOSUID).toBe(ST_NOSUID);
      expect(vfs.statfs("/normal/bin/tool").flags & ST_NOSUID).toBe(0);
      expect(vfs.statfs("/scratch/bin/tool").flags & ST_NOSUID).toBe(
        ST_NOSUID,
      );
    } finally {
      vfs.close(normal);
      vfs.close(scratch);
    }
  });

  it("retains the exact open inode identity across rename and unlink", () => {
    const backend = createSetIdFileSystem();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );
    const handle = vfs.open("/bin/tool", OPEN_FLAGS.O_RDONLY, 0);
    const before = vfs.fstat(handle);
    const identity = vfs.fileHandleIdentity(
      handle,
      BigInt(before.dev),
      BigInt(before.ino),
    );

    backend.rename("/bin/tool", "/bin/renamed");
    backend.unlink("/bin/renamed");

    try {
      const after = vfs.fstat(handle);
      expect(after.ino).toBe(before.ino);
      expect(vfs.fileHandleIdentity(
        handle,
        BigInt(after.dev),
        BigInt(after.ino),
      )).toBe(identity);
      expect(vfs.read(handle, new Uint8Array(4), 0, 4)).toBe(4);
    } finally {
      vfs.close(handle);
    }
  });
});
