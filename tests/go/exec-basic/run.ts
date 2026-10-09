import { readFileSync } from "node:fs";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants.ts";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm>");
}

const programBytes = readFileSync(programPath);
const kernelBytes = readFileSync(kernelPath);
const programDigest = readWasmCustomSectionPayload(
  Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
);
const kernelDigest = readWasmCustomSectionPayload(
  Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
);
if (
  !programDigest || !kernelDigest ||
  programDigest.length !== 32 || kernelDigest.length !== 32 ||
  !programDigest.every((byte, index) => byte === kernelDigest[index])
) {
  throw new Error("Go fixture ABI-contract digest does not match the kernel");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: kernelBytes,
  argv: [programPath],
  execPrograms: new Map([["/bin/go-exec-basic.wasm", programPath]]),
  captureForkCount: true,
  timeout: 30_000,
  useDefaultRootfs: false,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
  forkCountSamples: result.forkCountSamples?.map(String),
}));
if (
  result.exitCode !== 0 ||
  !result.stdout.includes("GO EXEC CHILD") ||
  !result.stdout.includes("GO EXEC PASS") ||
  result.stderr !== "" ||
  result.hostDiagnostics.length !== 0 ||
  !result.forkCountSamples?.every((count) => count === 0n)
) {
  process.exitCode = 1;
}
