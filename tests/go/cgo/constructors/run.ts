import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, mode] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm>");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: mode ? ["go-cgo-constructors", mode] : ["go-cgo-constructors"],
  timeout: 30_000,
  useDefaultRootfs: false,
});
const expectedMarker = mode === "c-exit"
  ? "CGO C EXIT HANDLER PASS"
  : mode === "c-immediate-exit"
    ? "CGO C _EXIT PASS"
  : mode
    ? "CGO GO EXIT PASS"
    : "CGO CONSTRUCTORS PASS";

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));

if (
  result.exitCode !== 0 ||
  !result.stdout.includes(expectedMarker) ||
  (mode !== "c-exit" && result.stdout.includes("CGO C EXIT HANDLER PASS")) ||
  result.stderr !== "" ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
