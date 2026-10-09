import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants.ts";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs.ts";

const supervisorPath = resolve(".context/roadrunner-supervisor.wasm");
const serverPath = resolve(".context/roadrunner-minimal.wasm");
const phpPath = resolveBinary("programs/wasm32/php/php.wasm");
const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
const programs = [supervisorPath, serverPath, phpPath].map((path) => readFileSync(path));
const kernelDigest = readWasmCustomSectionPayload(
  Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
);
if (!kernelDigest || kernelDigest.length !== 32) {
  throw new Error("kernel ABI-contract digest is missing");
}
for (const program of programs) {
  const digest = readWasmCustomSectionPayload(
    Uint8Array.from(program).buffer, ABI_CONTRACT_SECTION,
  );
  if (!digest || !digest.every((byte, index) => byte === kernelDigest[index])) {
    throw new Error("RoadRunner probe ABI-contract digest does not match the kernel");
  }
}

const config = readFileSync("tests/go/roadrunner/rr.yaml");
const worker = readFileSync("tests/go/roadrunner/worker.php");
const capacity = programs[1].byteLength + programs[2].byteLength + 4 * 1024 * 1024;
const image = MemoryFileSystem.create(new SharedArrayBuffer(Math.ceil(capacity / 4) * 4));
image.mkdir("/etc", 0o755);
image.createFileWithOwner("/etc/rr.yaml", 0o644, 0, 0, new Uint8Array(config));
image.createFileWithOwner("/worker.php", 0o644, 0, 0, new Uint8Array(worker));

const events: Array<{ kind: string; pid: number; ppid?: number; exitStatus?: number }> = [];

const result = await runCentralizedProgram({
  programPath: supervisorPath,
  kernelWasmBytes: kernelBytes,
  rootfsImage: new Uint8Array(await image.saveImage()),
  execPrograms: new Map([
    ["/bin/roadrunner.wasm", serverPath],
    ["/bin/php.wasm", phpPath],
  ]),
  useDefaultRootfs: false,
  captureForkCount: true,
  timeout: 90_000,
  onProcessEvent: (event) => events.push(event),
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
  forkCountSamples: result.forkCountSamples?.map(String),
  events,
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes("ROADRUNNER ROUND TRIP PASS") ||
    result.hostDiagnostics.length !== 0 ||
    !result.forkCountSamples?.every((count) => count === 0n)) {
  process.exitCode = 1;
}
