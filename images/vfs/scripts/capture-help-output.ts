/**
 * Capture `--help` and `--version` output from real programs running inside
 * Kandelo, for host-side help2man to format into manual pages (the third
 * tier of docs/porting-guide.md "Shipping man pages": programs with no
 * upstream manual).
 *
 * Faithfulness (CLAUDE.md "Platform Values Contract"): every captured byte
 * is printed by the program executing inside a real Kandelo kernel booted
 * from the declared kernel and base rootfs. This script does not write,
 * edit or filter help text, and it does not run help2man; the calling
 * docs recipe formats the capture (scripts/install-package-man-pages.sh,
 * kandelo_man_pages_help2man).
 *
 * The capture image is the base rootfs plus the files the spec names, so a
 * program runs where the shell installs it, beside what it needs (an
 * interpreter, its library tree). The base rootfs keeps most programs as
 * lazy files, which this host cannot fetch, so a spec names every program
 * a capture executes, including a script's interpreter. Each capture boots its own kernel, so no
 * run can see another's state.
 *
 * Usage: tsx capture-help-output.ts <spec.json> <capture-dir>
 *        <kernel.wasm> <rootfs.vfs.zst>
 *
 * The spec:
 *   {
 *     "files":    [{ "from": "<host file>", "to": "/usr/bin/x", "mode": 493 }],
 *     "trees":    [{ "from": "<host dir>", "to": "/usr" }],
 *     "env":      ["PATH=/usr/bin:/bin"],
 *     "uid": 1000, "gid": 1000,
 *     "commands": [{ "name": "x", "path": "/usr/bin/x", "argv0": "x",
 *                    "stream": "stdout", "help": ["--help"] }]
 *   }
 *
 * For each command, `<name>.help` and `<name>.version` receive what
 * `<argv0> --help` (or `<argv0> <help...>`) and `<argv0> --version` printed on `stream` (stdout
 * unless a program prints its usage on stderr). A command whose --help
 * prints nothing is reported and skipped: the recipe's page list then
 * fails on the missing page, and a missing page is an honest gap, never
 * a fabricated one.
 *
 * Commands run as root unless the spec names a uid and gid; a program that
 * refuses to run as root (composer) runs as the shell's ordinary user.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";
import { maybeDecompressImage } from "../../../host/src/vfs/vfs-image-transport";

interface Spec {
  files?: Array<{ from: string; to: string; mode?: number }>;
  trees?: Array<{ from: string; to: string }>;
  env?: string[];
  uid?: number;
  gid?: number;
  commands: Array<{
    name: string;
    path: string;
    argv0?: string;
    stream?: "stdout" | "stderr";
    help?: string[];
  }>;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function pathExists(fs: KandeloImageFs, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copy a host directory tree into the image, keeping modes and symlinks. */
function copyTree(fs: KandeloImageFs, from: string, to: string): void {
  ensureDirRecursive(fs, to);
  for (const name of readdirSync(from).sort()) {
    const source = join(from, name);
    const target = `${to === "/" ? "" : to}/${name}`;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      fs.symlink(readlinkSync(source), target);
    } else if (stat.isDirectory()) {
      copyTree(fs, source, target);
    } else if (stat.isFile()) {
      fs.writeFile(target, new Uint8Array(readFileSync(source)), stat.mode & 0o7777);
    } else {
      throw new Error(`capture-help-output: unsupported file type: ${source}`);
    }
  }
}

function captureImage(rootfs: Uint8Array, spec: Spec): Uint8Array {
  const fs = KandeloImageFs.create();
  fs.loadImage(rootfs);
  for (const { from, to } of spec.trees ?? []) copyTree(fs, from, to);
  for (const { from, to, mode } of spec.files ?? []) {
    ensureDirRecursive(fs, parentOf(to));
    // The base rootfs keeps most programs as lazy files the capture host
    // cannot fetch; a declared file replaces the entry with its bytes.
    if (pathExists(fs, to)) fs.unlink(to);
    fs.writeFile(to, new Uint8Array(readFileSync(from)), mode ?? 0o755);
  }
  return fs.exportImage();
}

async function capture(
  kernel: Uint8Array,
  image: Uint8Array,
  path: string,
  argv: string[],
  env: string[],
  stream: "stdout" | "stderr",
  user: { uid?: number; gid?: number },
): Promise<string> {
  const decoder = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const output = { stdout: "", stderr: "" };
  const host = new NodeKernelHost({
    rootfsImage: image,
    onStdout: (_pid, bytes) => {
      output.stdout += decoder.stdout.decode(bytes, { stream: true });
    },
    onStderr: (_pid, bytes) => {
      output.stderr += decoder.stderr.decode(bytes, { stream: true });
    },
  });
  try {
    await host.init(
      kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) as ArrayBuffer,
    );
    const { exit } = await host.spawnFromVfs(path, argv, { env, ...user });
    await exit;
    return output[stream];
  } finally {
    await host.destroy().catch(() => {});
  }
}

async function main() {
  const [specPath, outDir, kernelPath, rootfsPath] = process.argv.slice(2);
  if (!specPath || !outDir || !kernelPath || !rootfsPath) {
    console.error(
      "usage: capture-help-output.ts <spec.json> <capture-dir> <kernel.wasm> <rootfs.vfs.zst>",
    );
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
  const kernel = new Uint8Array(readFileSync(kernelPath));
  // The rootfs ships zstd-compressed; the image reader takes decoded bytes.
  const rootfs = maybeDecompressImage(new Uint8Array(readFileSync(rootfsPath)));
  const image = captureImage(rootfs, spec);
  const env = spec.env ?? ["PATH=/usr/local/bin:/usr/bin:/bin"];
  const user = { uid: spec.uid, gid: spec.gid };
  mkdirSync(outDir, { recursive: true });

  const skipped: string[] = [];
  for (const { name, path, argv0, stream, help: helpArgs } of spec.commands) {
    const argv0Name = argv0 ?? name;
    const which = stream ?? "stdout";
    const help = await capture(kernel, image, path, [argv0Name, ...(helpArgs ?? ["--help"])], env, which, user);
    const version = await capture(kernel, image, path, [argv0Name, "--version"], env, "stdout", user);
    if (!help.trim()) {
      console.error(`capture-help-output: skip ${name}: empty --help from Kandelo`);
      skipped.push(name);
      continue;
    }
    writeFileSync(join(outDir, `${name}.help`), help);
    writeFileSync(join(outDir, `${name}.version`), version);
  }
  const total = spec.commands.length;
  console.error(
    `capture-help-output: captured ${total - skipped.length}/${total}` +
      (skipped.length ? `; skipped: ${skipped.join(", ")}` : ""),
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
