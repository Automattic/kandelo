import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs.ts";

const [programPath, kernelPath, opcachePath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <frankenphp-classic.wasm> <kernel.wasm> [opcache-zts.so]");
}

const image = KandeloImageFs.create();
image.setImageCapacity(2 * 1024 * 1024);
for (const directory of ["/tmp", "/var", "/var/www", "/var/www/html"]) {
  image.mkdir(directory, 0o755);
}
image.createFileWithOwner(
  "/var/www/html/index.php",
  0o644,
  0,
  0,
  new TextEncoder().encode(
    "<?php header('X-Kandelo: classic'); echo $_SERVER['REQUEST_METHOD'], '|', $_SERVER['REQUEST_URI'], '|', $_SERVER['SCRIPT_NAME'];",
  ),
);
image.createFileWithOwner(
  "/var/www/html/robots.txt",
  0o644,
  0,
  0,
  new TextEncoder().encode("static asset\n"),
);
if (opcachePath) {
  for (const directory of [
    "/etc", "/etc/frankenphp", "/usr", "/usr/lib", "/usr/lib/php",
    "/usr/lib/php/extensions",
  ]) {
    image.mkdir(directory, 0o755);
  }
  image.createFileWithOwner("/usr/lib/php/extensions/opcache-zts.so", 0o755, 0, 0, readFileSync(opcachePath));
  image.createFileWithOwner("/etc/frankenphp/php.ini", 0o644, 0, 0, new TextEncoder().encode(`zend_extension=/usr/lib/php/extensions/opcache-zts.so
[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=64
opcache.file_update_protection=0
opcache.validate_timestamps=0
`));
  image.createFileWithOwner("/var/www/html/__kandelo_opcache_target.php", 0o644, 0, 0,
    new TextEncoder().encode("<?php return 1;"));
  image.createFileWithOwner("/var/www/html/__kandelo_opcache_probe.php", 0o644, 0, 0,
    new TextEncoder().encode(`<?php
header('Content-Type: application/json');
$status = opcache_get_status(false);
$target = __DIR__ . '/__kandelo_opcache_target.php';
echo json_encode([
    'loaded' => extension_loaded('Zend OPcache'),
    'enabled' => is_array($status) && !empty($status['opcache_enabled']),
    'compiled' => opcache_compile_file($target),
    'cached' => opcache_is_script_cached($target),
], JSON_THROW_ON_ERROR);
`));
}

let stderr = "";
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
    env: ["HOME=/tmp", "TMPDIR=/tmp", "FRANKENPHP_NUM_THREADS=3", ...(opcachePath ? ["PHPRC=/etc/frankenphp"] : [])],
    onStarted: (pid) => { serverPid = pid; },
  });
  exit.catch(() => {});
  await Promise.race([
    readiness,
    exit.then((code) => { throw new Error(`server exited before readiness: ${code}`); }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server readiness timeout")), 60_000)),
  ]);

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
  const opcache = opcachePath ? await host.fetchInKernel(8080, {
    method: "GET",
    url: "/__kandelo_opcache_probe.php",
    headers: { Host: "localhost:8080" },
    body: null,
  }, { timeoutMs: 30_000 }) : undefined;
  const opcacheBody = opcache ? new TextDecoder().decode(opcache.body) : undefined;
  const opcacheResult = opcacheBody ? JSON.parse(opcacheBody) as Record<string, unknown> : undefined;
  console.log(JSON.stringify({ php, staticAsset, opcache, stderr, diagnostics }));
  if (php.status !== 200 || !new TextDecoder().decode(php.body).includes("GET|/welcome?x=1|/index.php") ||
      staticAsset.status !== 200 || new TextDecoder().decode(staticAsset.body) !== "static asset\n" ||
      (opcachePath && (opcache?.status !== 200 ||
        opcacheResult?.loaded !== true || opcacheResult?.enabled !== true ||
        opcacheResult?.compiled !== true || opcacheResult?.cached !== true)) ||
      !stderr.includes("num_threads=3") ||
      diagnostics.length !== 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("server stderr", stderr, "diagnostics", diagnostics);
  throw error;
} finally {
  if (serverPid !== 0) {
    await host.signalProcess(serverPid, 15).catch(() => {});
  }
  await host.destroy();
}
