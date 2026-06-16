/**
 * serve-php.ts — Run the nginx + PHP-FPM service VFS on the Node host.
 *
 * dinit starts PHP-FPM first, then nginx through the dependency graph
 * baked into /etc/dinit.d.
 *
 * Usage:
 *   npx tsx packages/registry/nginx/demo/serve-php.ts [port]
 *
 * Then: curl http://localhost:8080/info.php
 */

import {
  bootDinitServiceVfs,
  finishWhenDinitExits,
  installSignalHandlers,
  removeServiceLogfiles,
  rewriteNginxListenPort,
  trackDinitExit,
  waitForHttp,
} from "../../service-vfs-demo";

async function main() {
  const port = parsePort(process.argv[2] ?? "8080");

  console.log("Booting nginx + PHP-FPM VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/nginx-php-vfs.vfs.zst",
      publicFile: "nginx-php.vfs.zst",
      buildHint: "bash images/vfs/scripts/build-nginx-php-vfs-image.sh",
    },
    target: "nginx",
    maxWorkers: 12,
    maxPages: 4096,
    configure: (fs) => {
      rewriteNginxListenPort(fs, port);
      removeServiceLogfiles(fs, ["php-fpm", "nginx"]);
    },
  });

  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);

  console.log(`Waiting for nginx + PHP-FPM on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/info.php`, 180_000, dinitExited);

  console.log("\nnginx + PHP-FPM running under dinit.");
  console.log(`  Static files: curl http://localhost:${port}/`);
  console.log(`  PHP:          curl http://localhost:${port}/info.php`);
  console.log("\nPress Ctrl+C to stop.");

  await finishWhenDinitExits(host, exitPromise);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
