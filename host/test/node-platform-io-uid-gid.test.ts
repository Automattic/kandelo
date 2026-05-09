import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";

describe("NodePlatformIO uid/gid normalization", () => {
  let dir: string;
  let file: string;
  let subdir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wasm-posix-node-platform-io-uid-gid-"));
    file = join(dir, "file.txt");
    subdir = join(dir, "sub");
    writeFileSync(file, "hi");
    mkdirSync(subdir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Mirrors the policy in HostFileSystem: uid/gid are normalized to 0
  // (matching Process::new's default euid) so guest programs see
  // host-backed files as self-owned. The real host uid (e.g. macOS user
  // 501) is not exposed to programs running through the kernel.

  it("stat returns uid=0 gid=0 regardless of host uid", () => {
    const io = new NodePlatformIO();
    const st = io.stat(file);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("lstat returns uid=0 gid=0", () => {
    const io = new NodePlatformIO();
    const st = io.lstat(file);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("fstat returns uid=0 gid=0", () => {
    const io = new NodePlatformIO();
    const fd = io.open(file, 0, 0);
    try {
      const st = io.fstat(fd);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(0);
    } finally {
      io.close(fd);
    }
  });

  it("stat on a directory also normalizes", () => {
    const io = new NodePlatformIO();
    const st = io.stat(subdir);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });
});
