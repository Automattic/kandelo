import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const programPath = process.argv[2];
const kernelPath = process.argv[3];
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run-vfs.ts <program.wasm> <kernel.wasm>");
}

const bytes = readFileSync(programPath);
const image = KandeloImageFs.create();
image.setImageCapacity(bytes.byteLength + 4 * 1024 * 1024);
image.mkdir("/bin", 0o755);
image.createFileWithOwner("/bin/go-exec-basic.wasm", 0o755, 0, 0, new Uint8Array(bytes));

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
    "/bin/go-exec-basic.wasm",
    ["forged-display-name"],
    { env: ["GO_EXPECT_EXE=present"] },
  );
  const exitCode = await exit;
  console.log(JSON.stringify({ exitCode, stdout, stderr, diagnostics }));
  if (
    exitCode !== 0 ||
    !stdout.includes("GO EXEC CHILD") ||
    !stdout.includes("GO EXEC PATH PASS") ||
    !stdout.includes("GO EXEC PASS") ||
    stderr !== "" ||
    diagnostics.length !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await host.destroy();
}
