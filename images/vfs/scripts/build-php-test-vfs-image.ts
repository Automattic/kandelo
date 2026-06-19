/**
 * Build a VFS image for running php-src PHPT runtime tests in the browser.
 *
 * The image contains:
 *   - /bin/sh plus standard shell utilities for PHP's shell-backed exec APIs
 *   - /usr/local/bin/php
 *   - /php-src/<test directories containing .phpt files>
 *
 * The Playwright-side runner parses each .phpt file and writes transient
 * PHP scripts into the restored image before spawning /usr/local/bin/php.
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsFile,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { ensureSourceExtract } from "./source-extract-helper";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_WASM = process.env.PHP_WASM
  ?? tryResolveBinary("programs/php/php.wasm")
  ?? join(LOCAL_PHP_SRC, "sapi/cli/php");
const OPCACHE_SO = process.env.PHP_OPCACHE_SO
  ?? tryResolveBinary("programs/php/opcache.so");
const PHP_EXTENSION_DIR = process.env.PHP_EXTENSION_DIR
  ?? (OPCACHE_SO ? dirname(OPCACHE_SO) : undefined);
const DASH_WASM = process.env.DASH_WASM
  ?? tryResolveBinary("programs/dash.wasm");
const COREUTILS_WASM = process.env.COREUTILS_WASM
  ?? tryResolveBinary("programs/coreutils.wasm");
const SED_WASM = process.env.SED_WASM
  ?? tryResolveBinary("programs/sed.wasm");
const GREP_WASM = process.env.GREP_WASM
  ?? tryResolveBinary("programs/grep.wasm");
const OUT_FILE = process.env.PHP_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst");
const FS_INITIAL_BYTES = Number(process.env.PHP_TEST_VFS_INITIAL_BYTES ?? 256 * 1024 * 1024);
const FS_MAX_BYTES = Number(process.env.PHP_TEST_VFS_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

const ETC_PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "user:x:1000:1000:user:/home/user:/bin/sh",
  "",
].join("\n");

const ETC_GROUP = [
  "root:x:0:",
  "nogroup:x:65534:",
  "nobody:x:65534:",
  "user:x:1000:",
  "",
].join("\n");

const ETC_SERVICES = readFileSync(
  join(REPO_ROOT, "images/rootfs/etc/services"),
  "utf8",
);

const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
];

const PGREP_SCRIPT = `#!/bin/sh
if [ "$1" != "-P" ] || [ -z "$2" ]; then
  exit 2
fi
want_ppid=$2
found=1
for stat in /proc/[0-9]*/stat; do
  [ -r "$stat" ] || continue
  line=$(cat "$stat" 2>/dev/null) || continue
  pid=\${line%% *}
  after=\${line#*) }
  set -- $after
  ppid=$2
  if [ "$ppid" = "$want_ppid" ]; then
    printf '%s\\n' "$pid"
    found=0
  fi
done
exit "$found"
`;

const PS_SCRIPT = `#!/bin/sh
pids=
format=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--pid)
      shift
      pids=$1
      ;;
    -p*)
      pids=\${1#-p}
      ;;
    -o|--format)
      shift
      format=$1
      ;;
    -o*)
      format=\${1#-o}
      ;;
    *)
      ;;
  esac
  shift
done

[ -n "$format" ] || format=pid,command
header=1
case "$format" in
  *=*)
    header=0
    ;;
esac

fields=$(printf '%s' "$format" | tr ',' ' ')
if [ -n "$pids" ]; then
  pid_list=$(printf '%s' "$pids" | tr ',' ' ')
else
  pid_list=
  for proc_dir in /proc/[0-9]*; do
    [ -d "$proc_dir" ] || continue
    pid_list="$pid_list \${proc_dir#/proc/}"
  done
fi

if [ "$header" = 1 ]; then
  out=
  for field in $fields; do
    field=\${field%=}
    case "$field" in
      pid) label=PID ;;
      nice|ni) label=NICE ;;
      comm|command|args) label=COMMAND ;;
      *) label=$(printf '%s' "$field" | tr '[:lower:]' '[:upper:]') ;;
    esac
    out="$out\${out:+ }$label"
  done
  printf '%s\\n' "$out"
fi

found=0
for pid in $pid_list; do
  stat=/proc/$pid/stat
  [ -r "$stat" ] || continue
  line=$(cat "$stat" 2>/dev/null) || continue
  comm=\${line#*(}
  comm=\${comm%)*}
  after=\${line#*) }
  set -- $after
  nice=\${17:-0}
  cmd=$(tr '\\000' ' ' < /proc/$pid/cmdline 2>/dev/null)
  [ -n "$cmd" ] || cmd=$comm
  row=
  for field in $fields; do
    field=\${field%=}
    case "$field" in
      pid) value=$pid ;;
      nice|ni) value=$nice ;;
      comm|command|args) value=$cmd ;;
      *) value= ;;
    esac
    row="$row\${row:+ }$value"
  done
  printf '%s\\n' "$row"
  found=1
