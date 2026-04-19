/**
 * serve.ts — Run dash shell on the wasm-posix-kernel.
 *
 * Supports three modes:
 *   1. Command: npx tsx examples/shell/serve.ts -c "echo hello"
 *   2. Piped:   echo "echo hello" | npx tsx examples/shell/serve.ts
 *   3. Script:  npx tsx examples/shell/serve.ts script.sh
 *
 * Build dash first:
 *   bash examples/libs/dash/build-dash.sh
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NodeKernelHost } from "../../host/src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Read all of stdin (for piped mode). */
function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

async function main() {
  const dashBinPath = resolve(repoRoot, "examples/libs/dash/bin/dash.wasm");
  const dashSrcPath = resolve(repoRoot, "examples/libs/dash/dash-src/src/dash");
  const dashBinary = existsSync(dashBinPath) ? dashBinPath : dashSrcPath;
  if (!existsSync(dashBinary)) {
    console.error(
      "dash binary not found. Run: bash examples/libs/dash/build-dash.sh",
    );
    process.exit(1);
  }

  // Parse args: everything after serve.ts goes to dash
  const args = process.argv.slice(2);
  const dashArgv = ["dash", ...args];

  // Read piped stdin if available
  const stdinData = await readStdin();

  const programBytes = loadBytes(dashBinary);

  // --- Load external programs for exec ---
  const execPrograms: Record<string, string> = {};

  // Load coreutils single binary (if built)
  const coreutilsBinary = resolve(
    repoRoot,
    "examples/libs/coreutils/bin/coreutils.wasm",
  );
  if (existsSync(coreutilsBinary)) {
    const coreutilsNames = [
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
    for (const name of coreutilsNames) {
      execPrograms[`/bin/${name}`] = coreutilsBinary;
      execPrograms[`/usr/bin/${name}`] = coreutilsBinary;
    }
    execPrograms["/bin/["] = coreutilsBinary;
    execPrograms["/usr/bin/["] = coreutilsBinary;
    console.error(`Loaded ${coreutilsNames.length} coreutils commands`);
  }

  // Load GNU grep (if built)
  const grepBinary = resolve(repoRoot, "examples/libs/grep/bin/grep.wasm");
  if (existsSync(grepBinary)) {
    for (const name of ["grep", "egrep", "fgrep"]) {
      execPrograms[`/bin/${name}`] = grepBinary;
      execPrograms[`/usr/bin/${name}`] = grepBinary;
    }
    console.error("Loaded GNU grep");
  }

  // Load GNU sed (if built)
  const sedBinary = resolve(repoRoot, "examples/libs/sed/bin/sed.wasm");
  if (existsSync(sedBinary)) {
    execPrograms["/bin/sed"] = sedBinary;
    execPrograms["/usr/bin/sed"] = sedBinary;
    console.error("Loaded GNU sed");
  }

  // Load dash as /bin/sh
  execPrograms["/bin/sh"] = dashBinary;
  execPrograms["/bin/dash"] = dashBinary;

  const host = new NodeKernelHost({
    maxWorkers: 8,
    execPrograms,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });

  await host.init();

  const exitCode = await host.spawn(programBytes, dashArgv, {
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TMPDIR=/tmp",
      "TERM=dumb",
    ],
    cwd: "/",
    stdin: stdinData.length > 0 ? new Uint8Array(stdinData) : undefined,
  });

  await host.destroy().catch(() => {});
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
