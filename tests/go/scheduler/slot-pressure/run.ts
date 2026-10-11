import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, workersArg = "48"] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <slot-pressure.wasm> <kernel.wasm> [live-workers]");
}
const workers = Number(workersArg);
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 1023) {
  throw new Error("live-workers must be an integer from 1 to 1023");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: ["go-slot-pressure", String(workers)],
  timeout: Math.max(120_000, workers * 400),
  useDefaultRootfs: false,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes(`${workers} concurrent locked Go threads: complete`) ||
    result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
