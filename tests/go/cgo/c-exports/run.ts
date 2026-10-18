import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, sideModulePath, kernelPath] = process.argv.slice(2);
if (!programPath || !sideModulePath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <side.so> <kernel.wasm>");
}

const image = KandeloImageFs.create();
image.mkdir("/lib", 0o755);
image.createFileWithOwner(
  "/lib/libprobe.so", 0o644, 0, 0, new Uint8Array(readFileSync(sideModulePath)),
);
const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  rootfsImage: await image.saveImage(),
  timeout: 30_000,
});

console.log(JSON.stringify(result));
if (result.exitCode !== 0 ||
    !result.stdout.includes("CGO C EXPORT DLOPEN PASS") ||
    result.stderr !== "" || result.hostDiagnostics.length !== 0) {
  process.exitCode = 1;
}
