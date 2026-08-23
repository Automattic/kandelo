import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  copyWordPressCoreSource,
  isExcludedWordPressCoreSourceEntry,
  isWordPressSetupOnlySourceEntry,
  materializeWordPressSqlitePlugin,
  resolveWordPressCoreSource,
  resolveWordPressSqlitePluginSource,
  WORDPRESS_CORE_GUEST_PATH,
  WORDPRESS_SETUP_SQLITE_PLUGIN_ALIAS,
  WORDPRESS_SQLITE_PLUGIN_GUEST_PATH,
} from "../../images/vfs/scripts/wordpress-source-layout";
import { resolveNodeNpmSource } from "../../images/vfs/scripts/build-node-vfs-image";
import { resolveLampSystemTablesDirectory } from "../../images/vfs/scripts/build-lamp-vfs-image";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_RDONLY = 0;

function readFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

describe("WordPress product source layout", () => {
  it("prefers injected Node and WordPress sources without calling fallbacks", () => {
    const repoRoot = "/reviewed/kandelo";
    const fallback = vi.fn(() => "/network-fallback-must-not-run");

    expect(resolveNodeNpmSource("/resolver/npm", repoRoot, fallback)).toBe(
      "/resolver/npm",
    );
    expect(
      resolveWordPressCoreSource(repoRoot, fallback, "/resolver/wordpress"),
    ).toBe(
      "/resolver/wordpress",
    );
    expect(
      resolveWordPressSqlitePluginSource(
        repoRoot,
        fallback,
        "/resolver/wordpress-sqlite",
      ),
    ).toBe("/resolver/wordpress-sqlite");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses manifest-backed verified fallbacks outside resolver mode", () => {
    const fallback = vi.fn((packageName: string) => `/cache/${packageName}`);

    expect(resolveNodeNpmSource(undefined, "/repo", fallback)).toBe(
      "/cache/node-vfs",
    );
    expect(resolveWordPressCoreSource("/repo", fallback)).toBe(
      "/cache/wordpress",
    );
    expect(resolveWordPressSqlitePluginSource("/repo", fallback)).toBe(
      "/cache/wordpress-sqlite-integration-source",
    );
    expect(fallback.mock.calls).toEqual([
      ["node-vfs", "/repo"],
      ["wordpress", "/repo"],
      ["wordpress-sqlite-integration-source", "/repo"],
    ]);
  });

  it("uses MariaDB's declared runtime root before the direct-build fallback", () => {
    const fallback = vi.fn(() => "/legacy/mysql");

    expect(
      resolveLampSystemTablesDirectory("/resolver/mariadb", fallback),
    ).toBe("/resolver/mariadb/share/mysql");
    expect(fallback).not.toHaveBeenCalled();
    expect(resolveLampSystemTablesDirectory(undefined, fallback)).toBe(
      "/legacy/mysql",
    );
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("copies core while explicitly omitting only reviewed generated entries", () => {
    const root = mkdtempSync(join(tmpdir(), "wordpress-vfs-source-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "wordpress-sqlite-plugin-"));
    try {
      const plugins = join(root, "wp-content", "plugins");
      mkdirSync(plugins, { recursive: true });
      writeFileSync(join(root, "index.php"), "core");
      writeFileSync(join(root, "wp-config.php"), "local config");
      writeFileSync(join(root, "build-state.db"), "database state");
      writeFileSync(join(root, "wp-content", "db.php"), "local drop-in");
      const similarName = join(
        plugins,
        "sqlite-database-integration-copy",
      );
      mkdirSync(similarName);
      writeFileSync(join(similarName, "keep.php"), "kept");
      writeFileSync(join(pluginRoot, "load.php"), "host-only plugin source");
      symlinkSync(
        pluginRoot,
        join(plugins, "sqlite-database-integration"),
      );
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      expect(copyWordPressCoreSource(fs, root)).toBe(2);
      expect(readFile(fs, `${WORDPRESS_CORE_GUEST_PATH}/index.php`)).toBe(
        "core",
      );
      expect(readFile(
        fs,
        `${WORDPRESS_CORE_GUEST_PATH}/wp-content/plugins/` +
          "sqlite-database-integration-copy/keep.php",
      )).toBe("kept");
      expect(() => fs.lstat(WORDPRESS_SQLITE_PLUGIN_GUEST_PATH)).toThrow();
      expect(() =>
        fs.lstat(`${WORDPRESS_CORE_GUEST_PATH}/wp-config.php`)
      ).toThrow();
      expect(() =>
        fs.lstat(`${WORDPRESS_CORE_GUEST_PATH}/build-state.db`)
      ).toThrow();
      expect(() =>
        fs.lstat(`${WORDPRESS_CORE_GUEST_PATH}/wp-content/db.php`)
      ).toThrow();
      expect(isWordPressSetupOnlySourceEntry(
        `${WORDPRESS_SETUP_SQLITE_PLUGIN_ALIAS}/load.php`,
      )).toBe(false);
      expect(isExcludedWordPressCoreSourceEntry(
        "wp-content/plugins/sqlite-database-integration-copy",
      )).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("rejects a similarly named unexpected core-source symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "wordpress-vfs-source-"));
    try {
      const plugins = join(root, "wp-content", "plugins");
      mkdirSync(plugins, { recursive: true });
      writeFileSync(join(root, "index.php"), "core");
      symlinkSync(
        "index.php",
        join(plugins, "sqlite-database-integration-copy"),
      );
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      expect(() => copyWordPressCoreSource(fs, root)).toThrow(
        new RegExp(
          "VFS image source symlink requires preserveSymlinks or an explicit exclude",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes the pinned SQLite plugin source at its guest path", () => {
    const source = mkdtempSync(join(tmpdir(), "wordpress-sqlite-source-"));
    try {
      mkdirSync(join(source, "includes"));
      writeFileSync(join(source, "load.php"), "plugin loader");
      writeFileSync(join(source, "includes", "driver.php"), "driver");
      writeFileSync(join(source, "build-state.db"), "excluded state");
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      expect(materializeWordPressSqlitePlugin(fs, source)).toBe(2);
      expect(readFile(
        fs,
        `${WORDPRESS_SQLITE_PLUGIN_GUEST_PATH}/load.php`,
      )).toBe("plugin loader");
      expect(readFile(
        fs,
        `${WORDPRESS_SQLITE_PLUGIN_GUEST_PATH}/includes/driver.php`,
      )).toBe("driver");
      expect(() =>
        fs.lstat(`${WORDPRESS_SQLITE_PLUGIN_GUEST_PATH}/build-state.db`)
      ).toThrow();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("still rejects every unrelated plugin-source symlink", () => {
    const source = mkdtempSync(join(tmpdir(), "wordpress-sqlite-source-"));
    try {
      writeFileSync(join(source, "load.php"), "plugin loader");
      symlinkSync("load.php", join(source, "unexpected-alias.php"));
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      expect(() => materializeWordPressSqlitePlugin(fs, source)).toThrow(
        new RegExp(
          "VFS image source symlink requires preserveSymlinks or an explicit exclude",
        ),
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});
