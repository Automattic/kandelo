/**
 * serve.ts — Run the Redis service VFS on the Node host.
 *
 * dinit starts redis-server from /etc/dinit.d/redis, matching the
 * browser service demo.
 *
 * Usage:
 *   npx tsx packages/registry/redis/demo/serve.ts [port]
 *
 * Then: redis-cli -p 6379 SET hello world
 */

import {
  bootDinitServiceVfs,
  finishWhenDinitExits,
  installSignalHandlers,
  rewriteDinitServiceCommand,
  trackDinitExit,
  waitForTcp,
} from "../../service-vfs-demo";

async function main() {
  const port = parsePort(process.argv[2] ?? "6379");

  console.log("Booting Redis VFS with dinit...");
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: "programs/redis-vfs.vfs.zst",
      publicFile: "redis.vfs.zst",
      buildHint: "bash images/vfs/scripts/build-redis-vfs-image.sh",
    },
    target: "redis",
    maxWorkers: 8,
    configure: (fs) => {
      rewriteDinitServiceCommand(fs, "redis", (command) =>
        command.replace(/--port\s+\d+/, `--port ${port}`),
      );
    },
  });

  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);

  console.log(`Waiting for Redis on 127.0.0.1:${port}...`);
  await waitForTcp(port, 120_000, dinitExited);

  console.log("\nRedis running under dinit.");
  console.log(`  redis-cli -p ${port} SET hello world`);
  console.log(`  redis-cli -p ${port} GET hello`);
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
