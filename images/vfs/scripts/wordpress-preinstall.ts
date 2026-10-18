/**
 * Build-time WordPress installer for the browser demo VFS images.
 *
 * The builder's image filesystem is only a source snapshot for a temporary
 * NodeKernelHost boot, so mutations made by PHP/MariaDB inside that kernel
 * must be streamed back to the builder. This mirrors opcache-prewarm's stdout
 * dump protocol, but preserves directory/file ownership and modes for DB data.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeKernelHost, type NodeKernelHostOptions } from "../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../host/src/binary-resolver";
import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { saveShellDerivedBuildGuestSnapshot } from "./package-shell-vfs-build";
import { sourceDateEpochMilliseconds } from "./vfs-image-helpers";
import { WORDPRESS_SECRET_NAMES } from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";

export const WORDPRESS_DEFAULT_SITE_TITLE = "WordPress on Kandelo";
export const WORDPRESS_DEFAULT_ADMIN_USER = "admin";
export const WORDPRESS_DEFAULT_ADMIN_PASSWORD = "password";
export const WORDPRESS_DEFAULT_ADMIN_EMAIL = "admin@example.com";

const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
const MYSQL_UID = 101;
const MYSQL_GID = 101;
const MARIADB_PREINSTALL_SOCKET_PATH = "/data/mysql.sock";
const MARIADB_ARIA_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_ARIA_PAGECACHE_SIZE = 1024 * 1024;
const MARIADB_INNODB_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_INNODB_LOG_BUFFER_SIZE = 1024 * 1024;
const MARIADB_INNODB_BUFFER_POOL_SIZE = 8 * 1024 * 1024;

const BASE_ENV = [
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
];

const PHP_ARGS = [
  "php",
  "-c", "/etc/php.ini",
  "-d", "opcache.enable_cli=0",
  "-d", "memory_limit=512M",
  "-d", `mysqli.default_socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
  "-d", `pdo_mysql.default_socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
  "-r",
];

/**
 * Seeds naming each build step's deterministic guest (see
 * `preinstallDeterminism`). Distinct per step so their entropy streams are
 * unrelated; fixed so every build of a step draws the same bytes. Changing
 * one changes the image, like any other build input.
 */
const DETERMINISM_SEED_WORDPRESS_SQLITE_INSTALL = 0x5750_0001;
const DETERMINISM_SEED_WORDPRESS_MARIADB_INSTALL = 0x5750_0002;

const DUMP_BEGIN = "===WPDB_DUMP_BEGIN===\n";
const DUMP_END = "===WPDB_DUMP_END===";

interface KernelSession {
  host: NodeKernelHost;
  runPhp: (phase: string, script: string, opts?: RunPhpOptions) => Promise<Uint8Array>;
  runPhpToHostFile: (
    phase: string,
    script: string,
    fileName: string,
    opts?: RunPhpOptions,
  ) => Promise<Uint8Array>;
  runProgram: (
    phase: string,
    bytes: ArrayBuffer,
    argv: string[],
    opts?: RunProgramOptions,
  ) => Promise<number>;
}

interface RunPhpOptions {
  cwd?: string;
  uid?: number;
  gid?: number;
  timeoutMs?: number;
}

interface RunProgramOptions {
  cwd?: string;
  timeoutMs?: number;
}

interface DumpRecord {
  type: "dir" | "file";
  path: string;
  mode: number;
  uid: number;
  gid: number;
  content?: Uint8Array;
}

interface PreinstallKernelHostOptions extends NodeKernelHostOptions {
  /**
   * Names this build's deterministic guest (see `preinstallDeterminism`).
   * Every build-time kernel boot of an installer passes one.
   */
  determinismSeed: number;
  programs?: WordPressPreinstallPrograms;
}

export interface WordPressPreinstallPrograms {
  kernel: Uint8Array;
  php: Uint8Array;
  mariadb?: Uint8Array;
}

