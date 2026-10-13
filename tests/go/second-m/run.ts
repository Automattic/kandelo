import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
const expectedThreadMarkers = Number(process.argv[4] ?? 1);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm> [expected-markers]");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  timeout: 30_000,
  useDefaultRootfs: false,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));

if (
  result.exitCode !== 0 ||
  !result.stdout.includes("M1: after spawn") ||
  result.stderr.split("M2 alive via kernel_clone").length - 1 !== expectedThreadMarkers ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
