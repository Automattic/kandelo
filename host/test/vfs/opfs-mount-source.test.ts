import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OpfsFileSystem } from "../../src/vfs/opfs";
import { OPFS_CHANNEL_SIZE } from "../../src/vfs/opfs-channel";
import {
  DEFAULT_MOUNT_SPEC,
  ensureMountPointDirectories,
  resolveForBrowser,
  validateSpec,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import type { DirEntry, MountConfig } from "../../src/vfs/types";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { NodeTimeProvider } from "../../src/vfs/time";
import { resolveForNode } from "../../src/vfs/default-mounts-node";
import { restoreBrowserKernelInitMounts } from "../../src/browser-kernel-vfs-init";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

async function buildFixtureImage(): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(2 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/etc", 0o755);
  const passwd = new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n");
  const fd = mfs.open("/etc/passwd", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, passwd, null, passwd.length);
  mfs.close(fd);
  return await mfs.saveImage();
}

// Shrink scratch SABs so the 7 scratch mounts × default 16 MiB don't
// OOM the test runner (`mkfs` zero-fills every SAB up front).
const tinyScratch = Object.fromEntries(
  DEFAULT_MOUNT_SPEC.filter((m) => m.source === "scratch").map((m) => [
    m.path,
    256 * 1024,
  ]),
);

const OPFS_SPEC: MountSpec = {
  path: "/persist",
  source: "opfs",
  opfsName: "workspace-a",
};

describe("MountSpec validation for the opfs source", () => {
  it("accepts a path-safe workspace name", () => {
    expect(() => validateSpec([OPFS_SPEC])).not.toThrow();
  });

  it("rejects an opfs mount without a workspace name", () => {
    expect(() =>
      validateSpec([{ path: "/persist", source: "opfs" }]),
    ).toThrow(/workspace name/i);
  });

  it.each([
    ".hidden",
    "../escape",
    "a/b",
    "",
    "x".repeat(65),
    "name with spaces",
  ])("rejects unsafe workspace name %j", (opfsName) => {
    expect(() =>
      validateSpec([{ path: "/persist", source: "opfs", opfsName }]),
    ).toThrow(/workspace name/i);
  });

  it("rejects an opfs mount at /", () => {
    expect(() =>
      validateSpec([{ path: "/", source: "opfs", opfsName: "root-take" }]),
    ).toThrow(/root image/i);
  });

  it("rejects opfsName on non-opfs mounts", () => {
    expect(() =>
      validateSpec([{ path: "/tmp", source: "scratch", opfsName: "nope" }]),
    ).toThrow(/only valid on opfs/i);
  });
});

describe("resolveForBrowser with opfs mounts", () => {
  let image: Uint8Array;

  beforeAll(async () => {
    image = await buildFixtureImage();
  });

  it("binds an OpfsFileSystem to the supplied proxy channel", async () => {
    const channelSab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    const mounts = await resolveForBrowser(
      [...DEFAULT_MOUNT_SPEC, OPFS_SPEC],
      image,
      {
        scratchSabBytes: tinyScratch,
        opfsChannels: { "/persist": channelSab },
      },
    );
    const persist = mounts.find((m) => m.mountPoint === "/persist");
    expect(persist).toBeDefined();
    expect(persist!.backend).toBeInstanceOf(OpfsFileSystem);
    // The resolver only forwards the spec's set-ID intent; the boot boundary
    // decides the default.
    expect(persist!.nosuid).toBeUndefined();
    // The other mounts keep their existing backends.
    const root = mounts.find((m) => m.mountPoint === "/");
    expect(root!.backend).toBeInstanceOf(MemoryFileSystem);
  });

  it("fails loudly when the proxy channel is missing", async () => {
    await expect(
      resolveForBrowser([...DEFAULT_MOUNT_SPEC, OPFS_SPEC], image, {
        scratchSabBytes: tinyScratch,
      }),
    ).rejects.toThrow(/no initialized proxy channel/i);
  });
});

describe("resolveForNode with opfs mounts", () => {
  let image: Uint8Array;
  let sessionDir: string;
  let workspaceRoot: string;

  beforeAll(async () => {
    image = await buildFixtureImage();
    sessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-opfs-session-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "wasm-posix-opfs-workspaces-"));
  });

  afterAll(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("mounts a HostFileSystem over the named workspace directory", async () => {
    const mounts = await resolveForNode(
      [...DEFAULT_MOUNT_SPEC, OPFS_SPEC],
      image,
      sessionDir,
      { opfsWorkspaceRoot: workspaceRoot },
    );
    const persist = mounts.find((m) => m.mountPoint === "/persist");
    expect(persist).toBeDefined();
    expect(persist!.backend).toBeInstanceOf(HostFileSystem);
    expect(persist!.nosuid).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "workspace-a"))).toBe(true);
    expect(statSync(join(workspaceRoot, "workspace-a")).isDirectory()).toBe(true);

    const data = new TextEncoder().encode("durable bytes");
    const fd = persist!.backend.open("/state.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    persist!.backend.write(fd, data, null, data.length);
    persist!.backend.close(fd);
    expect(
      readFileSync(join(workspaceRoot, "workspace-a", "state.txt"), "utf8"),
    ).toBe("durable bytes");
  });

  it("the workspace persists across independent resolves (boot-to-boot durability)", async () => {
    const secondSession = mkdtempSync(join(tmpdir(), "wasm-posix-opfs-session2-"));
    try {
      const mounts = await resolveForNode(
        [...DEFAULT_MOUNT_SPEC, OPFS_SPEC],
        image,
        secondSession,
        { opfsWorkspaceRoot: workspaceRoot },
      );
      const persist = mounts.find((m) => m.mountPoint === "/persist")!;
      const st = persist.backend.stat("/state.txt");
      const fd = persist.backend.open("/state.txt", O_RDONLY, 0);
      const buf = new Uint8Array(st.size);
      const n = persist.backend.read(fd, buf, null, buf.length);
      persist.backend.close(fd);
      expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("durable bytes");
    } finally {
      rmSync(secondSession, { recursive: true, force: true });
    }
  });

  it("fails loudly without an opfsWorkspaceRoot", async () => {
    await expect(
      resolveForNode([...DEFAULT_MOUNT_SPEC, OPFS_SPEC], image, sessionDir),
    ).rejects.toThrow(/opfsWorkspaceRoot/);
  });

  it("distinct workspace names get distinct directories", async () => {
    const specs: MountSpec[] = [
      ...DEFAULT_MOUNT_SPEC,
      { path: "/persist", source: "opfs", opfsName: "workspace-a", nosuid: true },
      { path: "/persist2", source: "opfs", opfsName: "workspace-b" },
    ];
    const mounts = await resolveForNode(specs, image, sessionDir, {
      opfsWorkspaceRoot: workspaceRoot,
    });
    const a = mounts.find((m) => m.mountPoint === "/persist")!;
    const b = mounts.find((m) => m.mountPoint === "/persist2")!;
    expect(a.backend).not.toBe(b.backend);
    expect(a.nosuid).toBe(true);
    expect(b.nosuid).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "workspace-b"))).toBe(true);
  });
});