export async function preinstallWordPressSqlite(
  fs: VfsImageFilesystem,
  programs?: WordPressPreinstallPrograms,
): Promise<void> {
  console.log("[wp-preinstall:sqlite] installing WordPress into SQLite database...");
  await withKernelSession(fs, async (session) => {
    await session.runPhp("install", wordpressInstallScript(), {
      cwd: "/var/www/html",
      uid: PHP_FPM_UID,
      gid: PHP_FPM_GID,
      timeoutMs: 120_000,
    });
    const dump = await session.runPhp("dump sqlite database", dumpScript([
      "/var/www/html/wp-content/database",
    ]), {
      cwd: "/var/www/html",
      timeoutMs: 120_000,
    });
    const written = ingestDump(dump, fs);
    assertVfsPath(fs, "/var/www/html/wp-content/database/wordpress.db");
    console.log(`[wp-preinstall:sqlite] wrote ${written} database entries`);
  }, { programs, determinismSeed: DETERMINISM_SEED_WORDPRESS_SQLITE_INSTALL });
}

export async function preinstallWordPressMariaDb(
  fs: VfsImageFilesystem,
  programs?: WordPressPreinstallPrograms,
): Promise<void> {
  console.log("[wp-preinstall:mariadb] initializing MariaDB /data and installing WordPress...");
  const mariadbBytes = programs?.mariadb === undefined
    ? loadProgram("programs/mariadb/mariadbd.wasm")
    : exactProgramBuffer(programs.mariadb, "WordPress MariaDB");
  // /data lives in the booted kernel's own filesystem, as it does on a
  // running machine. It used to be a host directory mounted into the guest,
  // which made the image depend on the build host: on macOS's
  // case-insensitive APFS, MariaDB switched itself to
  // lower_case_table_names=2, on Linux it did not. It also needed a fixed
  // 60-second wait and a kill to end the bootstrap, because the host could
  // only watch for files to appear. Now the bootstrap runs to completion, the
  // server shuts down cleanly, and /data is copied out through the guest.
  await withKernelSession(fs, async (session) => {
    try {
      const started = Date.now();
      await bootstrapMariaDbSystemTables(session, fs, mariadbBytes);
      console.log(`[wp-preinstall:mariadb] bootstrap done in ${Date.now() - started} ms`);
      await installWordPressIntoMariaDb(session, mariadbBytes);
      console.log(`[wp-preinstall:mariadb] install and shutdown done in ${Date.now() - started} ms`);
    } catch (err) {
      const diagnostics = await collectMariaDbDiagnostics(session.host);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}\n${diagnostics}`);
    }
    // Copy /data out through the guest, the same way the SQLite database is
    // dumped, preserving each entry's mode and owner.
    const dump = await session.runPhpToHostFile(
      "dump MariaDB data directory",
      dumpScript(["/data"], "/host-dump/data.dump"),
      "data.dump",
      { cwd: "/", timeoutMs: 300_000 },
    );
    const written = ingestDump(dump, fs);
    assertVfsPath(fs, "/data/mysql");
    assertVfsPath(fs, "/data/wordpress");
    ensureMariaDbDataOwnership(fs);
    console.log(`[wp-preinstall:mariadb] wrote ${written} /data entries`);
  }, {
    determinismSeed: DETERMINISM_SEED_WORDPRESS_MARIADB_INSTALL,
    maxWorkers: 16,
    dataBufferSize: 256 * 1024,
    programs,
  });
}

/**
 * Start the server on the bootstrapped /data, run the WordPress installer
 * against it, and shut it down cleanly: `innodb_fast_shutdown=0` makes InnoDB
 * finish purge and flush everything before it exits, so the image's data
 * files carry no work left for crash recovery.
 */
async function installWordPressIntoMariaDb(
  session: KernelSession,
  mariadbBytes: ArrayBuffer,
): Promise<void> {
  let serverDone = false;
  let mariadbPid = 0;
  const serverExit = session.host.spawn(
    mariadbBytes,
    ["mariadbd", ...mariadbServerArgs()],
    {
      env: BASE_ENV,
      cwd: "/data",
      onStarted: (pid) => {
        mariadbPid = pid;
      },
    },
  );
  serverExit.then(() => { serverDone = true; }, () => { serverDone = true; });
  try {
    // A separate process waits for the socket, so that however long that
    // takes never reaches the installer's own (deterministic) clock.
    await session.runPhp("wait for MariaDB", waitForMariaDbSocketScript(), {
      cwd: "/",
      timeoutMs: 180_000,
    });
    await session.runPhp("install", wordpressInstallScript(), {
      cwd: "/var/www/html",
      timeoutMs: 240_000,
    });
    await session.runPhp("shutdown MariaDB", shutdownMariaDbScript(), {
      cwd: "/var/www/html",
      timeoutMs: 30_000,
    });
    const code = await withTimeout(serverExit, 180_000, "mariadbd did not shut down");
    if (code !== 0) throw new Error(`mariadbd exited with code ${code} after SHUTDOWN`);
  } finally {
    if (!serverDone && mariadbPid !== 0 && await isProcessLive(session.host, mariadbPid)) {
      await session.host.terminateProcess(mariadbPid, 0).catch(() => {});
      await Promise.race([serverExit, delay(2_000)]).catch(() => {});
    }
  }
}

async function withKernelSession(
  fs: VfsImageFilesystem,
  fn: (session: KernelSession) => Promise<void>,
  hostOptions: PreinstallKernelHostOptions,
): Promise<void> {
  const imageBytes = await saveShellDerivedBuildGuestSnapshot(fs);
  const hostDumpDir = mkdtempSync(join(tmpdir(), "wp-preinstall-dump-"));
  const {
    programs,
    determinismSeed,
    ...nodeHostOptions
  } = hostOptions;
  let activeStdoutSink: ((data: Uint8Array) => void) | null = null;
  let activeStdoutLabel = "";
  const host = new NodeKernelHost({
    ...nodeHostOptions,
    imageBuildDeterminism: preinstallDeterminism(determinismSeed),
    extraMounts: [
      ...(nodeHostOptions.extraMounts ?? []),
      { mountPoint: "/host-dump", hostPath: hostDumpDir },
    ],
    rootfsImage: imageBytes,
    onStdout: (_pid, data) => {
      activeStdoutSink?.(new Uint8Array(data));
    },
    onStderr: (_pid, data) => {
      const text = new TextDecoder().decode(data);
      if (text.trim().length === 0) return;
      process.stderr.write(activeStdoutLabel ? `[wp-preinstall:${activeStdoutLabel}] ${text}` : text);
    },
  });

  try {
    await host.init(programs === undefined
      ? undefined
      : exactProgramBuffer(programs.kernel, "WordPress kernel"));
    const phpBytes = programs === undefined
      ? loadProgram("programs/php/php.wasm")
      : exactProgramBuffer(programs.php, "WordPress PHP");
    const session: KernelSession = {
      host,
      runPhp: async (phase, script, opts = {}) => {
        const chunks: Uint8Array[] = [];
        activeStdoutLabel = phase;
        activeStdoutSink = (data) => chunks.push(data);
        try {
          const exitCode = await withTimeout(
            host.spawn(
              phpBytes,
              [...PHP_ARGS, script],
              {
                env: BASE_ENV,
                cwd: opts.cwd,
                uid: opts.uid,
                gid: opts.gid,
              },
            ),
            opts.timeoutMs ?? 120_000,
            `php ${phase} timed out`,
          );
          if (exitCode !== 0) {
            const stdout = new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks));
            throw new Error(`php ${phase} exited with code ${exitCode}${stdout ? `\n${stdout.slice(-4096)}` : ""}`);
          }
          return concatChunks(chunks);
        } finally {
          activeStdoutSink = null;
          activeStdoutLabel = "";
        }
      },
      runPhpToHostFile: async (phase, script, fileName, opts = {}) => {
        const hostPath = join(hostDumpDir, fileName);
        rmSync(hostPath, { force: true });
        await session.runPhp(phase, script, opts);
        const bytes = readFileSync(hostPath);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      runProgram: async (phase, bytes, argv, opts = {}) => {
        activeStdoutLabel = phase;
        try {
          const exitCode = await withTimeout(
            host.spawn(bytes, argv, {
              env: BASE_ENV,
              cwd: opts.cwd,
            }),
            opts.timeoutMs ?? 120_000,
            `${phase} timed out`,
          );
          if (exitCode !== 0) {
            throw new Error(`${phase} exited with code ${exitCode}`);
          }
          return exitCode;
        } finally {
          activeStdoutLabel = "";
        }
      },
    };
    await fn(session);
  } finally {
    await host.destroy().catch(() => {});
    rmSync(hostDumpDir, { recursive: true, force: true });
  }
}

/**
 * The installer runs against a deterministic guest: its wall clock starts at
 * the instant the finished image stamps on every inode (SOURCE_DATE_EPOCH,
 * or Kandelo's reference instant when unset) and its entropy is seeded by
 * `seed`. WordPress's install timestamps and password salt, and MariaDB's
 * table UUIDs, are then the same on every build, so the image is a function
 * of its inputs and two builds under one cache key agree.
 *
 * Everything seeded here is public -- anyone can rebuild it -- so nothing it
 * produces may remain a secret on a running machine. The image's first-boot
 * service replaces the WordPress keys and salts from the machine's real
 * entropy (`wordpressFirstBootSecretsService`), and the build installs with
 * public placeholder keys (`buildOnlyWordPressSecrets`). Why the image is
 * built this way rather than installed on first boot is recorded in
 * `docs/package-management.md` ("Reproducible VFS image packages").
 */
function preinstallDeterminism(seed: number): NonNullable<NodeKernelHostOptions["imageBuildDeterminism"]> {
  return {
    seed,
    epochSeconds: sourceDateEpochMilliseconds(process.env.SOURCE_DATE_EPOCH) / 1000,
  };
}

function loadProgram(binaryId: string): ArrayBuffer {
  const bytes = readFileSync(resolveBinary(binaryId));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function exactProgramBuffer(bytes: Uint8Array, label: string): ArrayBuffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`${label} input is empty`);
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function mariadbServerArgs(): string[] {
  return [
    "--no-defaults",
    "--user=mysql",
    "--datadir=/data",
    "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria",
    `--aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE}`,
    `--aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE}`,
    `--innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE}`,
    `--innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE}`,
    `--innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    "--skip-networking",
    `--socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
    "--max-connections=10",
    "--log-error=/data/error.log",
    ...MARIADB_BUILD_ONLY_ARGS,
  ];
}

/**
 * Build-time server settings that take timer-driven background work out of
 * what the installer's server writes, so less of the data files depends on
 * how many timer ticks passed while the SQL ran (it does not remove all of
 * it; see "Reproducible VFS image packages" in docs/package-management.md): no
 * persistent statistics recalculation (InnoDB rewrites
 * `innodb_table_stats`/`innodb_index_stats` from a background thread), no
 * periodic Aria checkpoints, and no buffer-pool dump (the list of cached
 * pages at shutdown). They apply only to the build; the image's own service
 * starts MariaDB with its defaults.
 */
const MARIADB_BUILD_ONLY_ARGS = [
  "--innodb-stats-persistent=0",
  "--innodb-stats-auto-recalc=0",
  "--innodb-buffer-pool-dump-at-shutdown=0",
  "--innodb-buffer-pool-load-at-startup=0",
  "--aria-checkpoint-interval=0",
];

function mariadbBootstrapArgs(): string[] {
  return [
    "--no-defaults",
    "--user=mysql",
    "--datadir=/data",
    "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria",
    `--aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE}`,
    `--aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE}`,
    `--innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE}`,
    `--innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE}`,
    `--innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    "--bootstrap",
    "--skip-networking",
    "--log-warnings=0",
    "--log-error=/data/bootstrap.log",
    ...MARIADB_BUILD_ONLY_ARGS,
  ];
}

