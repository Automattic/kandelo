import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <os-test.wasm> <kernel.wasm>");
}

const image = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
image.mkdir("/tmp", 0o777);
image.mkdir("/etc", 0o755);
image.createFileWithOwner("/etc/group", 0o644, 0, 0, new TextEncoder().encode("staff:x:200:runner\n"));

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  rootfsImage: new Uint8Array(await image.saveImage()),
  argv: ["go-os-test", "-test.run=^(TestStat|TestStatError|TestReadClosed|TestReadAt|TestReadAtOffset|TestReadAtNegativeOffset|TestOpenError|TestReaddirNValues|TestReaddirOfFile|TestChmod|TestOpenFileKeepsPermissions|TestChown|TestFileChown|TestLchown)$", "-test.v"],
  timeout: 90_000,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes("--- PASS: TestOpenError") ||
    !result.stdout.includes("--- PASS: TestReaddirNValues") ||
    !result.stdout.includes("--- PASS: TestChmod") ||
    !result.stdout.includes("--- PASS: TestChown") ||
    !result.stdout.includes("--- PASS: TestFileChown") ||
    !result.stdout.includes("--- PASS: TestLchown") ||
    !result.stdout.includes("PASS\n") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
