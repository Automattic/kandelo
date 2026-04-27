/**
 * Build a pre-built VFS image for the MariaDB browser demo.
 *
 * The image contains everything needed at boot time:
 *   - mariadbd binary                (/usr/sbin/mariadbd)
 *   - bootstrap SQL                  (/etc/mariadb/bootstrap.sql)
 *   - data directory tree            (/data, /data/mysql, /data/tmp, /data/test)
 *   - shell init descriptors         (/etc/init.d/05-mariadb-bootstrap, 10-mariadb)
 *   - dash + coreutils/grep/sed symlinks for the companion terminal panel
 *
 * The demo page overrides the init-descriptor command lines at runtime to
 * switch storage engine and InnoDB tuning, so we only include sensible Aria
 * defaults here.
 *
 * Two target architectures are supported:
 *   bash build-mariadb-vfs-image.sh           → examples/browser/public/mariadb.vfs     (wasm32)
 *   bash build-mariadb-vfs-image.sh --wasm64  → examples/browser/public/mariadb-64.vfs  (wasm64)
 *
 * Produces: examples/browser/public/mariadb[-64].vfs
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink,
  saveImage,
} from "./vfs-image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const BROWSER_DIR = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(BROWSER_DIR, "..", "..");

const useWasm64 = process.argv.includes("--wasm64");
const MARIADB_INSTALL = useWasm64
  ? join(REPO_ROOT, "examples/libs/mariadb/mariadb-install-64")
  : join(REPO_ROOT, "examples/libs/mariadb/mariadb-install");

const MARIADB_PATH = join(MARIADB_INSTALL, "bin/mariadbd.wasm");
const SYSTEM_TABLES_PATH = join(MARIADB_INSTALL, "share/mysql/mysql_system_tables.sql");
const SYSTEM_DATA_PATH = join(MARIADB_INSTALL, "share/mysql/mysql_system_tables_data.sql");

import { resolveBinary } from "../../../host/src/binary-resolver";
const DASH_PATH = resolveBinary("programs/dash.wasm");

const OUT_FILE = useWasm64
  ? join(BROWSER_DIR, "public", "mariadb-64.vfs")
  : join(BROWSER_DIR, "public", "mariadb.vfs");

// Shell binaries that appear as symlinks to be materialized lazily by the page.
// The actual binaries are NOT baked into the image — the demo registers them
// with kernel.registerLazyFiles at runtime to keep the image small.
const COREUTILS_SYMLINK_NAMES = [
  "ls", "cat", "cp", "mv", "rm", "echo", "mkdir", "rmdir", "touch", "pwd",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "date", "basename",
  "dirname", "chmod", "chown", "ln", "readlink", "true", "false", "yes",
  "sleep", "env", "printenv", "id", "whoami", "hostname", "uname", "stat",
  "df", "du", "tee", "nl", "paste", "tac", "rev", "expand", "unexpand",
  "fold", "fmt", "pr", "od", "hexdump", "xxd", "sha256sum", "sha512sum",
  "md5sum", "seq", "test", "[",
];

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/root", "/usr/sbin",
    "/data", "/data/mysql", "/data/tmp", "/data/test",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
}

function populateDash(fs: MemoryFileSystem): void {
  if (!existsSync(DASH_PATH)) {
    console.warn(`  Skipping dash (not built): ${DASH_PATH}`);
    return;
  }
  const dashBytes = readFileSync(DASH_PATH);
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateShellSymlinks(fs: MemoryFileSystem): void {
  // Coreutils/grep/sed are registered lazily by the page via kernel.registerLazyFiles.
  // We only need the symlinks here so dash can resolve them from PATH.
  for (const name of COREUTILS_SYMLINK_NAMES) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
}

function populateInitDescriptors(fs: MemoryFileSystem, engine: string): void {
  ensureDirRecursive(fs, "/etc/init.d");

  const commonArgs = [
    "/usr/sbin/mariadbd", "--no-defaults",
    "--datadir=/data", "--tmpdir=/data/tmp",
    `--default-storage-engine=${engine}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144",
  ];

  writeVfsFile(fs, "/etc/init.d/05-mariadb-bootstrap", [
    "type=oneshot",
    `command=${[...commonArgs,
      "--bootstrap", "--skip-networking", "--log-warnings=0",
      "--log-error=/data/bootstrap.log",
    ].join(" ")}`,
    "stdin=/etc/mariadb/bootstrap.sql",
    "ready=stdin-consumed",
    "terminate=true",
    "",
  ].join("\n"));

  writeVfsFile(fs, "/etc/init.d/10-mariadb", [
    "type=daemon",
    `command=${[...commonArgs,
      "--skip-networking=0", "--port=3306",
      "--bind-address=0.0.0.0", "--socket=",
      "--max-connections=10", "--thread-handling=no-threads",
      "--log-error=/data/error.log",
    ].join(" ")}`,
    "depends=mariadb-bootstrap",
    "ready=port:3306",
    "",
  ].join("\n"));
}

async function main() {
  if (!existsSync(MARIADB_PATH)) {
    const flag = useWasm64 ? " --wasm64" : "";
    console.error(`mariadbd.wasm not found at ${MARIADB_PATH}.`);
    console.error(`Run: bash examples/libs/mariadb/build-mariadb.sh${flag}`);
    process.exit(1);
  }

  if (!existsSync(SYSTEM_TABLES_PATH) || !existsSync(SYSTEM_DATA_PATH)) {
    console.error(`MariaDB bootstrap SQL files missing from ${MARIADB_INSTALL}/share/mysql/`);
    process.exit(1);
  }

  console.log(`==> Building MariaDB VFS image (${useWasm64 ? "wasm64" : "wasm32"})`);

  // 32MB SAB is enough: mariadbd.wasm (~13MB on wasm32, ~16MB on wasm64) plus
  // bootstrap SQL (~500KB) and dash + init descriptors (negligible) fit easily.
  const sab = new SharedArrayBuffer(32 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  populateSystem(fs);
  populateDash(fs);
  populateShellSymlinks(fs);

  console.log("  Writing mariadbd binary...");
  const mariadbBytes = readFileSync(MARIADB_PATH);
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));

  console.log("  Writing bootstrap SQL...");
  const systemTables = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemData = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  ensureDirRecursive(fs, "/etc/mariadb");
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  populateInitDescriptors(fs, "Aria");

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
