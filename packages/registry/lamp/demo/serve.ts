/**
 * serve.ts — Run the full LAMP service VFS on the Node host.
 *
 * dinit starts MariaDB bootstrap, MariaDB, SMTP capture, PHP-FPM, and
 * nginx from the baked /etc/dinit.d service tree.
 *
 * Usage:
 *   npx tsx packages/registry/lamp/demo/serve.ts [port]
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

  console.log("Booting LAMP VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/lamp.vfs.zst",
      publicFile: "lamp.vfs.zst",
      buildHint: "bash images/vfs/scripts/build-lamp-vfs-image.sh",
    },
    target: "nginx",
    maxWorkers: 16,
    maxPages: 4096,
    configure: (fs) => configureWordPressRuntime(fs, {
      port,
      freshSqliteDatabase: false,
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

  console.log(`Waiting for LAMP stack on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/`, 300_000, dinitExited);

  console.log("\nLAMP stack running under dinit.");
  console.log("  MariaDB:   127.0.0.1:3306");
  console.log("  PHP-FPM:   127.0.0.1:9000");
  console.log(`  nginx:     http://localhost:${port}/`);
  console.log(`  WordPress: http://localhost:${port}/`);
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
