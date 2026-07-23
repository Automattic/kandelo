import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { type MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  walkAndWrite,
  writeVfsBinary,
} from "./vfs-image-helpers";

export interface MariaDbTestSourceCopyOptions {
  includeAll: boolean;
  curatedTests: readonly string[];
}

function requireRegularTestSource(path: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`MariaDB test source entry is not a regular file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function copyRequiredFixtureTree(
  fs: MemoryFileSystem,
  mysqlTestDir: string,
  name: "include" | "std_data",
): void {
  const source = join(mysqlTestDir, name);
  const count = walkAndWrite(fs, source, `/mysql-test/${name}`);
  if (count === 0) {
    throw new Error(`Required MariaDB test fixture tree is empty: ${source}`);
  }
}

/**
 * Copy the declared MariaDB test closure without best-effort omissions.
 *
 * The upstream source is pinned, so a missing curated test or fixture tree is
 * a broken build input rather than an optional feature. Any host read, source
 * type, or VFS write failure must abort the artifact build.
 */
export function copyMariaDbTestSources(
  fs: MemoryFileSystem,
  mysqlTestDir: string,
  options: MariaDbTestSourceCopyOptions,
): number {
  const mainDir = join(mysqlTestDir, "main");
  const testFiles = options.includeAll
    ? readdirSync(mainDir).filter((name) => name.endsWith(".test")).sort()
    : options.curatedTests.map((name) => `${name}.test`);
  if (testFiles.length === 0) {
    throw new Error(`No MariaDB test sources were selected from ${mainDir}`);
  }
  if (new Set(testFiles).size !== testFiles.length) {
    throw new Error("MariaDB test source selection contains duplicate entries");
  }

  ensureDirRecursive(fs, "/mysql-test/main");
  for (const fileName of testFiles) {
    writeVfsBinary(
      fs,
      `/mysql-test/main/${fileName}`,
      requireRegularTestSource(join(mainDir, fileName)),
      0o644,
    );
  }

  copyRequiredFixtureTree(fs, mysqlTestDir, "include");
  copyRequiredFixtureTree(fs, mysqlTestDir, "std_data");
  return testFiles.length;
}
