import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, opcachePath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm> [opcache-zts.so]");
}

let rootfsImage: Uint8Array | undefined;
if (opcachePath) {
  const image = KandeloImageFs.create();
  image.mkdir("/lib", 0o755);
  image.createFileWithOwner(
    "/lib/opcache-zts.so", 0o644, 0, 0, new Uint8Array(readFileSync(opcachePath)),
  );
  rootfsImage = await image.saveImage();
}
const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: opcachePath ? ["go-php-embed", "opcache"] : ["go-php-embed"],
  timeout: 90_000,
  useDefaultRootfs: false,
  rootfsImage,
});

console.log(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));

if (
  result.exitCode !== 0 ||
  !result.stdout.includes("PHP EMBED PASS\nGO PHP EMBED PASS\n") ||
  (opcachePath && !result.stdout.includes("PHP OPCACHE DLOPEN PASS\n")) ||
  result.stderr !== "" ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
