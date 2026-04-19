/**
 * serve.ts — Run redis-server.wasm on the wasm-posix-kernel.
 *
 * Starts Redis 7.2 with 3 background threads (close_file, aof_fsync, lazy_free).
 * The kernel automatically bridges real TCP connections into the
 * kernel's pipe-backed sockets when redis calls listen().
 *
 * Usage:
 *   npx tsx examples/redis/serve.ts [port]
 *
 * Then: redis-cli -p 6379 SET hello world
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const port = process.argv[2] || "6379";

    const redisWasm = resolve(scriptDir, "../libs/redis/bin/redis-server.wasm");
    if (!existsSync(redisWasm)) {
        console.error("redis-server.wasm not found. Run: bash examples/libs/redis/build-redis.sh");
        process.exit(1);
    }

    const redisBytes = loadBytes(redisWasm);

    // Create data directory for Redis persistence
    const dataDir = resolve(scriptDir, "data");
    mkdirSync(dataDir, { recursive: true });

    const host = new NodeKernelHost({
        maxWorkers: 8,
        onStdout: (_pid, data) => process.stdout.write(data),
        onStderr: (_pid, data) => process.stderr.write(data),
    });

    await host.init();

    console.log(`Starting Redis 7.2 on port ${port}...`);
    console.log(`Data directory: ${dataDir}`);
    console.log(`  redis-cli -p ${port} SET hello world`);
    console.log(`  redis-cli -p ${port} GET hello`);
    console.log("Press Ctrl+C to stop.\n");

    const exitPromise = host.spawn(redisBytes, [
        "redis-server",
        "--port", port,
        "--bind", "0.0.0.0",
        "--dir", dataDir,
        "--save", "",         // Disable RDB snapshots
        "--appendonly", "no", // Disable AOF
        "--loglevel", "notice",
        "--daemonize", "no",
        "--databases", "16",
        "--io-threads", "1",  // Single I/O thread
    ], {
        env: [
            "HOME=/tmp",
            "PATH=/usr/local/bin:/usr/bin:/bin",
        ],
        cwd: dataDir,
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
        console.log("\nShutting down Redis...");
        await host.destroy().catch(() => {});
        process.exit(0);
    });

    const status = await exitPromise;
    await host.destroy().catch(() => {});
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
