/**
 * serve.ts — Run nginx.wasm serving static files on the kernel.
 *
 * Starts nginx with master_process on and 2 worker processes.
 * The master (pid 1) forks 2 workers that handle connections.
 *
 * Uses NodeKernelHost which runs the kernel in a dedicated worker_thread
 * for optimal syscall throughput. TCP bridging is automatic.
 *
 * Usage:
 *   npx tsx examples/nginx/serve.ts
 *
 * Then: curl http://localhost:8080/
 */

import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { tryResolveBinary } from "../../host/src/binary-resolver";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

// Set up filesystem layout for nginx
const prefix = resolve(scriptDir);
const tmpDir = "/tmp/nginx-wasm";

// Create temp directories nginx needs
for (const dir of ["client_body_temp", "proxy_temp", "fastcgi_temp"]) {
    mkdirSync(join(tmpDir, dir), { recursive: true });
}
mkdirSync(join(tmpDir, "logs"), { recursive: true });

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const nginxWasm = tryResolveBinary("programs/nginx.wasm");
    if (!nginxWasm) {
        console.error(
            "nginx.wasm not found. Run: scripts/fetch-binaries.sh " +
            "(or bash examples/nginx/build.sh to build locally).",
        );
        process.exit(1);
    }

    const nginxBytes = loadBytes(nginxWasm);
    const confPath = resolve(scriptDir, "nginx.conf");

    const host = new NodeKernelHost({
        maxWorkers: 8,
        onStdout: (_pid, data) => process.stdout.write(data),
        onStderr: (_pid, data) => process.stderr.write(data),
    });

    await host.init();

    console.log(`Starting nginx multi-worker (prefix=${prefix})...`);
    console.log("  master (pid 1) + 2 worker processes");
    console.log("Listening on http://localhost:8080/");
    console.log("Press Ctrl+C to stop.");

    const exitPromise = host.spawn(nginxBytes, [
        "nginx",
        "-p", prefix + "/",
        "-c", confPath,
    ], {
        env: [
            "HOME=/tmp",
            "PATH=/usr/local/bin:/usr/bin:/bin",
        ],
        cwd: prefix,
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
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
