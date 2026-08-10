import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { runCentralizedProgram } from "../centralized-test-helper";
import { buildVforkSideModuleFixture } from "../vfork-side-module-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function traceRun<T>(name: string, operation: () => Promise<T>): Promise<T> {
  console.log(`[vfork-mechanism-run] begin=${name}`);
  try {
    return await operation();
  } finally {
    console.log(`[vfork-mechanism-run] end=${name}`);
  }
}

const lifecycle = await traceRun("lifecycle", () => runCentralizedProgram({
  programPath: join(
    repoRoot,
    "local-binaries/programs/wasm32/vfork-lifecycle.wasm",
  ),
  argv: ["vfork-production-trace", "no-successful-exec"],
  useDefaultRootfs: false,
  timeout: 15_000,
}));
if (lifecycle.exitCode !== 0) {
  throw new Error(
    `vfork trace fixture failed (${lifecycle.exitCode}): ${lifecycle.stderr}`,
  );
}

const ordinary = await traceRun("ordinary", () => runCentralizedProgram({
  programPath: new URL("./fork-memory-clone.wasm", import.meta.url).pathname,
  argv: ["fork-production-trace"],
  useDefaultRootfs: false,
  timeout: 15_000,
}));
if (ordinary.exitCode !== 0) {
  throw new Error(
    `fork trace fixture failed (${ordinary.exitCode}): ${ordinary.stderr}`,
  );
}

const sideFixture = buildVforkSideModuleFixture();
try {
  const sideBytes = new Uint8Array(readFileSync(sideFixture.libraryPath));
  const imageOwner = MemoryFileSystem.create(
    new SharedArrayBuffer(Math.max(2 * 1024 * 1024, sideBytes.length * 4)),
  );
  imageOwner.mkdir("/lib", 0o755);
  imageOwner.createFileWithOwner(
    "/lib/libvfork-side.so",
    0o755,
    0,
    0,
    sideBytes,
  );
  const sideImage = await imageOwner.saveImage();
  const side = await traceRun("side-module", () => runCentralizedProgram({
    programPath: sideFixture.programPath,
    argv: ["vfork-side-main", "/lib/libvfork-side.so"],
    rootfsImage: sideImage,
    timeout: 30_000,
  }));
  if (
    side.exitCode !== 0
    || !side.stdout.includes("PRODUCTION_SIDE_VFORK_PASS")
  ) {
    throw new Error(
      `side-module vfork trace fixture failed (${side.exitCode}): ${side.stderr}`,
    );
  }
} finally {
  sideFixture.cleanup();
}

console.log("PRODUCTION_SIDE_TRACE_RUNNER_PASS");
console.log("PRODUCTION_VFORK_TRACE_RUNNER_PASS");