describe("restoreBrowserKernelInitMounts with opfs mounts", () => {
  it("extends the canonical spec and validates through the shared resolver", async () => {
    const image = await buildFixtureImage();
    const channelSab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    const mounts = await restoreBrowserKernelInitMounts(image, DEFAULT_MOUNT_SPEC, {
      opfsMounts: [
        { path: "/persist", name: "workspace-a", channelSab },
      ],
    });
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length + 1);
    const persist = mounts.find((m) => m.mountPoint === "/persist");
    expect(persist!.backend).toBeInstanceOf(OpfsFileSystem);
    // Guest-writable storage must not grant set-ID credentials on exec.
    expect(persist!.nosuid).toBe(true);
  });

  it("rejects an opfs mount that duplicates a canonical mount point", async () => {
    const image = await buildFixtureImage();
    const channelSab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    // validateSpec throws synchronously, before any backend allocation.
    expect(() =>
      restoreBrowserKernelInitMounts(image, DEFAULT_MOUNT_SPEC, {
        opfsMounts: [{ path: "/tmp", name: "workspace-a", channelSab }],
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects an unsafe workspace name before any backend is constructed", async () => {
    const image = await buildFixtureImage();
    const channelSab = new SharedArrayBuffer(OPFS_CHANNEL_SIZE);
    expect(() =>
      restoreBrowserKernelInitMounts(image, DEFAULT_MOUNT_SPEC, {
        opfsMounts: [{ path: "/persist", name: "../escape", channelSab }],
      }),
    ).toThrow(/workspace name/i);
  });
});


interface DirectoryLister {
  opendir(path: string): number;
  readdir(handle: number): DirEntry | null;
  closedir(handle: number): void;
}

function listNames(fs: DirectoryLister, path: string): string[] {
  const handle = fs.opendir(path);
  const names: string[] = [];
  try {
    for (let entry = fs.readdir(handle); entry !== null; entry = fs.readdir(handle)) {
      names.push(entry.name);
    }
  } finally {
    fs.closedir(handle);
  }
  return names;
}

describe("ensureMountPointDirectories", () => {
  const smallFs = () => MemoryFileSystem.create(new SharedArrayBuffer(512 * 1024));

  it("creates a nested mount point inside the mount that owns its parent", () => {
    const root = smallFs();
    root.mkdir("/home", 0o755);
    const scratch = smallFs();
    const mounts: MountConfig[] = [
      { mountPoint: "/", backend: root },
      { mountPoint: "/home/maker", backend: scratch },
      { mountPoint: "/home/maker/.fdoom.tar", backend: smallFs() },
      { mountPoint: "/persist", backend: smallFs() },
    ];

    ensureMountPointDirectories(mounts, ["/home/maker/.fdoom.tar", "/persist"]);

    // The parent of the nested mount is the scratch mount, so that is where
    // the mounted-over directory must live. The scratch mount's own mount
    // point is created in the root image so the path walk can reach it.
    expect(listNames(scratch, "/")).toContain(".fdoom.tar");
    expect(listNames(root, "/home")).toContain("maker");
    expect(() => root.stat("/home/maker/.fdoom.tar")).toThrow();
    // A mount point whose parent is on the root image is created there.
    expect(listNames(root, "/")).toContain("persist");

    // What a process sees: readdir of the parent lists the mount point, the
    // same way Linux lists the directory a filesystem is mounted over.
    const io = new VirtualPlatformIO(mounts, new NodeTimeProvider());
    expect(listNames(io, "/home/maker")).toContain(".fdoom.tar");
    expect(listNames(io, "/")).toContain("persist");
  });

  it("creates missing intermediate directories on the owning mount only", () => {
    const root = smallFs();
    const scratch = smallFs();
    const mounts: MountConfig[] = [
      { mountPoint: "/", backend: root },
      { mountPoint: "/srv", backend: scratch },
      { mountPoint: "/srv/data/work", backend: smallFs() },
    ];

    ensureMountPointDirectories(mounts, ["/srv/data/work"]);

    expect(listNames(scratch, "/")).toContain("data");
    expect(listNames(scratch, "/data")).toContain("work");
    expect(listNames(root, "/")).toContain("srv");
    expect(() => root.stat("/srv/data")).toThrow();
  });

  it("fails loudly when a path component is not a directory", () => {
    const root = smallFs();
    root.mkdir("/home", 0o755);
    const blocker = root.open("/home/maker", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    root.close(blocker);
    const mounts: MountConfig[] = [
      { mountPoint: "/", backend: root },
      { mountPoint: "/home/maker/.fdoom.tar", backend: smallFs() },
    ];

    expect(() =>
      ensureMountPointDirectories(mounts, ["/home/maker/.fdoom.tar"]),
    ).toThrow(/\/home\/maker in mount \/ exists and is not a directory/);
  });

  it("is idempotent and leaves an existing directory alone", () => {
    const root = smallFs();
    root.mkdir("/persist", 0o700);
    const mounts: MountConfig[] = [
      { mountPoint: "/", backend: root },
      { mountPoint: "/persist", backend: smallFs() },
    ];

    ensureMountPointDirectories(mounts, ["/persist"]);
    ensureMountPointDirectories(mounts, ["/persist"]);

    expect(root.stat("/persist").mode & 0o777).toBe(0o700);
    expect(listNames(root, "/").filter((n) => n === "persist")).toHaveLength(1);
  });
});
