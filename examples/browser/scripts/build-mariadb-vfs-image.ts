/**
 * Build a fully-bootable VFS image for the MariaDB browser demo.
 * dinit (PID 1) brings up the selected engine's service tree:
 *
 *   <engine>-bootstrap (scripted, oneshot) → <engine>-mariadb (process)
 *
 * Two engine trees are baked: aria-{bootstrap,mariadb} and
 * innodb-{bootstrap,mariadb}. The page selects which engine to start
 * by passing the service name as dinit's positional argv at boot
 * (e.g. `dinit --container aria-mariadb`); dinit resolves the
 * dependency on the matching bootstrap and brings up only that tree.
 *
 * Two target architectures are supported:
 *   bash build-mariadb-vfs-image.sh           → public/mariadb.vfs     (wasm32)
 *   bash build-mariadb-vfs-image.sh --wasm64  → public/mariadb-64.vfs  (wasm64)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, tryResolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { saveImage } from "./vfs-image-helpers";
import { addDinitInit, type DinitService } from "./dinit-image-helpers";

const REPO_ROOT = findRepoRoot();
const useWasm64 = process.argv.includes("--wasm64");

const MARIADB_INSTALL = useWasm64
  ? join(REPO_ROOT, "examples/libs/mariadb/mariadb-install-64")
  : join(REPO_ROOT, "examples/libs/mariadb/mariadb-install");

const MARIADB_PATH = join(MARIADB_INSTALL, "bin/mariadbd.wasm");
const SYSTEM_TABLES_PATH = join(MARIADB_INSTALL, "share/mysql/mysql_system_tables.sql");
const SYSTEM_DATA_PATH = join(MARIADB_INSTALL, "share/mysql/mysql_system_tables_data.sql");
const DASH_PATH = resolveBinary("programs/dash.wasm");
// Coreutils is required at boot for the bootstrap-runner.sh wrapper
// (sleep, kill — well kill is a dash builtin, but sleep isn't). Bake
// it directly rather than rely on lazy loading, since the kernel-owned
// VFS has no lazy-load path during dinit boot.
const COREUTILS_PATH = tryResolveBinary("programs/coreutils.wasm");

const OUT_FILE = useWasm64
  ? join(REPO_ROOT, "examples/browser/public/mariadb-64.vfs")
  : join(REPO_ROOT, "examples/browser/public/mariadb.vfs");

const COREUTILS_SYMLINK_NAMES = [
  "ls", "cat", "cp", "mv", "rm", "echo", "mkdir", "rmdir", "touch", "pwd",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "date", "basename",
  "dirname", "chmod", "chown", "ln", "readlink", "true", "false", "yes",
  "sleep", "env", "printenv", "id", "whoami", "hostname", "uname", "stat",
  "df", "du", "tee", "nl", "paste", "tac", "rev", "expand", "unexpand",
  "fold", "fmt", "pr", "od", "hexdump", "xxd", "sha256sum", "sha512sum",
  "md5sum", "seq", "test", "[",
];

function commonMariadbArgs(engine: string): string[] {
  return [
    "/usr/sbin/mariadbd", "--no-defaults",
    // mariadbd refuses to run as root by default; we have a mysql user
    // in /etc/passwd (uid 101) precisely for this.
    "--user=mysql",
    "--datadir=/data", "--tmpdir=/data/tmp",
    `--default-storage-engine=${engine}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144",
  ];
}

const INNODB_TUNING = [
  "--innodb-buffer-pool-size=8M",
  "--innodb-log-file-size=4M",
  "--innodb-log-buffer-size=1M",
  "--innodb-flush-log-at-trx-commit=2",
  "--innodb-buffer-pool-load-at-startup=OFF",
  "--innodb-buffer-pool-dump-at-shutdown=OFF",
];

/**
 * Build the daemon service tree for an engine.
 *
 * ─── TEMPORARY WORKAROUND ─────────────────────────────────────────────
 * `<engine>-bootstrap` is wired as a no-op `internal` service because
 * `mariadbd --bootstrap` deadlocks during user-space startup in the
 * wasm port — see the deferred investigation prompt at the top of
 * commit history (and the "MariaDB bootstrap-mode startup hang"
 * follow-up). Symptom: mariadbd-bootstrap makes ~4 syscalls (libc
 * heap setup), then no further syscalls for 60+ seconds. Disassembly
 * traced the hang to wasm-LD-injected init function 16, called by
 * `_start` before any of mariadbd's user code runs. Daemon-mode
 * mariadbd (same binary, same kernel, no `--bootstrap`) sails through
 * that same code path — almost certainly a concurrency / atomic-wait
 * timing interaction in our centralized kernel-worker, not a
 * mariadbd bug.
 *
 * Trade-off of the workaround: `mysql.*` system tables are NOT
 * created. Anything querying `mysql.user` etc. fails. The demo's
 * example queries (`SELECT VERSION()`, `CREATE TABLE` in `test`,
 * `INSERT`, `SELECT`, `SHOW TABLES FROM test`, `SHOW DATABASES`) all
 * work because Aria creates table files lazily and the queries don't
 * touch the missing system tables. The boot is also dramatically
 * faster — no 30s sleep waiting for the wedged bootstrap process.
 *
 * Re-enable the real bootstrap pass once the startup hang is fixed
 * by reverting this to a `type: "scripted"` service that runs
 * `mariadbd --bootstrap < bootstrap.sql`. The bootstrap SQL file
 * is still baked into the VFS at /etc/mariadb/bootstrap.sql so
 * nothing needs to be re-emitted.
 * ──────────────────────────────────────────────────────────────────────
 */
