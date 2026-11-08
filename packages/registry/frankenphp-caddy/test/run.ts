import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host.ts";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../../host/src/constants.ts";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";
import {
  countGoCollections, requestLifetimePhp, verifyRequestStringLifetimes, withDeadline,
} from "../../../../tests/go/frankenphp/request-lifetime.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <frankenphp-caddy.wasm> <kernel.wasm>");
}
const program = readFileSync(programPath);
const kernelWasm = readFileSync(kernelPath);
const contract = readWasmCustomSectionPayload(Uint8Array.from(kernelWasm).buffer, ABI_CONTRACT_SECTION);
assert.equal(contract?.byteLength, 32);
assert.deepEqual(readWasmCustomSectionPayload(Uint8Array.from(program).buffer, ABI_CONTRACT_SECTION), contract);

const image = KandeloImageFs.create();
image.setImageCapacity(2 * 1024 * 1024);
for (const directory of [
  "/etc", "/etc/caddy", "/etc/frankenphp", "/tmp", "/var", "/var/cache",
  "/var/cache/opcache", "/srv", "/srv/www", "/srv/www/html",
]) image.mkdir(directory, 0o755);
function file(path: string, contents: string) {
  image.createFileWithOwner(path, 0o644, 0, 0, new TextEncoder().encode(contents));
}
file("/srv/www/html/lifetime.php", requestLifetimePhp);
file("/srv/www/html/index.php", "<?php echo 'CADDY PHP ', $_SERVER['REQUEST_METHOD'], '|', $_SERVER['SCRIPT_NAME'];");
file("/srv/www/html/robots.txt", "CADDY STATIC\n");
file("/etc/caddy/Caddyfile", `{
  admin off
  auto_https off
  frankenphp {
    num_threads 2
  }
}
:8080 {
  root * /srv/www/html
  php_server
}
`);
file("/etc/frankenphp/php.ini", `[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=64
opcache.file_cache=/var/cache/opcache
opcache.file_cache_only=1
opcache.file_update_protection=0
opcache.validate_timestamps=0
`);
file("/srv/www/html/target.php", "<?php return 1;");
file("/srv/www/html/opcache.php", `<?php
header('Content-Type: application/json');
$configuration = opcache_get_configuration();
$target = __DIR__ . '/target.php';
echo json_encode([
  'loaded' => extension_loaded('Zend OPcache'),
  'fileCacheOnly' => !empty($configuration['directives']['opcache.file_cache_only']),
  'compiled' => opcache_compile_file($target),
  'cacheFilePresent' => count(glob('/var/cache/opcache/*' . $target . '.bin')) > 0,
], JSON_THROW_ON_ERROR);
`);

const decoder = new TextDecoder();
let stderr = "";
let serverPid = 0;
let serverExit: Promise<number> | undefined;
let stopped = false;
const diagnostics: unknown[] = [];
const host = new NodeKernelHost({
  rootfsImage: await image.saveImage(), maxWorkers: 12,
  onStderr: (_pid, bytes) => { stderr += decoder.decode(bytes); },
  onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
});
const fetch = (url: string) => host.fetchInKernel(8080, {
  method: "GET", url, headers: { Host: "localhost:8080" }, body: null,
}, { timeoutMs: 30_000 });
try {
  await host.init(Uint8Array.from(kernelWasm).buffer);
  serverExit = host.spawn(Uint8Array.from(program).buffer, [
    "frankenphp-caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
  ], {
    env: ["HOME=/tmp", "TMPDIR=/tmp", "PHPRC=/etc/frankenphp", "GOGC=1", "GOMEMLIMIT=32MiB", "GODEBUG=gctrace=1"],
    onStarted: (pid) => { serverPid = pid; },
  });
  let exitCode: number | undefined;
  let exitError: unknown;
  serverExit.then((code) => { exitCode = code; }, (error) => { exitError = error; });
  let php: Awaited<ReturnType<typeof fetch>> | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (exitError) throw exitError;
    if (exitCode !== undefined) throw new Error(`Caddy exited before readiness: ${exitCode}`);
    try { php = await fetch("/"); break; } catch (error) {
      if (!String(error).includes("No in-kernel listener")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.equal(php?.status, 200, "Caddy did not serve PHP");
  assert.equal(decoder.decode(php!.body), "CADDY PHP GET|/index.php");
  const staticAsset = await fetch("/robots.txt");
  assert.equal(staticAsset.status, 200);
  assert.equal(decoder.decode(staticAsset.body), "CADDY STATIC\n");
  const opcache = await fetch("/opcache.php");
  assert.equal(opcache.status, 200);
  assert.deepEqual(JSON.parse(decoder.decode(opcache.body)), {
    loaded: true, fileCacheOnly: true, compiled: true, cacheFilePresent: true,
  });
  const gcBefore = countGoCollections(stderr);
  const lifetime = await verifyRequestStringLifetimes(host);
  const gcAfter = countGoCollections(stderr);
  assert.ok(gcAfter > gcBefore, `No collection during requests: ${gcBefore} -> ${gcAfter}`);
  await host.signalProcess(serverPid, 15);
  assert.equal(await withDeadline(serverExit, 30_000, "Caddy shutdown timeout"), 0);
  stopped = true;
  assert.deepEqual(diagnostics, []);
  assert.doesNotMatch(stderr, /panic:|fatal error:|PHP Fatal error/);
  console.log(JSON.stringify({ ...lifetime, gcBefore, gcAfter, exitCode, stderr, diagnostics }));
} catch (error) {
  console.error("server stderr", stderr, "diagnostics", diagnostics);
  throw error;
} finally {
  try {
    if (!stopped && serverPid !== 0) {
      await host.signalProcess(serverPid, 15).catch(() => {});
      if (serverExit) {
        await withDeadline(serverExit, 30_000, "Caddy cleanup timeout").catch(() => {});
      }
    }
  } finally { await host.destroy(); }
}
