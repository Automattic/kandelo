import type { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { writeVfsBinary } from "@host/vfs/image-helpers";
import { fetchRequiredExecutable } from "./required-executable";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import genCatWasmUrl from "@binaries/programs/wasm32/posix-utils-lite/gencat.wasm?url";

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

interface ExecBinaries {
  bash: ArrayBuffer;
  coreutils: ArrayBuffer;
  grep: ArrayBuffer;
  sed: ArrayBuffer;
  genCat: ArrayBuffer;
}

export interface ExecBinarySupport {
  populate(fs: KandeloImageFs): void;
}

/** Write a binary file to the virtual filesystem. */
function writeFileToFs(
  fs: KandeloImageFs,
  path: string,
  data: ArrayBuffer,
): void {
  writeVfsBinary(fs, path, new Uint8Array(data), 0o755);
}

/** Populate VFS with actual executable binaries and symlinks for exec. */
function populateExecBinaries(
  fs: KandeloImageFs,
  binaries: ExecBinaries,
): void {
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  // WHY: /bin/sh must be the same Bash implementation as the normal Node
  // rootfs, not a test-only shell with different exec and script behavior.
  writeFileToFs(fs, "/bin/bash", binaries.bash);
  fs.symlink("/bin/bash", "/bin/sh");
  fs.symlink("/bin/bash", "/usr/bin/bash");

  if (binaries.coreutils) {
    writeFileToFs(fs, "/bin/coreutils", binaries.coreutils);
    for (const name of COREUTILS_NAMES) {
      try { fs.symlink("/bin/coreutils", `/bin/${name}`); } catch { /* exists */ }
      try { fs.symlink("/bin/coreutils", `/usr/bin/${name}`); } catch { /* exists */ }
    }
    try { fs.symlink("/bin/coreutils", "/bin/["); } catch { /* exists */ }
    try { fs.symlink("/bin/coreutils", "/usr/bin/["); } catch { /* exists */ }
  }

  if (binaries.grep) {
    writeFileToFs(fs, "/bin/grep", binaries.grep);
    try { fs.symlink("/bin/grep", "/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/bin/fgrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/bin/grep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/fgrep"); } catch { /* exists */ }
  }

  if (binaries.sed) {
    writeFileToFs(fs, "/bin/sed", binaries.sed);
    try { fs.symlink("/bin/sed", "/bin/sed"); } catch { /* exists */ }
  }

  if (binaries.genCat) {
    writeFileToFs(fs, "/bin/gencat", binaries.genCat);
    try { fs.symlink("/bin/gencat", "/usr/bin/gencat"); } catch { /* exists */ }
  }
}

export async function loadExecBinarySupport(): Promise<ExecBinarySupport> {
  const [bash, coreutils, grep, sed, genCat] = await Promise.all([
    fetchRequiredExecutable(bashWasmUrl),
    fetchRequiredExecutable(coreutilsWasmUrl),
    fetchRequiredExecutable(grepWasmUrl),
    fetchRequiredExecutable(sedWasmUrl),
    fetchRequiredExecutable(genCatWasmUrl),
  ]);
  const binaries: ExecBinaries = { bash, coreutils, grep, sed, genCat };
  return {
    populate(fs) {
      populateExecBinaries(fs, binaries);
    },
  };
}
