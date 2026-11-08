import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, workersArg = "48", roundsArg = "1"] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <slot-pressure.wasm> <kernel.wasm> [live-workers] [rounds]");
}
const workers = Number(workersArg);
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 1023) {
  throw new Error("live-workers must be an integer from 1 to 1023");
}
const rounds = Number(roundsArg);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) {
  throw new Error("rounds must be an integer from 1 to 50");
}

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: ["go-slot-pressure", String(workers), String(rounds)],
  timeout: Math.max(120_000, workers * rounds * 400),
  useDefaultRootfs: false,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
const expectedOutput = `${workers} concurrent locked Go threads: complete${rounds > 1 ? ` after ${rounds} rounds` : ""}`;
if (result.exitCode !== 0 ||
    !result.stdout.includes(expectedOutput) ||
    result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
