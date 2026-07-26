import type { MemoryFileSystem } from "@host/vfs/memory-fs";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
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
  dash: ArrayBuffer | null;
  coreutils: ArrayBuffer | null;
  grep: ArrayBuffer | null;
  sed: ArrayBuffer | null;
  genCat: ArrayBuffer | null;
}

export interface ExecBinarySupport {
  populate(fs: MemoryFileSystem): void;
}

/** Write a binary file to the virtual filesystem. */
function writeFileToFs(
  fs: MemoryFileSystem,
  path: string,
  data: ArrayBuffer,
): void {
  const bytes = new Uint8Array(data);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

/** Populate VFS with actual executable binaries and symlinks for exec. */
function populateExecBinaries(
  fs: MemoryFileSystem,
  binaries: ExecBinaries,
): void {
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  if (binaries.dash) {
    writeFileToFs(fs, "/bin/dash", binaries.dash);
    try { fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }
  }

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
    try { fs.symlink("/bin/grep", "/usr/bin/grep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/fgrep"); } catch { /* exists */ }
  }

  if (binaries.sed) {
    writeFileToFs(fs, "/bin/sed", binaries.sed);
    try { fs.symlink("/bin/sed", "/usr/bin/sed"); } catch { /* exists */ }
  }

  if (binaries.genCat) {
    writeFileToFs(fs, "/bin/gencat", binaries.genCat);
    try { fs.symlink("/bin/gencat", "/usr/bin/gencat"); } catch { /* exists */ }
  }
}

export async function loadExecBinarySupport(): Promise<ExecBinarySupport> {
  const fetches = await Promise.allSettled([
    fetch(dashWasmUrl).then((response) => response.arrayBuffer()),
    fetch(coreutilsWasmUrl).then((response) => response.arrayBuffer()),
    fetch(grepWasmUrl).then((response) => response.arrayBuffer()),
    fetch(sedWasmUrl).then((response) => response.arrayBuffer()),
    fetch(genCatWasmUrl).then((response) => response.arrayBuffer()),
  ]);
  const binaries: ExecBinaries = {
    dash: fetches[0].status === "fulfilled" ? fetches[0].value : null,
    coreutils: fetches[1].status === "fulfilled" ? fetches[1].value : null,
    grep: fetches[2].status === "fulfilled" ? fetches[2].value : null,
    sed: fetches[3].status === "fulfilled" ? fetches[3].value : null,
    genCat: fetches[4].status === "fulfilled" ? fetches[4].value : null,
  };
  return {
    populate(fs) {
      populateExecBinaries(fs, binaries);
    },
  };
}