done

[ "$found" = 1 ]
`;

function resolvePhpSource(): string {
  return process.env.PHP_SOURCE_DIR
    ?? ensureSourceExtract("php", REPO_ROOT, existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined);
}

function collectPhptDirs(root: string): string[] {
  const dirs = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".deps" || entry.name === ".libs") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".phpt")) {
        dirs.add(dir);
      }
    }
  }
  walk(root);
  // Some PHPTs include helper fixtures from extension directories that do not
  // themselves contain .phpt files. Keep those directories in the browser VFS
  // so SKIPIF sections behave like they do against a complete php-src tree.
  for (const rel of ["ext/dl_test/tests"]) {
    const full = join(root, rel);
    if (existsSync(full)) dirs.add(full);
  }
  return [...dirs].sort();
}

const SUPPORT_FILE_PATTERN =
  /\.(?:inc|php|phtml|pem|crt|csr|key|cnf|ini|txt|dat|data|json|xml|xsd|dtd|rng|csv|sql|stub)$/i;

function isTestPath(relPath: string): boolean {
  return relPath.split(/[\\/]+/).includes("tests");
}

function isSupportFileName(name: string): boolean {
  return SUPPORT_FILE_PATTERN.test(name);
}

function directoryHasSupportFiles(sourceRoot: string, dir: string): boolean {
  const relDir = relative(sourceRoot, dir);
  if (!relDir || !isTestPath(relDir)) return false;
  for (const entry of readdirSync(dir)) {
    if (!isSupportFileName(entry)) continue;
    try {
      if (statSync(join(dir, entry)).isFile()) return true;
    } catch {
      // Ignore unreadable or disappearing entries.
    }
  }
  return false;
}

function collectPhptSupportDirs(sourceRoot: string, phptDirs: string[]): string[] {
  const dirs = new Set<string>();
  const phptDirSet = new Set(phptDirs);
  for (const phptDir of phptDirs) {
    let current = dirname(phptDir);
    while (current !== sourceRoot && current.startsWith(sourceRoot)) {
      if (!phptDirSet.has(current) && directoryHasSupportFiles(sourceRoot, current)) {
        dirs.add(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...dirs].sort();
}

function copySupportFiles(
  fs: MemoryFileSystem,
  sourceRoot: string,
  dir: string,
): number {
  const relDir = relative(sourceRoot, dir);
  const destDir = relDir ? `/php-src/${relDir}` : "/php-src";
  ensureDirRecursive(fs, destDir);
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (!isSupportFileName(entry)) continue;
    const relPath = relDir ? `${relDir}/${entry}` : entry;
    if (shouldExclude(sourceRoot, relPath)) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      writeVfsBinary(fs, `${destDir}/${entry}`, new Uint8Array(readFileSync(full)), 0o644);
      count++;
    } catch {
      // Skip unreadable or disappearing support files, matching walkAndWrite.
    }
  }
  return count;
}

function preparePhpTestFixtures(sourceRoot: string): void {
  const fixtureDir = join(REPO_ROOT, "tests/php-fixtures/openssl-sni-2036");
  const destDir = join(sourceRoot, "ext/openssl/tests");
  if (existsSync(fixtureDir) && existsSync(destDir)) {
    for (const entry of readdirSync(fixtureDir)) {
      if (!entry.startsWith("sni_server_") || !entry.endsWith(".pem")) continue;
      cpSync(join(fixtureDir, entry), join(destDir, entry));
    }
  }

  const mysqliFakeServer = join(sourceRoot, "ext/mysqli/tests/fake_server.inc");
  if (existsSync(mysqliFakeServer)) {
    const text = readFileSync(mysqliFakeServer, "utf8");
    if (!text.includes("MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS")) {
      const from = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);
        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      const to = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);

        if ($data && $bytes_len > 1024) {
            // Large reads in this fake MySQL server are used to drain the
            // connection tail after the client reacts to a crafted packet.
            // fread() on a POSIX stream may return as soon as any bytes are
            // available; it is not required to wait for later client writes to
            // coalesce into the same TCP segment. Native php-src runs usually
            // see the final COM_STMT_CLOSE and COM_QUIT together after the
            // fixed sleep above, but the browser host can schedule the guest
            // peer more slowly. Keep draining for a short idle window and print
            // one Received line so the fixture remains semantically identical
            // without relying on transport coalescing.
            $idleMs = getenv('MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS');
            $idleMs = $idleMs !== false && is_numeric($idleMs) ? max(0, (int) $idleMs) : 250;
            $deadline = microtime(true) + ($idleMs / 1000);
            $wasBlocking = stream_get_meta_data($this->conn)['blocked'] ?? true;
            stream_set_blocking($this->conn, false);
            try {
                while (strlen($data) < $bytes_len && microtime(true) < $deadline) {
                    usleep(10000);
                    $chunk = fread($this->conn, $bytes_len - strlen($data));
                    if ($chunk !== false && $chunk !== '') {
                        $data .= $chunk;
                        $deadline = microtime(true) + ($idleMs / 1000);
                    }
                }
            } finally {
                stream_set_blocking($this->conn, $wasBlocking);
            }
        }

        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP mysqli fake_server fixture: read() marker not found in ${mysqliFakeServer}`,
        );
      }
      // The source tree is a local extracted test fixture, not tracked PHP
      // package source. Patch it before packing the browser VFS so browser and
      // Node PHPT runs exercise the same transport-tolerant fixture behavior.
      writeFileSync(mysqliFakeServer, text.replace(from, to), "utf8");
    }
  }
}

