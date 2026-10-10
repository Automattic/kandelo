import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <syscall-test.wasm> <kernel.wasm>");
}

const image = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
image.mkdir("/tmp", 0o777);

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  rootfsImage: new Uint8Array(await image.saveImage()),
  argv: ["go-syscall-test", "-test.run=^TestDirent(Repeat)?$", "-test.v"],
  timeout: 90_000,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes("--- PASS: TestDirent") ||
    !result.stdout.includes("--- PASS: TestDirentRepeat") ||
    !result.stdout.includes("PASS\n") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
