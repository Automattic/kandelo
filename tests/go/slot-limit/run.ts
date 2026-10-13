import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <one-slot-second-m.wasm> <kernel.wasm>");
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
if (result.exitCode === 0 ||
    !result.stderr.includes("newosproc: kernel_clone failed") ||
    !JSON.stringify(result.hostDiagnostics).includes("pthread slot limit exhausted (limit=1")) {
  process.exitCode = 1;
}
