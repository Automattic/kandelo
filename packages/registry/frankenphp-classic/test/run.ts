import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host.ts";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs.ts";

const [programPath, kernelPath] = process.argv.slice(2);
if (!programPath || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <frankenphp-classic.wasm> <kernel.wasm>");
}

const image = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
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
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
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
  console.log(JSON.stringify({ php, staticAsset, stderr, diagnostics }));
  if (php.status !== 200 || !new TextDecoder().decode(php.body).includes("GET|/welcome?x=1|/index.php") ||
      staticAsset.status !== 200 || new TextDecoder().decode(staticAsset.body) !== "static asset\n" ||
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
