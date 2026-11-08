import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper.ts";

const [programPath, kernelPath, mode] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <program.wasm> <kernel.wasm> [--opcache]");
}
if (mode !== undefined && mode !== "--opcache") throw new Error("Unknown PHP embed probe mode");
let rootfsImage: Uint8Array | undefined;
if (mode === "--opcache") {
  const image = KandeloImageFs.create();
  for (const directory of ["/etc", "/etc/frankenphp", "/var", "/var/cache", "/var/cache/opcache"]) image.mkdir(directory, 0o755);
  image.createFileWithOwner("/etc/frankenphp/php.ini", 0o644, 0, 0, new TextEncoder().encode(`[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.file_cache=/var/cache/opcache
opcache.file_cache_only=1
opcache.validate_timestamps=0
`));
  rootfsImage = await image.saveImage();
}
const result = await runCentralizedProgram({
  programPath,
  kernelWasmBytes: readFileSync(kernelPath),
  argv: mode === "--opcache" ? ["go-php-embed", "opcache"] : ["go-php-embed"],
  env: mode === "--opcache" ? ["PHPRC=/etc/frankenphp", "HOME=/tmp", "TMPDIR=/tmp"] : undefined,
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
  (mode === "--opcache" && (!result.stdout.includes("PHP OPCACHE STATIC PASS\n") ||
    !result.stdout.includes("GO PHP OPCACHE PASS\n"))) ||
  result.stderr !== "" ||
  result.hostDiagnostics.length !== 0
) {
  process.exitCode = 1;
}
