/**
 * serve.ts — Run the nginx service VFS on the Node host.
 *
 * The image boots dinit as PID 1 and dinit starts nginx from
 * /etc/dinit.d/nginx. This mirrors the browser demo instead of staging
 * nginx manually on the Node host filesystem.
 *
 * Usage:
 *   npx tsx packages/registry/nginx/demo/serve.ts [port]
 *
 * Then: curl http://localhost:8080/
 */

import {
  bootDinitServiceVfs,
  finishWhenDinitExits,
  installSignalHandlers,
  rewriteNginxListenPort,
  trackDinitExit,
  waitForHttp,
} from "../../service-vfs-demo";

async function main() {
  const port = parsePort(process.argv[2] ?? "8080");

  console.log("Booting nginx VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/nginx-vfs.vfs.zst",
      publicFile: "nginx.vfs.zst",
      buildHint: "bash images/vfs/scripts/build-nginx-vfs-image.sh",
    },
    target: "nginx",
    maxWorkers: 8,
    configure: (fs) => rewriteNginxListenPort(fs, port),
  });

  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);

  console.log(`Waiting for nginx on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/`, 120_000, dinitExited);

  console.log("\nnginx running under dinit.");
  console.log(`  Static files: curl http://localhost:${port}/`);
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
