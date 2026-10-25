import { installImageSessions } from "./image-session-files";
import { writeTrackedDemoConfig } from "./tracked-demo-config";
import { EXPERIMENTAL_TERMINAL_SESSION_PATH } from "../../../web-libs/kandelo-session/src/experimental-terminal-session";
/**
 * Build a fully-bootable VFS image for the Redis demo. dinit, the first user process,
 * brings up redis-server on port 6379 and a PHP voting board on port 8080.
 *
 * Produces: apps/browser-demos/public/redis-vfs.vfs.zst, or the path given as
 * the first argument (a resolver build passes one under its work root).
 *
 * Usage: npx tsx images/vfs/scripts/build-redis-vfs-image.ts [output]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  exactVfsImageMetadata,
  saveImage,
  type ExactVfsImageAbi,
} from "./vfs-image-helpers";
import {
  addDinitInit,
  type DinitBinaryInputs,
} from "./dinit-image-helpers";

export interface RedisVfsImageBuildInputs {
  redis: Uint8Array;
  redisCli?: Uint8Array;
  php: Uint8Array;
  phar: Uint8Array;
  phpCacheAdminSource: string;
  dinit?: DinitBinaryInputs;
  services?: Uint8Array;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

function installAdminTree(fs: KandeloImageFs, source: string, destination: string): void {
  ensureDirRecursive(fs, destination);
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const from = join(source, entry.name);
    const to = `${destination}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected phpCacheAdmin symlink: ${from}`);
    if (entry.isDirectory()) installAdminTree(fs, from, to);
    else if (entry.isFile()) writeVfsBinary(fs, to, new Uint8Array(readFileSync(from)), 0o644);
    else throw new Error(`Unexpected phpCacheAdmin source entry: ${from}`);
  }
}

export async function buildRedisVfsImage(
  inputs: RedisVfsImageBuildInputs,
): Promise<void> {
  const fs = KandeloImageFs.create();
  // The declared capacity the product's publication gate checks the artifact
  // against. It was the SharedArrayBuffer's `maxByteLength`; the buffer itself
  // was never anything but the old constructor's first argument.
  fs.setImageCapacity(128 * 1024 * 1024);

  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var", "/data"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/data", 0o777);
  ensureDirRecursive(fs, "/usr/local/bin");

  writeVfsBinary(fs, "/usr/local/bin/redis-server", inputs.redis);
  writeVfsBinary(fs, "/usr/local/bin/php", inputs.php);
  ensureDirRecursive(fs, "/usr/lib/php");
  writeVfsBinary(fs, "/usr/lib/php/phar.so", inputs.phar);
  ensureDirRecursive(fs, "/var/www/redis-board");
  for (const name of ["router.php", "index.html"]) {
    writeVfsFile(fs, `/var/www/redis-board/${name}`, readFileSync(join(
      findRepoRoot(), "packages/registry/redis-vfs/app", name,
    ), "utf8"));
  }
  const adminPath = "/var/www/redis-board/admin";
  // Install only upstream runtime files. Tests, development tooling and the
  // remote PHP-server endpoint are not part of this Redis-only application.
  for (const name of ["assets", "src", "templates"]) {
    installAdminTree(fs, join(inputs.phpCacheAdminSource, name), `${adminPath}/${name}`);
  }
  for (const name of ["index.php", "config.dist.php", "predis.phar", "twig.phar", "LICENSE", "README.md"]) {
    writeVfsBinary(fs, `${adminPath}/${name}`, new Uint8Array(readFileSync(join(inputs.phpCacheAdminSource, name))), 0o644);
  }
  writeVfsFile(fs, `${adminPath}/config.php`, readFileSync(join(
    findRepoRoot(), "packages/registry/redis-vfs/app/admin-config.php",
  ), "utf8"));
  ensureDirRecursive(fs, "/usr/share/licenses/phpcacheadmin");
  writeVfsFile(fs, "/usr/share/licenses/phpcacheadmin/THIRD-PARTY-NOTICES.txt", readFileSync(join(
    findRepoRoot(), "packages/registry/redis-vfs/app/THIRD-PARTY-NOTICES.txt",
  ), "utf8"));

  if (inputs.redisCli) {
    writeVfsBinary(fs, "/usr/local/bin/redis-cli", inputs.redisCli);
    ensureDirRecursive(fs, "/etc/kandelo");
    writeVfsBinary(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH, new TextEncoder().encode(JSON.stringify({
      kind: "kandelo-experimental-terminal-session", version: 1,
      initial: { path: "/usr/local/bin/redis-cli", argv: ["redis-cli"], uid: 1000, gid: 1000 },
    })), 0o644);
    writeTrackedDemoConfig(fs, "packages/registry/redis-vfs/redis-demo.json");
    installImageSessions(fs, "redis-vfs");
  }

  // dinit + service tree.
  // Persistence disabled (--save "" --appendonly no) since the in-kernel
  // VFS doesn't survive page reload anyway. --io-threads 1 keeps the
  // process count manageable for the browser's worker budget.
  addDinitInit(fs, [
    {
      name: "redis",
      type: "process",
      command:
        // This temporary service is shared over explicitly joined Kandelo
        // virtual networks; it has no physical-network listening socket.
        "/usr/local/bin/redis-server --port 6379 --bind 0.0.0.0 --protected-mode no " +
        "--save \"\" --appendonly no --io-threads 1 --dir /data",
      restart: true,
      restartDelay: 2,
    },
    {
      name: "redis-board",
      type: "process",
      command: "/usr/local/bin/php -n -d extension=/usr/lib/php/phar.so -d session.save_path=/tmp -S 0.0.0.0:8080 -t /var/www/redis-board /var/www/redis-board/router.php",
      dependsOn: ["redis"],
      logfile: "/var/log/redis-board.log",
      restart: false,
    },
  ], { binaries: inputs.dinit, services: inputs.services });

  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-redis-vfs-image.ts",
        ),
      });
}

async function main(): Promise<void> {
  const repositoryRoot = findRepoRoot();
  const redisRoot = process.env.WASM_POSIX_DEP_REDIS_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  const phpRoot = process.env.WASM_POSIX_DEP_PHP_DIR;
  await buildRedisVfsImage({
    redis: new Uint8Array(
      readFileSync(redisRoot ? join(redisRoot, "redis-server.wasm") : resolveBinary("programs/redis/redis-server.wasm")),
    ),
    redisCli: new Uint8Array(readFileSync(redisRoot ? join(redisRoot, "redis-cli.wasm") : resolveBinary("programs/redis/redis-cli.wasm"))),
    php: new Uint8Array(readFileSync(phpRoot ? join(phpRoot, "php.wasm") : resolveBinary("programs/php/php.wasm"))),
    phar: new Uint8Array(readFileSync(phpRoot ? join(phpRoot, "phar.so") : resolveBinary("programs/php/phar.so"))),
    phpCacheAdminSource: process.env.REDIS_PHP_CACHE_ADMIN_SOURCE_DIR
      ?? (() => { throw new Error("Run build-redis-vfs-image.sh to resolve phpCacheAdmin source"); })(),
    // Resolver builds use their immutable dependency roots, even while an
    // older browser projection is still selected in the checkout.
    dinit: dinitRoot === undefined ? undefined : {
      dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
      dinitctl: new Uint8Array(readFileSync(join(dinitRoot, "dinitctl.wasm"))),
    },
    services: new Uint8Array(readFileSync(join(repositoryRoot, "images/rootfs/etc/services"))),
    outputPath: process.argv[2]
      ? resolve(process.argv[2])
      : join(
        repositoryRoot,
        "apps",
        "browser-demos",
        "public",
        "redis-vfs.vfs.zst",
      ),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
