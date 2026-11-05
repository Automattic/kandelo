import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, mode] = process.argv.slice(2);
if (!programPath || !kernelPath) throw new Error("usage: run.ts <signal.wasm> <kernel.wasm>");
if (mode && !["reset", "stop", "quit", "blocked-wait"].includes(mode)) throw new Error("unknown signal probe mode");
if (mode === "blocked-wait") {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(readFileSync(programPath))));
  if (!imports.some(entry => entry.module === "kernel" && entry.name === "kernel_heap_safepoint")) {
    throw new Error("Go runtime omitted the host heap-safepoint import");
  }
}
const result = await runCentralizedProgram({
  programPath, kernelWasmBytes: readFileSync(kernelPath),
  argv: mode ? ["go-signal-basic", mode] : ["go-signal-basic"], timeout: 20_000, useDefaultRootfs: false,
});
console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout,
  stderr: result.stderr, diagnostics: result.hostDiagnostics }));
const expectedExit = mode === "quit" ? 2 : mode === "blocked-wait" || !mode ? 0 : 128 + 15;
const marker = mode === "blocked-wait" ? "GO SAFEPOINT WAIT PASS" : mode === "quit" ? "GO SIGNAL QUIT READY" : mode ? "GO SIGNAL NOTIFY PASS" : "GO SIGNAL PASS";
const stderrMatches = mode === "quit"
  ? result.stderr.includes("SIGQUIT") && result.stderr.includes("goroutine")
  : result.stderr === "";
if (result.exitCode !== expectedExit || !result.stdout.includes(marker) ||
    !stderrMatches || result.hostDiagnostics.length !== 0) process.exitCode = 1;
