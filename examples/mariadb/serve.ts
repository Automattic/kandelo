/**
 * serve.ts — Run MariaDB 10.5 (mysqld) on the wasm-posix-kernel.
 *
 * Starts mysqld in single-thread mode with Aria (default) or InnoDB engine.
 * The kernel's PlatformIO layer provides access to the host filesystem
 * for data directory and temp files.
 *
 * Usage:
 *   npx tsx examples/mariadb/serve.ts
 *   npx tsx examples/mariadb/serve.ts --innodb
 *
 * Then: mysql -h 127.0.0.1 -P 3306 -u root
 */

import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

const useWasm64 = process.argv.includes("--wasm64");
const useInnoDB = process.argv.includes("--innodb");
const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");
const installDir = resolve(mariadbLibDir, useWasm64 ? "mariadb-install-64" : "mariadb-install");

// Create data directory on host
const dataDir = resolve(scriptDir, "data");
mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
mkdirSync(resolve(dataDir, "tmp"), { recursive: true });

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const mysqldWasm = resolve(installDir, "bin/mariadbd");
    if (!existsSync(mysqldWasm)) {
        console.error("mariadbd not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
        process.exit(1);
    }

    const mysqldBytes = loadBytes(mysqldWasm);

    // Check if data directory needs bootstrapping
    const mysqlDir = resolve(dataDir, "mysql");
    const needsBootstrap = readdirSync(mysqlDir).length === 0;

    const debugMode = process.argv.includes("--debug-help");
    const bootstrapMode = needsBootstrap || process.argv.includes("--bootstrap");

    const engine = useInnoDB ? "InnoDB" : "Aria";
    const commonArgs = [
        "mariadbd",
        "--no-defaults",
        `--datadir=${dataDir}`,
        `--tmpdir=${resolve(dataDir, "tmp")}`,
        `--default-storage-engine=${engine}`,
        "--skip-grant-tables",
        "--key-buffer-size=1048576",
        "--table-open-cache=10",
        "--sort-buffer-size=262144",
        ...(useInnoDB ? [
            "--innodb-buffer-pool-size=8M",
            "--innodb-log-file-size=4M",
            "--innodb-log-buffer-size=1M",
            "--innodb-flush-log-at-trx-commit=2",
            "--innodb-buffer-pool-load-at-startup=OFF",
            "--innodb-buffer-pool-dump-at-shutdown=OFF",
        ] : []),
    ];

    const serverArgs = debugMode ? [
        "mariadbd",
        "--no-defaults",
        "--help",
        "--verbose",
    ] : bootstrapMode ? [
        ...commonArgs,
        "--bootstrap",
        "--log-warnings=0",
    ] : [
        ...commonArgs,
        "--skip-networking=0",
        "--port=3306",
        "--bind-address=0.0.0.0",
        "--socket=",
        "--max-connections=10",
    ];

    const host = new NodeKernelHost({
        maxWorkers: 8,
        // InnoDB writes log files in 1MB chunks; increase data buffer from 64KB default
        dataBufferSize: useInnoDB ? 2 * 1024 * 1024 : undefined,
        onStdout: (_pid, data) => process.stdout.write(new TextDecoder().decode(data)),
        onStderr: (_pid, data) => process.stderr.write(new TextDecoder().decode(data)),
    });

    await host.init();

    // For bootstrap mode, prepare SQL data for stdin
    let stdinData: Uint8Array | undefined;
    if (bootstrapMode) {
        console.log("Bootstrapping MariaDB system tables...");
        const shareDir = resolve(installDir, "share/mysql");
        const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
        const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
        const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
        stdinData = new TextEncoder().encode(bootstrapSql);
    } else {
        console.log("Starting MariaDB 10.5 on wasm-posix-kernel...");
        console.log(`Data directory: ${dataDir}`);
        console.log("Connect with: mysql -h 127.0.0.1 -P 3306 -u root");
    }
    console.log("");

    const exitPromise = host.spawn(mysqldBytes, serverArgs, {
        env: [
            "HOME=/tmp",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "TMPDIR=/tmp",
        ],
        cwd: dataDir,
        stdin: stdinData,
    });

    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        await host.destroy().catch(() => {});
        process.exit(0);
    });

    let status: number;
    if (bootstrapMode) {
        // Bootstrap mode: after stdin is consumed, mysqld should exit.
        // Background threads may hang during shutdown — race with a timeout.
        const timeoutPromise = new Promise<number>((resolveP) => {
            setTimeout(() => {
                console.log("\nBootstrap appears complete (timeout). Forcing shutdown.");
                resolveP(0);
            }, 60000);
        });
        status = await Promise.race([exitPromise, timeoutPromise]);
    } else {
        status = await exitPromise;
    }

    await host.destroy().catch(() => {});

    if (bootstrapMode && status === 0 && !process.argv.includes("--bootstrap")) {
        console.log("\nBootstrap complete! Restart to run the server.\n");
    }
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
