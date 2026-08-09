/** Build the SQLite upstream Tcl test VFS from explicit or legacy inputs. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import {
  exactVfsImageMetadata,
  saveImage,
  type ExactVfsImageAbi,
  walkAndWrite,
} from "./vfs-image-helpers";

const COREUTILS_SYMLINK_NAMES = [
  "cat", "chmod", "cp", "date", "dirname", "echo", "env", "expr", "false",
  "head", "ln", "ls", "mkdir", "mv", "pwd", "rm", "rmdir", "sed", "sleep",
  "sort", "tail", "tee", "test", "touch", "tr", "true", "uname", "wc", "[",
];

export interface SqliteTestVfsInputs {
  sqlite3: Uint8Array;
  testfixture: Uint8Array;
  dash?: Uint8Array;
  coreutils?: Uint8Array;
  sqliteSourceDirectory: string;
  tclLibraryDirectory: string;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildSqliteTestVfsImage(
  inputs: SqliteTestVfsInputs,
): Promise<void> {
  if (!existsSync(join(inputs.sqliteSourceDirectory, "test"))) {
    throw new Error("SQLite staged full-source input omits test/");
  }
  if (!existsSync(join(inputs.tclLibraryDirectory, "init.tcl"))) {
    throw new Error("SQLite staged Tcl runtime-library input omits init.tcl");
  }
  for (const [label, bytes] of [
    ["sqlite3", inputs.sqlite3],
    ["testfixture", inputs.testfixture],
  ] as const) {
    if (bytes.byteLength === 0) throw new Error(`SQLite staged ${label} is empty`);
  }

  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(64 * 1024 * 1024, { maxByteLength: 512 * 1024 * 1024 }),
    512 * 1024 * 1024,
  );
  for (const dir of [
    "/tmp", "/home", "/root", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/lib", "/sqlite",
  ]) ensureDir(fs, dir);
  fs.chmod("/tmp", 0o777);

  writeVfsBinary(fs, "/usr/bin/testfixture", inputs.testfixture);
  symlink(fs, "/usr/bin/testfixture", "/bin/testfixture");
  writeVfsBinary(fs, "/usr/bin/sqlite3", inputs.sqlite3);
  symlink(fs, "/usr/bin/sqlite3", "/bin/sqlite3");
  if (inputs.dash !== undefined) {
    if (inputs.dash.byteLength === 0) throw new Error("SQLite staged dash is empty");
    writeVfsBinary(fs, "/bin/dash", inputs.dash);
    symlink(fs, "/bin/dash", "/bin/sh");
    symlink(fs, "/bin/dash", "/usr/bin/sh");
  }
  if (inputs.coreutils !== undefined) {
    if (inputs.coreutils.byteLength === 0) {
      throw new Error("SQLite staged coreutils is empty");
    }
    writeVfsBinary(fs, "/bin/coreutils", inputs.coreutils);
    for (const name of COREUTILS_SYMLINK_NAMES) {
      symlink(fs, "/bin/coreutils", `/bin/${name}`);
      symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
    }
  }
  walkAndWrite(fs, inputs.tclLibraryDirectory, "/usr/lib/tcl8.6");
  ensureDirRecursive(fs, "/sqlite");
  walkAndWrite(fs, inputs.sqliteSourceDirectory, "/sqlite", {
    exclude: (rel) =>
      rel === ".fossil-settings" || rel.startsWith(".fossil-settings/") ||
      rel.startsWith(".git/") || rel.startsWith("testfixture-build/") ||
      rel.endsWith(".o") || rel.endsWith(".a"),
  });
  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture");
  symlink(fs, "/usr/bin/testfixture", "/sqlite/testfixture.wasm");
  symlink(fs, "/usr/bin/sqlite3", "/sqlite/sqlite3");
  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-sqlite-test-vfs-image.ts",
        ),
      });
}

async function main(): Promise<void> {
  const repositoryRoot = findRepoRoot();
  const sqliteDirectory = join(repositoryRoot, "packages/registry/sqlite");
  const tclLibrary = join(repositoryRoot, "packages/registry/tcl/tcl-install/lib/tcl8.6");
  const testfixture = join(sqliteDirectory, "bin/testfixture.wasm");
  const sqlite3 = join(sqliteDirectory, "sqlite-install/bin/sqlite3.wasm");
  const dash = tryResolveBinary("programs/dash.wasm");
  const coreutils = tryResolveBinary("programs/coreutils.wasm");
  const missing = [
    testfixture,
    sqlite3,
    join(sqliteDirectory, "sqlite-full-src"),
    tclLibrary,
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`SQLite test VFS inputs missing:\n${missing.join("\n")}`);
  await buildSqliteTestVfsImage({
    sqlite3: new Uint8Array(readFileSync(sqlite3)),
    testfixture: new Uint8Array(readFileSync(testfixture)),
    ...(dash === null ? {} : { dash: new Uint8Array(readFileSync(dash!)) }),
    ...(coreutils === null
      ? {}
      : { coreutils: new Uint8Array(readFileSync(coreutils!)) }),
    sqliteSourceDirectory: join(sqliteDirectory, "sqlite-full-src"),
    tclLibraryDirectory: tclLibrary,
    outputPath: process.env.SQLITE_TEST_VFS_OUT ??
      join(repositoryRoot, "apps/browser-demos/public/sqlite-test.vfs.zst"),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
