#!/usr/bin/env -S npx tsx
/**
 * Build node.zip for the browser shell demo: a root-relative archive of
 * bin/node (the SpiderMonkey-based Node.js interpreter) plus npm + npx and
 * the npm dist. The shell overlay mounts it at /usr/, so entries become
 * /usr/bin/node, /usr/bin/npm, /usr/local/lib/npm/... On first exec the archive
 * is fetched and unpacked in one go.
 *
 * npm on SpiderMonkey needs a job-queue-pumping runner and a few source shims
 * (the native SpiderMonkey embedding does not implement Node's ESM module
 * resolution, so npm's `await import('chalk')`-style loads of ESM-only deps are
 * rewritten to CommonJS shims — a documented compatibility workaround at that
 * platform boundary, tracked for removal once the embedding grows real ESM
 * resolution). Rather than duplicate that fragile glue, this reuses node-vfs's
 * exact `walkAndWrite` + `stageSpiderMonkeyNpmRuntime` on a MemoryFileSystem and
 * then exports the /usr subtree to a deterministic zip.
 *
 *   build-node-zip.ts <node.wasm> <npm-source-dir> <output.zip>
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { FILE_MODES, OPEN_FLAGS } from "../../../host/src/generated/abi";
import { walkAndWrite, writeVfsBinary } from "./vfs-image-helpers";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";
import { stageSpiderMonkeyNpmRuntime } from "../lib/init/spidermonkey-npm-runtime";

const { S_IFMT, S_IFDIR, S_IFLNK, S_IFREG } = FILE_MODES;

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;

const [nodeWasmPath, npmSourceDir, outputZip] = process.argv.slice(2);
if (!nodeWasmPath || !npmSourceDir || !outputZip) {
  console.error("usage: build-node-zip.ts <node.wasm> <npm-source-dir> <output.zip>");
  process.exit(2);
}

// A memfs large enough for node.wasm (~29 MB) plus the npm dist (~15 MB).
const fs = MemoryFileSystem.create(new SharedArrayBuffer(160 * 1024 * 1024));
ensureDirRecursive(fs, "/usr/bin");
ensureDirRecursive(fs, "/usr/local/lib");
// The browser kernel worker writes the MITM CA cert here on init; npm reads it
// for HTTPS. Mirror node-vfs so the directory exists.
ensureDirRecursive(fs, "/etc/ssl");

writeVfsBinary(fs, "/usr/bin/node", new Uint8Array(readFileSync(nodeWasmPath)), 0o755);

console.log("==> Mounting npm dist...");
const written = walkAndWrite(fs, npmSourceDir, "/usr/local/lib/npm", {
  exclude: (rel: string) =>
    rel === "man" || rel.startsWith("man/") ||
    rel === "docs" || rel.startsWith("docs/"),
});
console.log(`    ${written} npm files`);

// Reuse node-vfs's exact runtime glue (runner, launchers, shims, source
// patches, /usr/bin/npm+npx, /usr/local/bin symlinks). It also writes /bin/npm
// symlinks and the demo /etc/profile.d file, but those live outside /usr so the
// subtree export below simply drops them; the shell overlay owns the /bin
// aliases and a minimal npm profile for the base shell.
stageSpiderMonkeyNpmRuntime(fs);

console.log("==> Exporting the /usr subtree...");
const workRoot = process.env.WASM_POSIX_DEP_WORK_DIR || tmpdir();
const staging = mkdtempSync(join(workRoot, "node-zip."));
try {
  // Export the children of /usr into the archive root (/usr/bin -> bin, etc.).
  const dh = fs.opendir("/usr");
  try {
    for (let entry = fs.readdir(dh); entry; entry = fs.readdir(dh)) {
      if (entry.name === "." || entry.name === "..") continue;
      exportNode(`/usr/${entry.name}`, join(staging, entry.name));
    }
  } finally {
    fs.closedir(dh);
  }

  execFileSync("bash", [join(SCRIPT_DIR, "create-deterministic-zip.sh"), staging, outputZip], {
    stdio: "inherit",
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

// Recursively materialize a memfs path to disk, preserving directories,
// symlinks (target verbatim — the runtime's absolute /usr/... targets resolve
// once the archive is mounted at /usr), and regular files with their mode.
function exportNode(memPath: string, diskPath: string): void {
  const st = fs.lstat(memPath);
  const kind = st.mode & S_IFMT;
  if (kind === S_IFDIR) {
    mkdirSync(diskPath, { recursive: true });
    const dh = fs.opendir(memPath);
    try {
      for (let entry = fs.readdir(dh); entry; entry = fs.readdir(dh)) {
        if (entry.name === "." || entry.name === "..") continue;
        exportNode(`${memPath}/${entry.name}`, join(diskPath, entry.name));
      }
    } finally {
      fs.closedir(dh);
    }
  } else if (kind === S_IFLNK) {
    symlinkSync(fs.readlink(memPath), diskPath);
  } else if (kind === S_IFREG) {
    const fd = fs.open(memPath, OPEN_FLAGS.O_RDONLY, 0);
    try {
      const buf = new Uint8Array(st.size);
      let offset = 0;
      while (offset < buf.byteLength) {
        const n = fs.read(fd, buf.subarray(offset), null, buf.byteLength - offset);
        if (n <= 0) break;
        offset += n;
      }
      writeFileSync(diskPath, buf);
      chmodSync(diskPath, st.mode & 0o777);
    } finally {
      fs.close(fd);
    }
  } else {
    throw new Error(`unsupported memfs node kind for ${memPath}`);
  }
}
