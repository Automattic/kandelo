import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { assertKandeloFilesystemLayout } from "../../images/vfs/scripts/filesystem-layout";
import { COREUTILS_NAMES, coreutilsCommandPath, SHELL_LAZY_BINARY_SPECS } from "../../images/vfs/lib/init/shell-binaries";
import { populateShellRuntimeLayout } from "../src/shell-runtime-layout";
import { ensureDirRecursive, symlink, writeVfsFile } from "../src/vfs/image-helpers";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";

describe("Kandelo FHS image layout", () => {
  it("gives the base manifest and lazy composer the same single coreutils paths", () => {
    const manifest = readFileSync(new URL("../../images/rootfs/PACKAGES.toml", import.meta.url), "utf8");
    const coreutils = manifest.split('name = "coreutils"')[1].split("[[packages]]")[0];
    const installed = [...coreutils.matchAll(/"(\/(?:usr\/)?(?:s?bin)\/[^\"]+)"/g)].map(m => m[1]);
    const expected = ["/bin/coreutils", ...[...COREUTILS_NAMES, "["].map(coreutilsCommandPath)];
    expect(installed.sort()).toEqual([...expected].sort());
    expect(SHELL_LAZY_BINARY_SPECS.find(s => s.id === "coreutils")?.symlinks).toEqual(expected.slice(1));
    expect(coreutilsCommandPath("ls")).toBe("/bin/ls");
    expect(coreutilsCommandPath("sha256sum")).toBe("/usr/bin/sha256sum");
    expect(coreutilsCommandPath("chroot")).toBe("/usr/sbin/chroot");
  });

  it("preserves multicall aliases and empty administrator directories", () => {
    const fs = KandeloImageFs.create();
    populateShellRuntimeLayout(fs);
    writeVfsFile(fs, "/bin/coreutils", "multicall", 0o755);
    for (const name of [...COREUTILS_NAMES, "["]) symlink(fs, "/bin/coreutils", coreutilsCommandPath(name));
    expect(() => assertKandeloFilesystemLayout(fs)).not.toThrow();
    expect(fs.readlink("/var/run")).toBe("/run");
    expect(fs.readlink("/var/lock")).toBe("/run/lock");
    expect(fs.stat("/tmp").mode & 0o7777).toBe(0o1777);
    expect(fs.stat("/var/tmp").mode & 0o7777).toBe(0o1777);
  });

  it("keeps installed FHS recovery tools in /bin", () => {
    const manifest = readFileSync(new URL("../../images/rootfs/PACKAGES.toml", import.meta.url), "utf8");
    for (const command of ["more", "ed"]) {
      expect(manifest).toContain(`path = "/bin/${command}"`);
      expect(manifest).not.toContain(`"/usr/bin/${command}"`);
    }
    for (const [id, paths] of [["tar", ["/bin/tar"]], ["gzip", ["/bin/gzip", "/bin/gunzip", "/bin/zcat"]]] as const) {
      const spec = SHELL_LAZY_BINARY_SPECS.find(s => s.id === id)!;
      expect([spec.vfsPath, ...spec.symlinks]).toEqual(paths);
    }
  });

  it("rejects a duplicated command even when both names refer to one inode", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/bin");
    writeVfsFile(fs, "/bin/cat", "cat", 0o755);
    ensureDirRecursive(fs, "/usr/bin");
    symlink(fs, "/bin/cat", "/usr/bin/cat");
    expect(() => assertKandeloFilesystemLayout(fs)).toThrow("/bin/cat duplicates /usr/bin/cat");
  });

  it("rejects lazy shipped files under /usr/local without reading them", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/usr/local/bin");
    fs.registerLazyFile("/usr/local/bin/editor", "https://invalid.example/editor", 100, 0o755);
    const read = vi.spyOn(fs, "readFile");
    expect(() => assertKandeloFilesystemLayout(fs)).toThrow("/usr/local/bin/editor");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["/data", "/sqlite", "/php-src", "/mysql-test", "/var/www", "/usr/wasm32posix"])("rejects retired product root %s", path => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, path);
    expect(() => assertKandeloFilesystemLayout(fs)).toThrow(path);
  });

  it("does not hide inspection errors as missing directories", () => {
    const fs = KandeloImageFs.create();
    vi.spyOn(fs, "lstat").mockImplementation(() => { throw new Error("read failed"); });
    expect(() => assertKandeloFilesystemLayout(fs)).toThrow("read failed");
  });

  it("rejects mutable game directories in /usr while allowing game state in /var/games", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/var/games/quake", 0o755);
    expect(() => assertKandeloFilesystemLayout(fs)).not.toThrow();
    ensureDirRecursive(fs, "/usr/share/quake", 0o777);
    expect(() => assertKandeloFilesystemLayout(fs)).toThrow("/usr/share/quake: mutable data");
  });

  it("retains /var/tmp and logs across Node reboots while clearing runtime files", async () => {
    const image = new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst")));
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fhs-reboot-"));
    let closed = true;
    try {
      for (const recovered of [false, true]) {
        let output = "";
        const append = (_pid: number, bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
        const host = new NodeKernelHost({
          rootfsImage: image,
          experimentalResizablePersistencePath: join(directory, "journal"),
          requireExistingRootfsPersistence: recovered,
          onStdout: append, onStderr: append,
        });
        closed = false;
        try {
          await host.init();
          const runtime = await host.statVfsPath("/run/user/1000");
          expect(runtime).toMatchObject({ uid: 1000, gid: 1000 });
          expect(runtime!.mode & 0o7777).toBe(0o700);
          expect((await host.statVfsPath("/var/tmp"))!.mode & 0o7777).toBe(0o1777);
          const source = recovered
            ? '[[ $(</var/tmp/fhs-marker) == retained && ! -e /run/user/1000/fhs-marker && ! -e /tmp/fhs-marker ]]'
            : '[[ -L /var/run ]] && printf retained > /var/tmp/fhs-marker && printf transient > /var/run/user/1000/fhs-marker && printf transient > /tmp/fhs-marker';
          const process = await host.spawnFromVfs("/bin/bash", ["bash", "-c", source], {
            uid: 1000, gid: 1000, cwd: "/home/maker",
            env: ["HOME=/home/maker", "PATH=/usr/bin:/bin"],
          });
          expect(await process.exit, output).toBe(0);
          if (recovered) {
            expect(new TextDecoder().decode((await host.readFileFromVfs("/var/log/fhs-marker"))!)).toBe("retained log");
          } else {
            await host.writeFileToVfs("/var/log/fhs-marker", new TextEncoder().encode("retained log"), 0o640);
            expect(new TextDecoder().decode((await host.readFileFromVfs("/run/user/1000/fhs-marker"))!)).toBe("transient");
          }
        } finally {
          await host.destroy();
          closed = true;
        }
      }
    } finally {
      if (closed) rmSync(directory, { recursive: true, force: true });
      else console.error(`Retained FHS journal after unproven shutdown: ${directory}`);
    }
  }, 90_000);
});
