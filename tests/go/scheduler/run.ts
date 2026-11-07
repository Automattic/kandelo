import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
const expectedOutput = process.argv[4] ?? "parallel M: complete";
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm> [expected-output] [guest-args...]");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: [programPath, ...process.argv.slice(5)],
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
  !result.stdout.includes(expectedOutput) ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
