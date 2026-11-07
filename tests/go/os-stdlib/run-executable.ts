import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
const testName = process.argv[4] ?? "TestExecutable";
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run-executable.ts <os-test.wasm> <kernel.wasm> [test-name]");
}

const bytes = readFileSync(programPath);
const image = KandeloImageFs.create();
image.setImageCapacity(bytes.byteLength + 4 * 1024 * 1024);
image.mkdir("/bin", 0o755);
image.mkdir("/tmp", 0o777);
image.createFileWithOwner("/bin/os-test.wasm", 0o755, 0, 0, new Uint8Array(bytes));

let stdout = "";
let stderr = "";
const diagnostics: unknown[] = [];
const host = new NodeKernelHost({
  rootfsImage: new Uint8Array(await image.saveImage()),
  onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
  onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  onHostDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
});
try {
  const kernelBytes = readFileSync(kernelPath);
  await host.init(kernelBytes.buffer.slice(
    kernelBytes.byteOffset,
    kernelBytes.byteOffset + kernelBytes.byteLength,
  ) as ArrayBuffer);
  const { exit } = await host.spawnFromVfs(
    "/bin/os-test.wasm",
    ["forged-display-name", `-test.run=^${testName}$`, "-test.v"],
  );
  const exitCode = await exit;
  console.log(JSON.stringify({ exitCode, stdout, stderr, diagnostics }));
  if (
    exitCode !== 0 ||
    !stdout.includes(`--- PASS: ${testName}`) ||
    !stdout.includes("PASS\n") ||
    stderr !== "" ||
    diagnostics.length !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await host.destroy();
}
