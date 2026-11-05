import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, mode] = process.argv.slice(2);
if (!programPath || !kernelPath) throw new Error("usage: run.ts <signal.wasm> <kernel.wasm>");
if (mode && mode !== "reset" && mode !== "stop") throw new Error("mode must be reset or stop");
const result = await runCentralizedProgram({
  programPath, kernelWasmBytes: readFileSync(kernelPath),
  argv: mode ? ["go-signal-basic", mode] : ["go-signal-basic"], timeout: 20_000, useDefaultRootfs: false,
});
console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout,
  stderr: result.stderr, diagnostics: result.hostDiagnostics }));
const expectedExit = mode ? 128 + 15 : 0;
const marker = mode ? "GO SIGNAL NOTIFY PASS" : "GO SIGNAL PASS";
if (result.exitCode !== expectedExit || !result.stdout.includes(marker) ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) process.exitCode = 1;
