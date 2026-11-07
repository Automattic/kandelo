import { readFileSync } from "node:fs";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants.ts";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
const stdlibTests = process.argv[4] === "stdlib-tests";
const stdlibFull = process.argv[4] === "stdlib-full";
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm> [stdlib-tests]");
}

const programBytes = readFileSync(programPath);
const kernelBytes = readFileSync(kernelPath);
const programDigest = readWasmCustomSectionPayload(
  Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
);
const kernelDigest = readWasmCustomSectionPayload(
  Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
);
if (!programDigest || !kernelDigest || programDigest.length !== 32 ||
    kernelDigest.length !== 32 ||
    !programDigest.every((byte, index) => byte === kernelDigest[index])) {
  throw new Error("Go user fixture ABI-contract digest does not match the kernel");
}

const image = KandeloImageFs.create();
image.setImageCapacity(2 * 1024 * 1024);
image.mkdir("/etc", 0o755);
image.createFileWithOwner("/etc/passwd", 0o644, 0, 0, new TextEncoder().encode(
  "root:x:0:0:Root:/root:/bin/sh\ndaemon:x:1:1:Daemon:/home/daemon:/bin/sh\nrunner:x:1001:200:Runner:/home/runner:/bin/sh\n",
));
image.createFileWithOwner("/etc/group", 0o644, 0, 0, new TextEncoder().encode(
  "root:x:0:\nstaff:x:200:runner\nworkers:x:201:runner\n",
));

const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: kernelBytes,
  rootfsImage: new Uint8Array(await image.saveImage()),
  argv: stdlibTests || stdlibFull
    ? [programPath, stdlibFull
      ? "-test.run=^Test"
      : "-test.run=^(TestFindGroupName|TestFindGroupId|TestInvalidUserId|TestLookupUserId|TestLookupUserPopulatesAllFields|TestLookupUser|TestListGroups)$", "-test.v"]
    : [programPath],
  timeout: stdlibFull ? 90_000 : 30_000,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
if (result.exitCode !== 0 ||
    !result.stdout.includes(stdlibTests || stdlibFull ? "PASS" : "GO USER PASS") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
