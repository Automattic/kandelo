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
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";
import { COREUTILS_NAMES } from "../lib/init/shell-binaries";

const REPO_ROOT = findRepoRoot();
const SQLITE_DIR = join(REPO_ROOT, "packages/registry/sqlite");
const TCL_DIR = join(REPO_ROOT, "packages/registry/tcl");
const SQLITE_FULL = join(SQLITE_DIR, "sqlite-full-src");
const TCL_LIBRARY = join(TCL_DIR, "tcl-install/lib/tcl8.6");
const TESTFIXTURE = join(SQLITE_DIR, "bin/testfixture.wasm");
const SQLITE3 = join(SQLITE_DIR, "sqlite-install/bin/sqlite3.wasm");
const DASH_PATH = tryResolveBinary("programs/dash.wasm");
const COREUTILS_PATH = tryResolveBinary("programs/coreutils.wasm");
const OUT_FILE = process.env.SQLITE_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/sqlite-test.vfs.zst");

const COREUTILS_SYMLINK_NAMES = [...COREUTILS_NAMES, "["];

function checkPrereqs(): void {
  const missing: string[] = [];
  if (!existsSync(TESTFIXTURE)) missing.push(`testfixture.wasm missing at ${TESTFIXTURE}`);
  if (!existsSync(SQLITE3)) missing.push(`sqlite3.wasm missing at ${SQLITE3}`);
  if (!existsSync(join(SQLITE_FULL, "test"))) missing.push(`SQLite full source missing at ${SQLITE_FULL}`);
  if (!existsSync(TCL_LIBRARY)) missing.push(`Tcl runtime library missing at ${TCL_LIBRARY}`);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join("\n")}\n\nRun:\n` +
      "  bash packages/registry/tcl/build-tcl.sh\n" +
      "  bash packages/registry/sqlite/build-sqlite.sh\n" +
      "  bash packages/registry/sqlite/build-testfixture.sh",
    );
  }
}

async function main() {
  checkPrereqs();

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

  if (DASH_PATH && existsSync(DASH_PATH)) {
    writeVfsBinary(fs, "/bin/dash", new Uint8Array(readFileSync(DASH_PATH)));
    symlink(fs, "/bin/dash", "/bin/sh");
    symlink(fs, "/bin/dash", "/usr/bin/sh");
  }
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

  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture");
  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture.wasm");
  symlink(fs, "/usr/bin/sqlite3", "/sqlite/sqlite3");

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
