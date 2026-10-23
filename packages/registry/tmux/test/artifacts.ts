import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../../../host/src/vfs/zip";
import { NCURSES_TERMINFO_RUNTIME_FILE } from "../../../../images/vfs/scripts/shell-lazy-archives";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const mirrorPath = execFileSync("cargo", [
  "xtask", "build-deps", "--arch", "wasm32", "output-path", "tmux", "tmux.wasm",
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const tmuxRelPath = `programs/wasm32/${mirrorPath}`;
export const tmuxProgram = () => resolveBinary(tmuxRelPath);

export function tmuxTerminfoFiles(): Array<{ path: string; data: number[] }> {
  const bytes = new Uint8Array(readFileSync(resolveBinary(NCURSES_TERMINFO_RUNTIME_FILE.resolverPath)));
  return parseZipCentralDirectory(bytes).filter(entry => !entry.isDirectory).map(entry => {
    if (entry.isSymlink || !entry.fileName.startsWith("share/terminfo/")) {
      throw new Error(`unexpected terminfo entry: ${entry.fileName}`);
    }
    return { path: `/usr/${entry.fileName}`, data: Array.from(extractZipEntry(bytes, entry)) };
  });
}
