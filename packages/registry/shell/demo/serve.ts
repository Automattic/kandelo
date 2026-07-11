/**
 * serve.ts — Run dash shell on the kandelo.
 *
 * Supports three modes:
 *   1. Command: npx tsx packages/registry/shell/demo/serve.ts -c "echo hello"
 *   2. Piped:   echo "echo hello" | npx tsx packages/registry/shell/demo/serve.ts
 *   3. Script:  npx tsx packages/registry/shell/demo/serve.ts script.sh
 *
 * Build dash first:
 *   bash packages/registry/dash/build-dash.sh
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { COREUTILS_NAMES } from "../../../../images/vfs/lib/init/shell-binaries";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

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
  const dashBinary = tryResolveBinary("programs/dash.wasm");
  if (!dashBinary) {
    console.error(
      "dash.wasm not found. Run: scripts/fetch-binaries.sh " +
      "(or bash packages/registry/dash/build-dash.sh to build locally).",
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

  // Load coreutils single binary (if available)
  const coreutilsBinary = tryResolveBinary("programs/coreutils.wasm");
  if (coreutilsBinary) {
    for (const name of COREUTILS_NAMES) {
      execPrograms[`/bin/${name}`] = coreutilsBinary;
      execPrograms[`/usr/bin/${name}`] = coreutilsBinary;
    }
    execPrograms["/bin/["] = coreutilsBinary;
    execPrograms["/usr/bin/["] = coreutilsBinary;
    console.error(`Loaded ${COREUTILS_NAMES.length} coreutils commands`);
  }

  // Load GNU grep (if available)
  const grepBinary = tryResolveBinary("programs/grep.wasm");
  if (grepBinary) {
    for (const name of ["grep", "egrep", "fgrep"]) {
      execPrograms[`/bin/${name}`] = grepBinary;
      execPrograms[`/usr/bin/${name}`] = grepBinary;
    }
    console.error("Loaded GNU grep");
  }

  // Load GNU sed (if available)
  const sedBinary = tryResolveBinary("programs/sed.wasm");
  if (sedBinary) {
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
