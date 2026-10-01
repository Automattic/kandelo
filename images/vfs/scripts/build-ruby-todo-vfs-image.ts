/**
 * Build a bootable VFS image for the Ruby + Roda + SQLite todo demo.
 *
 * This is a dedicated Ruby SERVER image, so — like the redis/mariadb server
 * demos — it is assembled on an empty filesystem with everything RESIDENT. It
 * deliberately does NOT layer the browser shell base: that base ships the
 * interpreters (ruby, python, node, …) as on-demand LAZY archives mounted at
 * /usr, and a lazy Ruby at /usr overlapping a resident Ruby server breaks the
 * browser's kernel-owned VFS restore (dinit then cannot find its service). For
 * a server, Ruby must be a resident binary, not a lazy one.
 *
 * Layout:
 *   /usr/bin/ruby              — the Kandelo Ruby build (sqlite3 gem linked in)
 *   /usr/lib/ruby/4.0.0/**     — Ruby standard library + the sqlite3 gem lib
 *   /var/lib/todo/**           — the Roda app (app.rb, server.rb, views/, vendor/)
 *
 * No dinit tree — the Ruby server is booted directly as pid 1 (see the
 * `init.program` boot in ruby-todo-demo.json / demo-config.ts). One
 * long-running process doesn't need a service manager, and dinit is ~2.4 MB
 * this image deliberately skips.
 *
 * Not Rails — see docs/superpowers/specs/2026-09-21-browser-ruby-todo-design.md.
 *
 * Produces: apps/browser-demos/public/ruby-todo-vfs.vfs.zst
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  writeVfsBinary,
  writeVfsFile,
  saveImage,
  type VfsWasmArtifactPolicy,
} from "./vfs-image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { addDinitBaseSystemFiles } from "./dinit-image-helpers";
import { writeTrackedDemoConfig } from "./tracked-demo-config";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
} from "../../../web-libs/kandelo-session/src/experimental-terminal-session";

// The Terminal pane runs this program in the live kernel. A dedicated Ruby
// server image ships no shell, so the terminal is a Ruby IRB session — fitting,
// and it only needs to exist for boot validation (it runs on demand).
const EXPERIMENTAL_TERMINAL_SESSION = JSON.stringify({
  kind: "kandelo-experimental-terminal-session",
  version: 1,
  initial: {
    path: "/usr/bin/ruby",
    argv: ["ruby", "-e", "require 'irb'; IRB.start"],
    uid: 0,
    gid: 0,
  },
}, null, 2) + "\n";

const REPO_ROOT = findRepoRoot();
const OUT_FILE = join(
  REPO_ROOT, "apps", "browser-demos", "public", "ruby-todo-vfs.vfs.zst",
);
const APP_SRC = join(REPO_ROOT, "images", "vfs", "ruby-todo-app");
const RUBY_VFS_PATH = "/usr/bin/ruby";
const IMAGE_INITIAL_BYTES = 64 * 1024 * 1024;
const IMAGE_MAX_BYTES = 256 * 1024 * 1024;
const RUBY_WASM_ARTIFACT_POLICY = {
  path: RUBY_VFS_PATH,
  forkInstrumentation: "auto",
} as const satisfies VfsWasmArtifactPolicy;

export interface RubyTodoVfsImageBuildInputs {
  ruby: Uint8Array;
  /** Directory holding the extracted ruby-runtime (with a top-level usr/). */
  rubyRuntimeDir: string;
  /** Directory holding the app sources (app.rb, server.rb, views/, vendor/). */
  appDir: string;
  /** Exact /etc/services bytes (from images/rootfs/etc/services). */
  services?: Uint8Array;
  outputPath: string;
}

export async function buildRubyTodoVfsImage(
  inputs: RubyTodoVfsImageBuildInputs,
): Promise<void> {
  const sab = new SharedArrayBuffer(IMAGE_INITIAL_BYTES, {
    maxByteLength: IMAGE_MAX_BYTES,
  });
  const fs = MemoryFileSystem.create(sab, IMAGE_MAX_BYTES);

  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var", "/var/lib"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  // The Ruby server boots as the unprivileged `maker` account (uid/gid 1000
  // in ruby-todo-demo.json and browser-ruby-todo.toml), and /etc/passwd
  // already says that account's home is /home/maker. Create it so the HOME
  // the boot environment names is a real directory this uid owns, rather
  // than a path that only happens to be unused.
  ensureDir(fs, "/home/maker");
  fs.chown("/home/maker", 1000, 1000);
  fs.chmod("/home/maker", 0o755);

  // Ruby runtime: standard library + gem/bundler/irb scripts under /usr.
  console.log("Staging Ruby runtime...");
  const usrDir = join(inputs.rubyRuntimeDir, "usr");
  const staged = walkAndWrite(fs, usrDir, "/usr");
  console.log(`  ${staged} runtime files`);

  // Ruby interpreter (sqlite3 built in), resident.
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, RUBY_VFS_PATH, inputs.ruby, 0o755);

  // Application tree at /var/lib/todo.
  console.log("Staging Roda todo app...");
  ensureDirRecursive(fs, "/var/lib/todo");
  const appFiles = walkAndWrite(fs, inputs.appDir, "/var/lib/todo");
  console.log(`  ${appFiles} app files`);

  // Base /etc system files (passwd/group/hosts/services). No init system: the
  // Ruby server is booted directly as pid 1, so dinit is not included.
  ensureDir(fs, "/run");
  ensureDirRecursive(fs, "/var/log");
  addDinitBaseSystemFiles(fs, false, inputs.services);

  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH, EXPERIMENTAL_TERMINAL_SESSION);

  writeTrackedDemoConfig(fs, "packages/registry/ruby/ruby-todo-demo.json");

  await saveImage(fs, inputs.outputPath, {
    wasmArtifactPolicies: [RUBY_WASM_ARTIFACT_POLICY],
  });
}

async function main(): Promise<void> {
  const rubyRoot = process.env.WASM_POSIX_DEP_RUBY_DIR;
  const runtimeDir = process.env.RUBY_RUNTIME_DIR;
  if (!runtimeDir) {
    throw new Error("RUBY_RUNTIME_DIR must point at the extracted ruby-runtime");
  }
  await buildRubyTodoVfsImage({
    ruby: new Uint8Array(readFileSync(rubyRoot === undefined
      ? resolveBinary("programs/ruby/ruby.wasm")
      : join(rubyRoot, "ruby.wasm"))),
    rubyRuntimeDir: runtimeDir,
    appDir: APP_SRC,
    services: new Uint8Array(
      readFileSync(join(REPO_ROOT, "images", "rootfs", "etc", "services")),
    ),
    outputPath: process.argv[2] ?? OUT_FILE,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