/**
 * Create MariaDB's system tables and the `wordpress` database. `--bootstrap`
 * reads the SQL from stdin and exits at end of input; the build waits for it
 * and requires success.
 */
async function bootstrapMariaDbSystemTables(
  session: KernelSession,
  fs: VfsImageFilesystem,
  mariadbBytes: ArrayBuffer,
): Promise<void> {
  const bootstrapSql = readVfsFile(fs, "/etc/mariadb/bootstrap.sql");
  const code = await withTimeout(
    session.host.spawn(
      mariadbBytes,
      ["mariadbd", ...mariadbBootstrapArgs()],
      { env: BASE_ENV, cwd: "/data", stdin: bootstrapSql },
    ),
    300_000,
    "mariadbd --bootstrap did not exit",
  );
  if (code !== 0) {
    throw new Error(`mariadbd --bootstrap exited with code ${code}`);
  }
}

function readVfsFile(fs: VfsImageFilesystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.byteLength) {
      const n = fs.read(fd, out.subarray(offset), null, out.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    fs.close(fd);
  }
}

function wordpressInstallScript(): string {
  return `
$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI'] = '/wp-admin/install.php';

define('WP_INSTALLING', true);
${buildOnlyWordPressSecrets()}
require_once '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';

if (is_blog_installed()) {
    echo "already installed\\n";
    exit(0);
}

$result = wp_install(
    ${phpString(WORDPRESS_DEFAULT_SITE_TITLE)},
    ${phpString(WORDPRESS_DEFAULT_ADMIN_USER)},
    ${phpString(WORDPRESS_DEFAULT_ADMIN_EMAIL)},
    true,
    '',
    ${phpString(WORDPRESS_DEFAULT_ADMIN_PASSWORD)},
    'en_US'
);

if (is_wp_error($result)) {
    fwrite(STDERR, $result->get_error_message() . "\\n");
    exit(1);
}

update_option('blogdescription', '');
update_option('timezone_string', 'UTC');
wp_cache_flush();
echo "installed user_id=" . (int)($result['user_id'] ?? 0) . "\\n";
`.trim();
}

