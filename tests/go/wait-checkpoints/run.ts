import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) throw new Error("Expected program and kernel paths");
const result = await runCentralizedProgram({
  programPath, kernelWasmBytes: readFileSync(kernelPath),
  timeout: 30_000, useDefaultRootfs: false,
});
console.log(JSON.stringify({
  exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 || !["GO WAIT CHECKPOINT PASS", "GO NOTE DEADLINES PASS", "GO NOTE WAKEUPS PASS"]
    .every(marker => result.stdout.includes(marker)) ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) process.exitCode = 1;
