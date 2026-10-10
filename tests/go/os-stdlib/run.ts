import { readFileSync } from "node:fs";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs.ts";

const [programPath, kernelPath, testFilter] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <os-test.wasm> <kernel.wasm> [test-filter]");
}

const image = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
image.mkdir("/tmp", 0o777);
image.mkdir("/etc", 0o755);
image.mkdir("/exec", 0o755);
image.mkdir("/testdata", 0o755);
image.mkdir("/testdata/issue37161", 0o755);
image.createFileWithOwner("/etc/group", 0o644, 0, 0, new TextEncoder().encode("staff:x:200:runner\n"));
image.createFileWithOwner("/read_test.go", 0o644, 0, 0, new TextEncoder().encode("package os_test\n"));
for (const name of ["a", "b", "c"]) {
  image.createFileWithOwner(`/testdata/issue37161/${name}`, 0o644, 0, 0, new TextEncoder().encode(`${name}\n`));
}

const selectedTests = [
  "TestStat", "TestStatError", "TestReadClosed", "TestReadAt", "TestReadAtOffset",
  "TestReadAtNegativeOffset", "TestOpenError", "TestReaddirNValues", "TestReaddirOfFile",
  "TestChmod", "TestOpenFileKeepsPermissions", "TestChown", "TestFileChown",
  "TestLchown", "TestReadFile", "TestWriteFile", "TestReadDir", "TestMkdirAll",
  "TestRemoveAll", "TestSymlink", "TestRename", "TestCreateTemp", "TestMkdirTemp",
  "TestTruncate", "TestDirSeek", "TestReaddirSmallSeek",
  "TestRootOpen_File", "TestRootOpen_Directory", "TestRootSymlink",
  "TestRootConsistencyMkdirAll",
];
const requiredMarkers = [
  "--- PASS: TestOpenError", "--- PASS: TestReaddirNValues", "--- PASS: TestChmod",
  "--- PASS: TestChown", "--- PASS: TestFileChown", "--- PASS: TestLchown",
  "--- PASS: TestMkdirAll", "--- PASS: TestRemoveAll", "--- PASS: TestReadFile",
  "--- PASS: TestReadDir", "--- PASS: TestDirSeek", "--- PASS: TestReaddirSmallSeek",
  "--- PASS: TestRootOpen_File", "--- PASS: TestRootOpen_Directory",
  "--- PASS: TestRootSymlink", "--- PASS: TestRootConsistencyMkdirAll",
];

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  rootfsImage: new Uint8Array(await image.saveImage()),
  argv: ["go-os-test", testFilter ?? `-test.run=^(${selectedTests.join("|")})$`, "-test.v"],
  timeout: 90_000,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 ||
    (testFilter === undefined && requiredMarkers.some((marker) => !result.stdout.includes(marker))) ||
    !result.stdout.includes("PASS\n") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
