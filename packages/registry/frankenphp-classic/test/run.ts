import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host.ts";
import { countGoCollections, requestLifetimePhp, verifyRequestStringLifetimes, withDeadline } from "../../../../tests/go/frankenphp/request-lifetime.ts";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <frankenphp-classic.wasm> <kernel.wasm>");
}

const image = KandeloImageFs.create();
image.setImageCapacity(2 * 1024 * 1024);
for (const directory of ["/tmp", "/var", "/var/cache", "/var/cache/opcache", "/srv", "/srv/www", "/srv/www/html"]) {
  image.mkdir(directory, 0o755);
}
image.createFileWithOwner(
  "/srv/www/html/index.php",
  0o644,
  0,
  0,
  new TextEncoder().encode(
    "<?php header('X-Kandelo: classic'); echo $_SERVER['REQUEST_METHOD'], '|', $_SERVER['REQUEST_URI'], '|', $_SERVER['SCRIPT_NAME'];",
  ),
);
image.createFileWithOwner(
  "/srv/www/html/robots.txt",
  0o644,
  0,
  0,
  new TextEncoder().encode("static asset\n"),
);
{
  for (const directory of [
    "/etc", "/etc/frankenphp",
  ]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/etc/frankenphp/php.ini", 0o644, 0, 0, new TextEncoder().encode(`[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=64
opcache.file_cache=/var/cache/opcache
opcache.file_cache_only=1
opcache.file_update_protection=0
opcache.validate_timestamps=0
`));
  image.createFileWithOwner("/srv/www/html/__kandelo_opcache_target.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php return 1;"));
  image.createFileWithOwner("/srv/www/html/__kandelo_opcache_probe.php", 0o644, 0, 0,
    new TextEncoder().encode(`<?php
header('Content-Type: application/json');
$configuration = opcache_get_configuration();
$target = __DIR__ . '/__kandelo_opcache_target.php';
$compiled = opcache_compile_file($target);
echo json_encode([
    'loaded' => extension_loaded('Zend OPcache'),
    'fileCacheOnly' => !empty($configuration['directives']['opcache.file_cache_only']),
    'compiled' => $compiled,
    'cacheFilePresent' => count(glob('/var/cache/opcache/*' . $target . '.bin')) > 0,
], JSON_THROW_ON_ERROR);
`));
}

image.createFileWithOwner("/srv/www/html/lifetime.php", 0o644, 0, 0,
  new TextEncoder().encode(requestLifetimePhp));

let stderr = "";
let serverExit: Promise<number> | undefined;
let serverPid = 0;
const diagnostics: unknown[] = [];
let ready: (() => void) | undefined;
const readiness = new Promise<void>((resolve) => {
  ready = resolve;
});
const host = new NodeKernelHost({
  rootfsImage: new Uint8Array(await image.saveImage()),
  maxWorkers: 8,
  onStderr: (_pid, data) => {
    stderr += new TextDecoder().decode(data);
    if (stderr.includes("FrankenPHP classic listening on")) {
      ready?.();
    }
  },
  onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
});

try {
  await host.init(Uint8Array.from(readFileSync(kernelPath)).buffer);
  const exit = host.spawn(readFileSync(programPath), [programPath], {
    env: ["HOME=/tmp", "TMPDIR=/tmp", "FRANKENPHP_NUM_THREADS=3", "PHPRC=/etc/frankenphp", "GOGC=1", "GOMEMLIMIT=32MiB", "GODEBUG=gctrace=1"],
    onStarted: (pid) => { serverPid = pid; },
  });
  serverExit = exit;
  exit.catch(() => {});
  await withDeadline(Promise.race([
    readiness,
    exit.then((code) => { throw new Error(`server exited before readiness: ${code}`); }),
  ]), 60_000, "server readiness timeout");

  const php = await host.fetchInKernel(8080, {
    method: "GET",
    url: "/welcome?x=1",
    headers: { Host: "localhost:8080" },
    body: null,
  }, { timeoutMs: 60_000 });
  console.log("php", php.status, new TextDecoder().decode(php.body));
  const staticAsset = await host.fetchInKernel(8080, {
    method: "GET",
    url: "/robots.txt",
    headers: { Host: "localhost:8080" },
    body: null,
  }, { timeoutMs: 30_000 });
  const opcache = await host.fetchInKernel(8080, {
    method: "GET",
    url: "/__kandelo_opcache_probe.php",
    headers: { Host: "localhost:8080" },
    body: null,
  }, { timeoutMs: 30_000 });
  const opcacheBody = opcache ? new TextDecoder().decode(opcache.body) : undefined;
  const opcacheResult = opcacheBody ? JSON.parse(opcacheBody) as Record<string, unknown> : undefined;
  const gcBefore = countGoCollections(stderr);
  const lifetime = await verifyRequestStringLifetimes(host);
  const gcAfter = countGoCollections(stderr);
  if (gcAfter <= gcBefore) throw new Error(`No collection during requests: ${gcBefore} -> ${gcAfter}`);
  console.log(JSON.stringify({ php, staticAsset, opcache, lifetime, gcBefore, gcAfter, stderr, diagnostics }));
  if (php.status !== 200 || !new TextDecoder().decode(php.body).includes("GET|/welcome?x=1|/index.php") ||
      staticAsset.status !== 200 || new TextDecoder().decode(staticAsset.body) !== "static asset\n" ||
      (opcache?.status !== 200 ||
        opcacheResult?.loaded !== true || opcacheResult?.fileCacheOnly !== true ||
        opcacheResult?.compiled !== true || opcacheResult?.cacheFilePresent !== true) ||
      !stderr.includes("total_threads=3") ||
      diagnostics.length !== 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("server stderr", stderr, "diagnostics", diagnostics);
  throw error;
} finally {
  try {
    if (serverPid !== 0) await host.signalProcess(serverPid, 15);
    if (serverExit) {
      const code = await withDeadline(serverExit, 30_000, "FrankenPHP shutdown timeout");
      if (code !== 0) throw new Error(`FrankenPHP exited with ${code}`);
      console.log("normal service exit", code);
    }
  } finally { await host.destroy(); }
}
