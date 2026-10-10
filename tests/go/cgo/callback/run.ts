import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, mode] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm>");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: mode === "stress" ? ["go-cgo-callback", "stress"] : ["go-cgo-callback"],
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
  !result.stdout.includes(mode === "stress" ? "CGO CALLBACK STRESS PASS" : "CGO CALLBACK PASS") ||
  result.stderr !== "" ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
