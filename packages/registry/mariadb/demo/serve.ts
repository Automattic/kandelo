/**
 * serve.ts — Run the MariaDB service VFS on the Node host.
 *
 * The VFS image contains dinit plus both Aria and InnoDB service trees.
 * dinit runs the selected bootstrap service and then starts mariadbd.
 *
 * Usage:
 *   npx tsx packages/registry/mariadb/demo/serve.ts
 *   npx tsx packages/registry/mariadb/demo/serve.ts --innodb
 *   npx tsx packages/registry/mariadb/demo/serve.ts --wasm64
 *
 * Then: mysql -h 127.0.0.1 -P 3306 -u root
 */

import {
  bootDinitServiceVfs,
  finishWhenDinitExits,
  installSignalHandlers,
  trackDinitExit,
  waitForTcp,
} from "../../service-vfs-demo";

const useWasm64 = process.argv.includes("--wasm64");
const useInnoDB = process.argv.includes("--innodb");
const unsupported = process.argv.find((arg) => arg === "--bootstrap" || arg === "--debug-help");

async function main() {
  if (unsupported) {
    throw new Error(`${unsupported} is not supported by the VFS-backed service demo; dinit runs bootstrap automatically.`);
  }

  const target = useInnoDB ? "innodb-mariadb" : "aria-mariadb";
  console.log(`Booting MariaDB VFS with dinit (${useInnoDB ? "InnoDB" : "Aria"}, ${useWasm64 ? "wasm64" : "wasm32"})...`);
  const { host, exitPromise } = await bootDinitServiceVfs({
    image: {
      relPath: useWasm64
        ? "programs/wasm64/mariadb-vfs.vfs.zst"
        : "programs/mariadb-vfs.vfs.zst",
      publicFile: useWasm64 ? "mariadb-64.vfs.zst" : "mariadb.vfs.zst",
      buildHint: useWasm64
        ? "bash images/vfs/scripts/build-mariadb-vfs-image.sh --wasm64"
        : "bash images/vfs/scripts/build-mariadb-vfs-image.sh",
    },
    target,
    maxWorkers: 12,
  });

  installSignalHandlers(host);
  const dinitExited = trackDinitExit(exitPromise);

  console.log("Waiting for MariaDB on 127.0.0.1:3306...");
  await waitForTcp(3306, 180_000, dinitExited);

  console.log("\nMariaDB running under dinit.");
  console.log("  Connect with: mysql -h 127.0.0.1 -P 3306 -u root");
  console.log("\nPress Ctrl+C to stop.");

  await finishWhenDinitExits(host, exitPromise);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
