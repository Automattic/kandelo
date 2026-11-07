import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants.ts";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const packagePath = resolveBinary("programs/wasm32/go-hello.wasm");
const launcherPath = resolve(".context/go-package/launcher.wasm");
const kernelPath = resolveBinary("kernel.wasm");
const packageBytes = readFileSync(packagePath);
const kernelBytes = readFileSync(kernelPath);
const packageDigest = readWasmCustomSectionPayload(Uint8Array.from(packageBytes).buffer, ABI_CONTRACT_SECTION);
const kernelDigest = readWasmCustomSectionPayload(Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION);
if (!packageDigest || !kernelDigest || packageDigest.length !== 32 || kernelDigest.length !== 32 ||
    !packageDigest.every((byte, index) => byte === kernelDigest[index])) {
  throw new Error("resolved Go package ABI-contract digest does not match the kernel");
}

const result = await runCentralizedProgram({
  programPath: launcherPath,
  kernelWasmBytes: kernelBytes,
  argv: [launcherPath],
  execPrograms: new Map([["/bin/go-hello.wasm", packagePath]]),
  captureForkCount: true,
  useDefaultRootfs: false,
  timeout: 30_000,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
  forkCountSamples: result.forkCountSamples?.map(String),
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes("GO PACKAGE PASS") ||
    !result.stdout.includes("GO PACKAGE LAUNCH PASS") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0 ||
    !result.forkCountSamples?.length ||
    !result.forkCountSamples.every((count) => count === 0n)) {
  process.exitCode = 1;
}
