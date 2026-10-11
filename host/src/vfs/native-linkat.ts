import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = `
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 64;
    if (linkat(AT_FDCWD, argv[1], AT_FDCWD, argv[2], AT_SYMLINK_NOFOLLOW_ANY) == 0) return 0;
    fprintf(stderr, "%d\\n", errno);
    return 1;
}
`;

let executable: string | undefined;

function nativeError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function helperPath(): string {
  if (executable !== undefined) return executable;
  const directory = mkdtempSync(join(tmpdir(), "kandelo-linkat-"));
  const output = join(directory, "linkat-nofollow");
  const compiler = spawnSync(process.env.CC || "cc", ["-O2", "-x", "c", "-", "-o", output], {
    encoding: "utf8",
    input: source,
  });
  if (compiler.error || compiler.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw nativeError(
      "ENOSYS",
      `native linkat helper unavailable: ${compiler.error?.message || compiler.stderr?.trim() || "unknown compiler error"}`,
    );
  }
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  executable = output;
  return output;
}

export function linkSymlinkInode(sourcePath: string, destinationPath: string): void {
  const result = spawnSync(helperPath(), [sourcePath, destinationPath], { encoding: "utf8" });
  if (result.status === 0) return;
  if (result.error) {
    throw nativeError("EIO", `native linkat helper failed: ${result.error.message}`);
  }
  const errno = Number(result.stderr?.trim());
  const code = Object.entries(constants.errno)
    .find(([, value]) => value === errno)?.[0] || "EIO";
  throw nativeError(code, `linkat ${sourcePath} ${destinationPath}`);
}