/**
 * Public placeholder keys and salts for the build-time install only.
 *
 * wp-config.php requires the machine's secrets file, which the image does not
 * contain (each machine writes its own on first boot), so the installer
 * defines the constants itself first. The values are deliberately public and
 * distinct: distinct, because WordPress ignores keys that repeat one another
 * and instead generates and STORES random ones in the database
 * (`wp_salt()`), which would bake seeded -- that is, public -- keys into the
 * image; public, because nothing the build knows is secret. They sign
 * nothing that outlives the build.
 */
function buildOnlyWordPressSecrets(): string {
  return WORDPRESS_SECRET_NAMES
    .map((name) => `define('${name}', 'kandelo-image-build-only-not-secret-${name.toLowerCase()}');`)
    .join("\n");
}

async function collectMariaDbDiagnostics(host: NodeKernelHost): Promise<string> {
  const chunks: string[] = [];
  for (const path of ["/data/bootstrap.log", "/data/error.log"]) {
    chunks.push(`== ${path} ==`);
    const bytes = await host.readFileFromVfs(path).catch(() => null);
    chunks.push(bytes === null
      ? "missing"
      : new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(-6000));
  }
  return chunks.join("\n");
}

function waitForMariaDbSocketScript(): string {
  return `
for ($i = 0; $i < 900; $i++) {
    if (file_exists(${phpString(MARIADB_PREINSTALL_SOCKET_PATH)})) {
        // The socket exists from bind(); give listen() a moment.
        usleep(500000);
        exit(0);
    }
    usleep(200000);
}
fwrite(STDERR, "MariaDB socket did not appear\\n");
exit(1);
`.trim();
}

