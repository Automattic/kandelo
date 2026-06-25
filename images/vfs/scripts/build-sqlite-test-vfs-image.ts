/**
 * Build a VFS image for the SQLite upstream Tcl testfixture suite.
 *
 * The browser runner restores this image, writes no additional suite files,
 * and spawns /usr/bin/testfixture with cwd=/sqlite and argv test/<name>.test.
 *
 * Produces: $SQLITE_TEST_VFS_OUT (default:
 * apps/browser-demos/public/sqlite-test.vfs.zst).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, resolveBinary, tryResolveBinary } from "../../../host/src/binary-resolver";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const SQLITE_DIR = join(REPO_ROOT, "packages/registry/sqlite");
const TCL_DIR = join(REPO_ROOT, "packages/registry/tcl");
const SQLITE_FULL = join(SQLITE_DIR, "sqlite-full-src");
const TCL_LIBRARY = join(TCL_DIR, "tcl-install/lib/tcl8.6");
const TESTFIXTURE = join(SQLITE_DIR, "bin/testfixture.wasm");
const SQLITE3 = join(SQLITE_DIR, "sqlite-install/bin/sqlite3.wasm");
const COREUTILS_PATH = tryResolveBinary("programs/coreutils.wasm");
const OUT_FILE = process.env.SQLITE_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/sqlite-test.vfs.zst");

const COREUTILS_SYMLINK_NAMES = [
  "cat", "chmod", "cp", "date", "dirname", "echo", "env", "expr", "false",
  "head", "ln", "ls", "mkdir", "mv", "pwd", "rm", "rmdir", "sed", "sleep",
  "sort", "tail", "tee", "test", "touch", "tr", "true", "uname", "wc", "[",
];

const KANDELO_TESTRUNNER_PLATFORM_SHIM = [
  "# Kandelo's Tcl target OS name is not classified by SQLite's upstream",
  "# testrunner.tcl. Force the normal Unix-like branch before upstream",
  "# chooses make/run script commands.",
  "set ::tcl_platform(os) OpenBSD",
  "set ::tcl_platform(platform) unix",
  "",
].join("\n");

function kandeloTestrunnerSource(upstream: string): string {
  const needle = "set dir [pwd]\n";
  if (!upstream.includes(needle)) {
    throw new Error("SQLite testrunner.tcl no longer has the expected platform insertion point");
  }
  return upstream.replace(needle, `${KANDELO_TESTRUNNER_PLATFORM_SHIM}${needle}`);
}

function checkPrereqs(): { dashPath: string } {
  const missing: string[] = [];
  if (!existsSync(TESTFIXTURE)) missing.push(`testfixture.wasm missing at ${TESTFIXTURE}`);
  if (!existsSync(SQLITE3)) missing.push(`sqlite3.wasm missing at ${SQLITE3}`);
  if (!existsSync(join(SQLITE_FULL, "test"))) missing.push(`SQLite full source missing at ${SQLITE_FULL}`);
  if (!existsSync(TCL_LIBRARY)) missing.push(`Tcl runtime library missing at ${TCL_LIBRARY}`);
  let dashPath = "";
  try {
    dashPath = resolveBinary("programs/dash.wasm");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    missing.push(`dash.wasm missing for /bin/sh and /usr/bin/sh:\n${message}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.join("\n")}\n\nRun:\n` +
      "  bash packages/registry/tcl/build-tcl.sh\n" +
      "  bash packages/registry/sqlite/build-sqlite.sh\n" +
      "  bash packages/registry/sqlite/build-testfixture.sh\n" +
      "  cargo run -p xtask -- build-deps resolve dash --arch wasm32 --binaries-dir binaries",
    );
  }
  return { dashPath };
}

async function main() {
  const { dashPath } = checkPrereqs();

  console.log("==> Building SQLite upstream-test VFS image");
  const sab = new SharedArrayBuffer(64 * 1024 * 1024, { maxByteLength: 512 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 512 * 1024 * 1024);

  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/lib", "/sqlite",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  writeVfsBinary(fs, "/usr/bin/testfixture", new Uint8Array(readFileSync(TESTFIXTURE)));
  symlink(fs, "/usr/bin/testfixture", "/bin/testfixture");
  writeVfsBinary(fs, "/usr/bin/sqlite3", new Uint8Array(readFileSync(SQLITE3)));
  symlink(fs, "/usr/bin/sqlite3", "/bin/sqlite3");

  writeVfsBinary(fs, "/bin/dash", new Uint8Array(readFileSync(dashPath)));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
  if (COREUTILS_PATH && existsSync(COREUTILS_PATH)) {
    writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_PATH)));
    for (const name of COREUTILS_SYMLINK_NAMES) {
      symlink(fs, "/bin/coreutils", `/bin/${name}`);
      symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
    }
  }

  console.log("  Writing Tcl runtime...");
  walkAndWrite(fs, TCL_LIBRARY, "/usr/lib/tcl8.6");

  console.log("  Writing SQLite full source/test tree...");
  ensureDirRecursive(fs, "/sqlite");
  const count = walkAndWrite(fs, SQLITE_FULL, "/sqlite", {
    exclude: (rel) =>
      rel === ".fossil-settings" ||
      rel.startsWith(".fossil-settings/") ||
      rel.startsWith(".git/") ||
      rel.startsWith("testfixture-build/") ||
      rel.endsWith(".o") ||
      rel.endsWith(".a"),
  });
  console.log(`    ${count} source/test files`);

  const upstreamTestrunner = readFileSync(join(SQLITE_FULL, "test", "testrunner.tcl"), "utf8");
  writeVfsFile(fs, "/sqlite/test/kandelo-upstream-testrunner.tcl", upstreamTestrunner, 0o644);
  writeVfsFile(fs, "/sqlite/test/testrunner.tcl", kandeloTestrunnerSource(upstreamTestrunner), 0o644);

  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture");
  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture.wasm");
  symlink(fs, "/usr/bin/sqlite3", "/sqlite/sqlite3");

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