function shouldExclude(sourceRoot: string, relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  if (relPath.includes("/.git/") || relPath.includes("/.deps/") || relPath.includes("/.libs/")) return true;
  if (base.startsWith(".nfs")) return true;
  if (isGeneratedPhptArtifact(sourceRoot, relPath)) return true;
  if (base.endsWith(".o") || base.endsWith(".lo") || base.endsWith(".la") || base.endsWith(".a")) return true;
  if (base === "php" || base === "phpdbg" || base === "php-cgi" || base === "php-fpm") {
    try {
      const st = statSync(join(sourceRoot, relPath));
      return st.size > 1024 * 1024;
    } catch {
      return true;
    }
  }
  return false;
}

function isGeneratedPhptArtifact(sourceRoot: string, relPath: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const dir = slash >= 0 ? relPath.slice(0, slash) : "";
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;

  // Some PHPTs create a same-stem directory next to the test and then remove
  // it from --CLEAN--. If a long browser run is interrupted during the test,
  // the source checkout/cache can retain a huge generated directory; baking it
  // into the immutable browser VFS changes the next run's initial state. Keep
  // small same-stem directories because upstream also uses that convention for
  // legitimate helper fixtures (for example ext/phar/tests/bug53872/).
  if (base && existsSync(join(sourceRoot, dir, `${base}.phpt`))) {
    try {
      const full = join(sourceRoot, relPath);
      const st = statSync(full);
      if (st.isDirectory() && readdirSync(full).length >= 100) {
        return true;
      }
    } catch {
      // Fall through to the file-artifact checks below.
    }
  }

  for (const suffix of [".skip.php", ".clean.php", ".php"]) {
    if (!base.endsWith(suffix)) continue;
    const stem = base.slice(0, -suffix.length);
    if (stem && existsSync(join(sourceRoot, dir, `${stem}.phpt`))) return true;
  }

  // PHPTs commonly leave archives/databases named after the test stem when a
  // run is interrupted before --CLEAN--. Those files are execution products,
  // not source fixtures; baking them into the browser image changes future
  // test initial state (for example PharData opens an existing corrupt .zip
  // instead of creating a new archive). Keep same-stem PHPT artifacts out of
  // the immutable browser VFS image while preserving unrelated helper files.
  const artifact = base.match(/^(.+?)(\.(?:\d+\.)*(?:phar|tar|zip|db|sqlite|sqlite3)(?:\.[A-Za-z0-9_-]+)*)$/);
  if (!artifact) return false;
  return existsSync(join(sourceRoot, dir, `${artifact[1]}.phpt`));
}

