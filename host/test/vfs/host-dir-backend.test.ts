import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  HostDirBackend,
  HOST_DIR_DEFAULT_UID,
  HOST_DIR_DEFAULT_GID,
} from "../../src/vfs/backends/host-dir-backend";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("HostDirBackend", () => {
  let scratch: string;
  let backend: HostDirBackend;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "hostdir-test-"));
    backend = new HostDirBackend(scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("translates sub-paths to host paths under hostRoot", () => {
    writeFileSync(join(scratch, "hello"), "world\n");
    const fd = backend.open("/hello", 0, 0);
    const buf = new Uint8Array(16);
    const n = backend.read(fd, buf, null, buf.byteLength);
    backend.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("world\n");
  });

  it("reports uid/gid as 1000 regardless of real host owner", () => {
    writeFileSync(join(scratch, "file"), "x");
    const st = backend.stat("/file");
    expect(st.uid).toBe(HOST_DIR_DEFAULT_UID);
    expect(st.gid).toBe(HOST_DIR_DEFAULT_GID);
  });

  it("fstat also reports uid/gid=1000", () => {
    writeFileSync(join(scratch, "file"), "x");
    const fd = backend.open("/file", 0, 0);
    const st = backend.fstat(fd);
    backend.close(fd);
    expect(st.uid).toBe(1000);
    expect(st.gid).toBe(1000);
  });

  it("rejects path traversal via ..", () => {
    expect(() => backend.stat("/foo/../../etc/passwd")).toThrow(/EACCES/);
    expect(() => backend.open("/..", 0, 0)).toThrow(/EACCES/);
    expect(() => backend.unlink("/a/../b/..")).toThrow(/EACCES/);
  });

  it("mkdir, unlink, rename, readdir work against hostRoot", () => {
    backend.mkdir("/sub", 0o755);
    expect(existsSync(join(scratch, "sub"))).toBe(true);

    const fd = backend.open("/sub/f", 0x0001 | 0x0040 | 0x0200, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    backend.write(fd, new TextEncoder().encode("hi"), null, 2);
    backend.close(fd);
    expect(readFileSync(join(scratch, "sub/f"), "utf8")).toBe("hi");

    const dh = backend.opendir("/sub");
    const names: string[] = [];
    while (true) {
      const e = backend.readdir(dh);
      if (!e) break;
      if (e.name !== "." && e.name !== "..") names.push(e.name);
    }
    backend.closedir(dh);
    expect(names).toEqual(["f"]);

    backend.rename("/sub/f", "/sub/g");
    expect(existsSync(join(scratch, "sub/g"))).toBe(true);

    backend.unlink("/sub/g");
    expect(existsSync(join(scratch, "sub/g"))).toBe(false);
  });

  it("chown updates the VFS's view; subsequent stat returns the new uid/gid", () => {
    writeFileSync(join(scratch, "file"), "x");
    backend.chown("/file", 500, 600);
    const st = backend.stat("/file");
    expect(st.uid).toBe(500);
    expect(st.gid).toBe(600);
  });

  it("chmod updates the VFS's perm bits without touching the host", () => {
    writeFileSync(join(scratch, "file"), "x", { mode: 0o644 });
    backend.chmod("/file", 0o600);
    const st = backend.stat("/file");
    expect(st.mode & 0o777).toBe(0o600);
    // Host file's mode is unchanged — VFS owns the view
    const hostMode = (require("node:fs").statSync(join(scratch, "file")).mode) & 0o777;
    expect(hostMode).toBe(0o644);
  });

  it("fchmod / fchown via fd update the same shadow entry as the path-based ops", () => {
    writeFileSync(join(scratch, "file"), "x", { mode: 0o644 });
    const fd = backend.open("/file", 0, 0);
    backend.fchown(fd, 42, 43);
    backend.fchmod(fd, 0o700);
    const st = backend.fstat(fd);
    backend.close(fd);
    expect(st.uid).toBe(42);
    expect(st.gid).toBe(43);
    expect(st.mode & 0o777).toBe(0o700);

    // Path-based stat sees the same thing
    const pst = backend.stat("/file");
    expect(pst.uid).toBe(42);
    expect(pst.mode & 0o777).toBe(0o700);
  });

  it("rename moves the shadow metadata along with the file", () => {
    writeFileSync(join(scratch, "a"), "x");
    backend.chown("/a", 500, 600);
    backend.rename("/a", "/b");
    const st = backend.stat("/b");
    expect(st.uid).toBe(500);
    expect(st.gid).toBe(600);
  });

  it("unlink removes the shadow entry", () => {
    writeFileSync(join(scratch, "file"), "x");
    backend.chown("/file", 500, 600);
    backend.unlink("/file");
    // Re-create the file; it should default back to 1000/1000
    writeFileSync(join(scratch, "file"), "y");
    const st = backend.stat("/file");
    expect(st.uid).toBe(1000);
    expect(st.gid).toBe(1000);
  });

  it("files staged on the host default to uid/gid=1000, host's mode", () => {
    writeFileSync(join(scratch, "staged"), "x", { mode: 0o640 });
    const st = backend.stat("/staged");
    expect(st.uid).toBe(HOST_DIR_DEFAULT_UID);
    expect(st.gid).toBe(HOST_DIR_DEFAULT_GID);
    expect(st.mode & 0o777).toBe(0o640);
  });

  it("createIfMissing creates the hostRoot", () => {
    const nested = join(scratch, "nested", "deep");
    const b = new HostDirBackend(nested, { createIfMissing: true });
    expect(existsSync(nested)).toBe(true);
    b.mkdir("/x", 0o755);
    expect(existsSync(join(nested, "x"))).toBe(true);
  });

  it("hostPathFor exposes the host path (for test staging)", () => {
    expect(backend.hostPathFor("/foo/bar")).toBe(join(scratch, "foo/bar"));
    expect(backend.hostPathFor("/")).toBe(scratch);
  });

  it("symlink + readlink round-trips the target verbatim", () => {
    backend.symlink("/etc/localtime", "/localtime-link");
    expect(backend.readlink("/localtime-link")).toBe("/etc/localtime");
  });
});
