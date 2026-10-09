#!/usr/bin/env node --experimental-strip-types

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { ensureDirRecursive, writeVfsBinary, writeVfsFile } from "../../../../host/src/vfs/image-helpers";
import {
  bootDinitServiceVfs,
  configureWordPressRuntime,
  installSignalHandlers,
  trackDinitExit,
  waitForHttp,
  waitForTcp,
} from "../../service-vfs-demo";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const backendPort = 38080;

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === backendPort) {
    throw new Error(`Invalid RoadRunner port: ${process.argv[2]}`);
  }

  const server = readFileSync(resolve(repoRoot, ".context/roadrunner-minimal.wasm"));
  const php = readFileSync(resolveBinary("programs/wasm32/php/php.wasm"));
  const worker = readFileSync(resolve(here, "roadrunner-worker.php"), "utf8");
  const config = [
    'version: "3"',
    "server:",
    '  command: "/usr/bin/php /etc/roadrunner/wordpress-worker.php"',
    '  relay: "pipes"',
    "http:",
    `  address: "0.0.0.0:${port}"`,
    "  raw_body: true",
    "  pool:",
    "    num_workers: 1",
    "logs:",
    "  level: error",
    "",
  ].join("\n");

  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/wordpress.vfs.zst",
      publicFile: "wordpress.vfs.zst",
      buildHint: "./run.sh build wp-vfs",
    },
    target: "nginx",
    maxWorkers: 20,
    maxPages: 4096,
    onHostDiagnostic: (diagnostic) => console.error("host diagnostic", diagnostic),
    configure: (fs) => {
      configureWordPressRuntime(fs, {
        port: backendPort,
        phpFpmWorkers: 4,
      });
      ensureDirRecursive(fs, "/etc/roadrunner");
      ensureDirRecursive(fs, "/usr/sbin");
      ensureDirRecursive(fs, "/usr/bin");
      writeVfsBinary(fs, "/usr/sbin/roadrunner", new Uint8Array(server));
      writeVfsBinary(fs, "/usr/bin/php", new Uint8Array(php));
      writeVfsFile(fs, "/etc/roadrunner/wordpress-worker.php", worker);
      writeVfsFile(fs, "/etc/roadrunner/wordpress.yaml", config);
    },
    env: [
      "HOME=/root",
      "TERM=xterm-256color",
      "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
      "WP_APP_PATH=/",
      "WP_PROTO=http",
    ],
  });
  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);
  await waitForHttp(`http://127.0.0.1:${backendPort}/`, 180_000, dinitExited);
  const { pid, exit } = await host.spawnFromVfs(
    "/usr/sbin/roadrunner",
    ["/usr/sbin/roadrunner", "/etc/roadrunner/wordpress.yaml"],
    {
      env: ["HOME=/root", "GOMAXPROCS=2", `WP_BACKEND_PORT=${backendPort}`, "PATH=/usr/bin:/bin"],
      cwd: "/",
    },
  );
  let serverExited = false;
  exit.then((status) => {
    serverExited = true;
    console.error(`RoadRunner pid ${pid} exited with status ${status}`);
  });

  const url = `http://127.0.0.1:${port}/`;
  await waitForTcp(port, 180_000, () => dinitExited() || serverExited);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  const body = await response.text();
  if (!response.ok || !/WordPress on Kandelo|Hello world/i.test(body)) {
    throw new Error(`RoadRunner did not serve WordPress: HTTP ${response.status}: ${body.slice(0, 512)}`);
  }
  console.log(`WordPress through RoadRunner proxy to nginx/PHP-FPM is running at ${url}`);
  console.log(`Admin: http://127.0.0.1:${port}/wp-admin/`);

  await Promise.race([exitPromise, exit]);
  await host.destroy();
}

main().catch((error) => {
  console.error("RoadRunner WordPress demo failed:", error);
  process.exit(1);
});