function buildEngineServices(engine: "Aria" | "InnoDB"): DinitService[] {
  const tag = engine === "Aria" ? "aria" : "innodb";
  const args = commonMariadbArgs(engine);
  const innodbArgs = engine === "InnoDB" ? INNODB_TUNING : [];
  const daemonCmd = [
    ...args, ...innodbArgs,
    "--skip-networking=0", "--port=3306",
    "--bind-address=0.0.0.0", "--socket=",
    "--max-connections=10", "--thread-handling=no-threads",
    `--log-error=/data/${tag}-error.log`,
  ].join(" ");

  return [
    {
      // No-op anchor service. dinit considers `internal` services started
      // immediately, satisfying the daemon's depends-on with zero work.
      name: `${tag}-bootstrap`,
      type: "internal",
      restart: false,
    },
    {
      name: `${tag}-mariadb`,
      type: "process",
      command: daemonCmd,
      dependsOn: [`${tag}-bootstrap`],
      logfile: `/var/log/${tag}-mariadb.log`,
      restart: false,
    },
  ];
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

  const sab = new SharedArrayBuffer(64 * 1024 * 1024, { maxByteLength: 256 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 256 * 1024 * 1024);

  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/root", "/usr/sbin",
    "/data", "/data/mysql", "/data/tmp", "/data/test",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  // dash + coreutils symlinks (page registers coreutils.wasm lazily).
  if (existsSync(DASH_PATH)) {
    writeVfsBinary(fs, "/bin/dash", new Uint8Array(readFileSync(DASH_PATH)));
    symlink(fs, "/bin/dash", "/bin/sh");
    symlink(fs, "/bin/dash", "/usr/bin/dash");
    symlink(fs, "/bin/dash", "/usr/bin/sh");
  }
  // Bake coreutils.wasm — the bootstrap-runner.sh wrapper uses `sleep`
  // (a coreutils applet) at boot before any lazy-load mechanism can run.
  if (COREUTILS_PATH && existsSync(COREUTILS_PATH)) {
    writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_PATH)));
  } else {
    console.warn("  Warning: coreutils.wasm not found — bootstrap wrapper will fail at sleep");
  }
  for (const name of COREUTILS_SYMLINK_NAMES) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }

  console.log("  Writing mariadbd binary...");
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(readFileSync(MARIADB_PATH)));

  console.log("  Writing bootstrap SQL...");
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTables = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemData = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // Bootstrap-runner scripts are NOT emitted while the bootstrap pass is
  // disabled (see the workaround note on `buildEngineServices`). The
  // bootstrap SQL itself is still written above so re-enabling is a
  // single-file change once the underlying hang is fixed.

  // Bake both engine trees, no implicit boot — page selects which engine
  // to start by passing `<engine>-mariadb` as dinit's positional argv.
  addDinitInit(
    fs,
    [...buildEngineServices("Aria"), ...buildEngineServices("InnoDB")],
    { boot: false },
  );

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