function shutdownMariaDbScript(): string {
  return `
mysqli_report(MYSQLI_REPORT_OFF);
$db = mysqli_init();
if (!$db || !@mysqli_real_connect($db, 'localhost', 'root', '', '', 0, ${phpString(MARIADB_PREINSTALL_SOCKET_PATH)})) {
    fwrite(STDERR, "MariaDB shutdown failed to connect: " . mysqli_connect_error() . "\\n");
    exit(1);
}
// A slow shutdown: finish purge and flush every page, so the data files the
// image ships need no crash recovery and carry no pending background work.
if (!$db->query('SET GLOBAL innodb_fast_shutdown = 0')) { fwrite(STDERR, $db->error . "\\n"); exit(1); }
if (!$db->query('FLUSH TABLES')) { fwrite(STDERR, $db->error . "\\n"); exit(1); }
@$db->query('SHUTDOWN');
echo "mariadb shutdown requested\\n";
exit(0);
`.trim();
}

function dumpScript(paths: string[], outputPath?: string): string {
  return `
$roots = json_decode(${phpString(JSON.stringify(paths))}, true);
$dumpOutputPath = ${outputPath === undefined ? "null" : phpString(outputPath)};
$dumpHandle = $dumpOutputPath === null ? fopen('php://stdout', 'wb') : fopen($dumpOutputPath, 'wb');
if (!$dumpHandle) {
    fwrite(STDERR, "cannot open dump output\\n");
    exit(2);
}
$records = [];

function write_dump($text) {
    global $dumpHandle;
    if (fwrite($dumpHandle, $text) === false) {
        fwrite(STDERR, "cannot write dump output\\n");
        exit(2);
    }
}

function add_dump_record($path, &$records) {
    if (is_link($path)) {
        return;
    }
    $st = @stat($path);
    if ($st === false) {
        fwrite(STDERR, "missing dump path: $path\\n");
        exit(2);
    }
    $mode = $st['mode'] & 07777;
    $uid = $st['uid'] ?? 0;
    $gid = $st['gid'] ?? 0;

    if (is_dir($path)) {
        $records[] = ['dir', $path, $mode, $uid, $gid, ''];
        $children = @scandir($path);
        if ($children === false) {
            fwrite(STDERR, "cannot read directory: $path\\n");
            exit(2);
        }
        sort($children, SORT_STRING);
        foreach ($children as $child) {
            if ($child === '.' || $child === '..') {
                continue;
            }
            add_dump_record(rtrim($path, '/') . '/' . $child, $records);
        }
        return;
    }

    if (is_file($path)) {
        $content = @file_get_contents($path);
        if ($content === false) {
            fwrite(STDERR, "cannot read file: $path\\n");
            exit(2);
        }
        $records[] = ['file', $path, $mode, $uid, $gid, base64_encode($content)];
    }
}

foreach ($roots as $root) {
    add_dump_record($root, $records);
}

write_dump("===WPDB_DUMP_BEGIN===\\n");
write_dump(count($records) . "\\n");
foreach ($records as $record) {
    write_dump($record[0] . "\\n");
    write_dump(base64_encode($record[1]) . "\\n");
    write_dump($record[2] . "\\n");
    write_dump($record[3] . "\\n");
    write_dump($record[4] . "\\n");
    write_dump($record[5] . "\\n");
}
write_dump("===WPDB_DUMP_END===\\n");
fclose($dumpHandle);
fwrite(STDERR, "dumped " . count($records) . " entries\\n");
`.trim();
}

