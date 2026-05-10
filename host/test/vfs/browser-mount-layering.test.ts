/**
 * Browser host mount layering — verifies that the wiring in
 * `examples/browser/lib/kernel-worker-entry.ts` (Task 4.4) layers
 * the browser-platform internals (`/dev/shm`, `/dev`) on top of
 * `resolveForBrowser(DEFAULT_MOUNT_SPEC, vfsImage)` and that the
 * resulting `VirtualPlatformIO` resolves rootfs paths to the image
 * backend and scratch paths to memfs scratch backends.
 *
 * Stays in `host/test/vfs/` (not Playwright) because the layering is a
 * pure data construction with no DOM/Worker dependency — replicating
 * it here gives us fast Vitest feedback and avoids requiring a built
 * `rootfs.vfs` on disk.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { DeviceFileSystem } from "../../src/vfs/device-fs";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { BrowserTimeProvider } from "../../src/vfs/time";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
} from "../../src/vfs/default-mounts";
import type { MountConfig } from "../../src/vfs/types";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

const TINY_SCRATCH = Object.fromEntries(
  DEFAULT_MOUNT_SPEC.filter((m) => m.source === "scratch").map((m) => [
    m.path,
    256 * 1024,
  ]),
);

async function buildFixtureImage(): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(2 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/etc", 0o755);
  const services = new TextEncoder().encode("http\t\t80/tcp\t\twww\n");
  let fd = mfs.open("/etc/services", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, services, null, services.length);
  mfs.close(fd);
  const passwd = new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n");
  fd = mfs.open("/etc/passwd", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, passwd, null, passwd.length);
  mfs.close(fd);
  return await mfs.saveImage();
}

/** Mirrors the construction in kernel-worker-entry.ts handleInit. */
function buildBrowserMounts(image: Uint8Array): {
  mounts: MountConfig[];
  io: VirtualPlatformIO;
  rootfs: MemoryFileSystem;
} {
  const shmSab = new SharedArrayBuffer(64 * 1024);
  const shmfs = MemoryFileSystem.create(shmSab);
  const devfs = new DeviceFileSystem();
  const specMounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
    scratchSabBytes: TINY_SCRATCH,
  });
  const rootMount = specMounts.find((m) => m.mountPoint === "/");
  if (!rootMount) throw new Error("DEFAULT_MOUNT_SPEC missing / mount");
  const mounts: MountConfig[] = [
    { mountPoint: "/dev/shm", backend: shmfs },
    { mountPoint: "/dev", backend: devfs },
    ...specMounts,
  ];
  return {
    mounts,
    io: new VirtualPlatformIO(mounts, new BrowserTimeProvider()),
    rootfs: rootMount.backend as MemoryFileSystem,
  };
}

describe("browser host mount layering", () => {
  let image: Uint8Array;

  beforeAll(async () => {
    image = await buildFixtureImage();
  });

  it("produces 10 mounts: 8 from spec + /dev/shm + /dev", () => {
    const { mounts } = buildBrowserMounts(image);
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length + 2);
    const points = mounts.map((m) => m.mountPoint).sort();
    expect(points).toEqual(
      [
        "/",
        "/dev",
        "/dev/shm",
        "/home/user",
        "/root",
        "/srv",
        "/tmp",
        "/var/log",
        "/var/run",
        "/var/tmp",
      ].sort(),
    );
  });

  it("/dev/shm wins over /dev via longest-prefix match", () => {
    const { io } = buildBrowserMounts(image);
    const shm = io.resolve("/dev/shm/sem.x");
    expect(shm.relativePath).toBe("/sem.x");
    const dev = io.resolve("/dev/null");
    expect(dev.relativePath).toBe("/null");
  });

  it("rootfs files reach the image backend through the router", () => {
    const { io, rootfs } = buildBrowserMounts(image);
    const fd = io.open("/etc/services", O_RDONLY, 0);
    const buf = new Uint8Array(64);
    const n = io.read(fd, buf, null, buf.length);
    io.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toContain("80/tcp");

    const directFd = rootfs.open("/etc/services", O_RDONLY, 0);
    const direct = new Uint8Array(64);
    const m = rootfs.read(directFd, direct, null, direct.length);
    rootfs.close(directFd);
    expect(new TextDecoder().decode(direct.subarray(0, m))).toContain("80/tcp");
  });

  it("scratch /tmp roundtrips a write that does not appear under /", () => {
    const { io } = buildBrowserMounts(image);
    const data = new TextEncoder().encode("ephemeral");
    const fd = io.open("/tmp/note", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    io.write(fd, data, null, data.length);
    io.close(fd);

    const rfd = io.open("/tmp/note", O_RDONLY, 0);
    const buf = new Uint8Array(32);
    const n = io.read(rfd, buf, null, buf.length);
    io.close(rfd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("ephemeral");

    // The image-backed / mount must not see /tmp/note.
    expect(() => io.stat("/tmp/note")).not.toThrow();
    const { rootfs } = buildBrowserMounts(image);
    expect(() => rootfs.stat("/tmp/note")).toThrow();
  });

  it("/home/user and /root resolve to distinct scratch backends", () => {
    const { io } = buildBrowserMounts(image);
    const data = new TextEncoder().encode("h");
    const fdH = io.open("/home/user/x", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    io.write(fdH, data, null, data.length);
    io.close(fdH);
    expect(() => io.stat("/home/user/x")).not.toThrow();
    expect(() => io.stat("/root/x")).toThrow();
  });
});
