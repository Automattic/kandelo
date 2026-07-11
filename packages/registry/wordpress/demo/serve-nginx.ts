/**
 * serve-nginx.ts — WordPress behind nginx + PHP-FPM on the Node host.
 *
 * Boots the same fully virtualized dinit/nginx/PHP-FPM/WordPress VFS image
 * used by the browser demo. dinit starts wp-config-init, SMTP capture,
 * PHP-FPM, and nginx from /etc/dinit.d.
 *
 * Usage:
 *   npx tsx packages/registry/wordpress/demo/serve-nginx.ts [port]
 */

import {
  bootDinitServiceVfs,
  configureWordPressRuntime,
  finishWhenDinitExits,
  installSignalHandlers,
  trackDinitExit,
  waitForHttp,
} from "../../service-vfs-demo";

async function main() {
  const port = parsePort(process.argv[2] ?? "8080");

  console.log("Booting WordPress VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/wordpress.vfs.zst",
      publicFile: "wordpress.vfs.zst",
      buildHint: "bash images/vfs/scripts/build-wp-vfs-image.sh",
    },
    target: "nginx",
    maxWorkers: 12,
    maxPages: 4096,
    configure: (fs) => configureWordPressRuntime(fs, {
      port,
      freshSqliteDatabase: true,
      phpFpmWorkers: 6,
    }),
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

  console.log(`Waiting for nginx on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/`, 180_000, dinitExited);

  console.log("\nWordPress running behind nginx + php-fpm!");
  console.log(`  Homepage:  curl http://localhost:${port}/`);
  console.log(`  Admin:     http://localhost:${port}/wp-admin/`);
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