async function main() {
  if (!existsSync(PHP_WASM)) {
    throw new Error(`PHP wasm not found at ${PHP_WASM}. Run: bash packages/registry/php/build-php.sh`);
  }
  if (!DASH_WASM || !existsSync(DASH_WASM)) {
    throw new Error("dash.wasm not found. Run: scripts/fetch-binaries.sh or set DASH_WASM");
  }
  if (!COREUTILS_WASM || !existsSync(COREUTILS_WASM)) {
    throw new Error("coreutils.wasm not found. Run: scripts/fetch-binaries.sh or set COREUTILS_WASM");
  }
  if (!SED_WASM || !existsSync(SED_WASM)) {
    throw new Error("sed.wasm not found. Run: scripts/fetch-binaries.sh or set SED_WASM");
  }
  if (!GREP_WASM || !existsSync(GREP_WASM)) {
    throw new Error("grep.wasm not found. Run: scripts/fetch-binaries.sh or set GREP_WASM");
  }
  const phpSrc = resolvePhpSource();
  if (!existsSync(phpSrc)) {
    throw new Error(`php-src not found at ${phpSrc}`);
  }
  preparePhpTestFixtures(phpSrc);

  console.log("==> Building PHP PHPT test VFS image");
  console.log(`  php-src: ${phpSrc}`);

  const sab = new SharedArrayBuffer(FS_INITIAL_BYTES, { maxByteLength: FS_MAX_BYTES });
  const fs = MemoryFileSystem.create(sab, FS_MAX_BYTES);
  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/lib", "/usr/lib/php", "/usr/lib/php/extensions",
    "/usr/local", "/usr/local/bin", "/php-src",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o1777);
  writeVfsFile(fs, "/etc/passwd", ETC_PASSWD);
  writeVfsFile(fs, "/etc/group", ETC_GROUP);
  writeVfsFile(fs, "/etc/services", ETC_SERVICES);

  writeVfsBinary(fs, "/usr/bin/dash", new Uint8Array(readFileSync(DASH_WASM)));
  symlink(fs, "/usr/bin/dash", "/bin/sh");
  symlink(fs, "/usr/bin/dash", "/bin/dash");

  writeVfsBinary(fs, "/usr/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_WASM)));
  for (const name of COREUTILS_NAMES) {
    symlink(fs, "/usr/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/usr/bin/coreutils", `/usr/bin/${name}`);
  }
  symlink(fs, "/usr/bin/coreutils", "/bin/[");
  symlink(fs, "/usr/bin/coreutils", "/usr/bin/[");

  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(readFileSync(SED_WASM)));
  symlink(fs, "/usr/bin/sed", "/bin/sed");

  writeVfsBinary(fs, "/usr/bin/grep", new Uint8Array(readFileSync(GREP_WASM)));
  symlink(fs, "/usr/bin/grep", "/bin/grep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/fgrep");
  symlink(fs, "/usr/bin/grep", "/bin/fgrep");

  writeVfsFile(fs, "/usr/bin/pgrep", PGREP_SCRIPT, 0o755);
  symlink(fs, "/usr/bin/pgrep", "/bin/pgrep");
  writeVfsFile(fs, "/usr/bin/ps", PS_SCRIPT, 0o755);
  symlink(fs, "/usr/bin/ps", "/bin/ps");

  writeVfsBinary(fs, "/usr/local/bin/php", new Uint8Array(readFileSync(PHP_WASM)));
  if (PHP_EXTENSION_DIR && existsSync(PHP_EXTENSION_DIR)) {
    for (const entry of readdirSync(PHP_EXTENSION_DIR)) {
      if (!entry.endsWith(".so")) continue;
      const src = join(PHP_EXTENSION_DIR, entry);
      writeVfsBinary(
        fs,
        `/usr/lib/php/extensions/${entry}`,
        new Uint8Array(readFileSync(src)),
      );
    }
  }
  if (OPCACHE_SO && existsSync(OPCACHE_SO)) {
    // PHP_OPCACHE_SO is the explicit harness override for the OPcache side
    // module. Honor it even when PHP_EXTENSION_DIR also contains an
    // opcache.so; otherwise browser PHPT runs can silently package a stale
    // or non-side-module opcache under the canonical extension path while the
    // runner advertises OPcache as available.
    writeVfsBinary(
      fs,
      "/usr/lib/php/extensions/opcache.so",
      new Uint8Array(readFileSync(OPCACHE_SO)),
    );
  }

  const phptDirs = collectPhptDirs(phpSrc);
  const supportDirs = collectPhptSupportDirs(phpSrc, phptDirs);
  console.log(`  Writing ${phptDirs.length} PHPT directories...`);
  let fileCount = 0;
  for (const dir of phptDirs) {
    const rel = relative(phpSrc, dir);
    const dest = rel ? `/php-src/${rel}` : "/php-src";
    ensureDirRecursive(fs, dirname(dest));
    fileCount += walkAndWrite(fs, dir, dest, {
      exclude: (childRel) => shouldExclude(phpSrc, rel ? `${rel}/${childRel}` : childRel),
    });
  }
  if (supportDirs.length > 0) {
    console.log(`  Writing ${supportDirs.length} PHPT support directories...`);
    for (const dir of supportDirs) {
      fileCount += copySupportFiles(fs, phpSrc, dir);
    }
  }
  console.log(`    ${fileCount} files`);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