function ingestDump(buf: Uint8Array, fs: VfsImageFilesystem): number {
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(DUMP_BEGIN);
  if (beginAt < 0) {
    throw new Error(
      "WPDB_DUMP_BEGIN marker not found in stdout\n" +
        `stdout bytes=${buf.byteLength}\n` +
        text.slice(-4096),
    );
  }
  const body = text.substring(beginAt + DUMP_BEGIN.length);
  const lines = body.split("\n");
  const count = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isFinite(count)) {
    throw new Error(`bad dump record count: ${JSON.stringify(lines[0])}`);
  }

  let cursor = 1;
  const records: DumpRecord[] = [];
  for (let i = 0; i < count; i++) {
    const type = lines[cursor++] as "dir" | "file";
    const path = decodeBase64Text(requiredLine(lines, cursor++, "path"));
    const mode = Number.parseInt(requiredLine(lines, cursor++, "mode"), 10);
    const uid = Number.parseInt(requiredLine(lines, cursor++, "uid"), 10);
    const gid = Number.parseInt(requiredLine(lines, cursor++, "gid"), 10);
    const contentLine = requiredLine(lines, cursor++, "content");
    if (type !== "dir" && type !== "file") {
      throw new Error(`bad dump record type: ${JSON.stringify(type)}`);
    }
    records.push({
      type,
      path,
      mode,
      uid,
      gid,
      content: type === "file" ? decodeBase64Bytes(contentLine) : undefined,
    });
  }
  if (lines[cursor] !== DUMP_END) {
    throw new Error(`missing WPDB_DUMP_END marker (got ${JSON.stringify(lines[cursor])})`);
  }

  for (const record of records) {
    if (record.type !== "dir") continue;
    ensureDirRecursive(fs, record.path);
    fs.chown(record.path, record.uid, record.gid);
    fs.chmod(record.path, record.mode);
  }
  for (const record of records) {
    if (record.type !== "file") continue;
    ensureDirRecursive(fs, dirname(record.path));
    writeVfsBinary(fs, record.path, record.content ?? new Uint8Array(), record.mode);
    fs.chown(record.path, record.uid, record.gid);
    fs.chmod(record.path, record.mode);
  }

  return records.length;
}

function ensureMariaDbDataOwnership(fs: VfsImageFilesystem): void {
  for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/wordpress"]) {
    try {
      fs.chown(dir, MYSQL_UID, MYSQL_GID);
      fs.chmod(dir, 0o775);
    } catch {
      // assertVfsPath reports missing required directories separately.
    }
  }
}

function assertVfsPath(fs: VfsImageFilesystem, path: string): void {
  try {
    fs.stat(path);
  } catch {
    throw new Error(`expected preinstalled WordPress artifact missing: ${path}`);
  }
}

async function isProcessLive(host: NodeKernelHost, pid: number): Promise<boolean> {
  const procs = await host.enumProcs().catch(() => []);
  return procs.some((proc) => proc.pid === pid);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const buf = Buffer.from(value, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function requiredLine(lines: string[], index: number, label: string): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`truncated dump record while reading ${label}`);
  }
  return line;
}

function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
