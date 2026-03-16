/**
 * php-concurrent-sqlite.test.ts — Tests concurrent SQLite access from
 * multiple PHP-Wasm processes sharing a SharedLockTable.
 *
 * Requires the PHP wasm binary at ../php-src/sapi/cli/php.
 * Skipped if the binary is not present.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WasmPosixKernel } from "../../../../host/src/kernel";
import { ProgramRunner } from "../../../../host/src/program-runner";
import { NodePlatformIO } from "../../../../host/src/platform/node";
import { SharedLockTable } from "../../../../host/src/shared-lock-table";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const phpBinaryPath = join(__dirname, "../php-src/sapi/cli/php");
const kernelWasmPath = join(repoRoot, "host/wasm/wasm_posix_kernel.wasm");

const PHP_AVAILABLE = existsSync(phpBinaryPath) && existsSync(kernelWasmPath);

async function runPhpWithLockTable(
    argv: string[],
    lockTable: SharedLockTable,
    pid: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = "";
    let stderr = "";
    const io = new NodePlatformIO();

    const kernel = new WasmPosixKernel(
        { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
        io,
        {
            onStdout: (data: Uint8Array) => {
                stdout += new TextDecoder().decode(data);
            },
            onStderr: (data: Uint8Array) => {
                stderr += new TextDecoder().decode(data);
            },
        },
    );

    const kernelWasm = readFileSync(kernelWasmPath);
    await kernel.init(kernelWasm);
    kernel.registerSharedLockTable(lockTable.getBuffer());

    const phpWasm = readFileSync(phpBinaryPath);
    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(phpWasm, { argv });

    return { stdout, stderr, exitCode };
}

describe.skipIf(!PHP_AVAILABLE)("PHP concurrent SQLite access", () => {
    it("two PHP processes safely insert rows with proper locking", async () => {
        const lockTable = SharedLockTable.create();

        const phpScript = `
$db = new PDO('sqlite:/tmp/concurrent_test.db');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)');
for ($i = 0; $i < 10; $i++) {
    $db->exec('BEGIN IMMEDIATE');
    $db->exec("INSERT INTO t(val) VALUES('row')");
    $db->exec('COMMIT');
}
$count = $db->query('SELECT COUNT(*) FROM t')->fetchColumn();
echo "count=$count\\n";
`;

        // Run two PHP processes sequentially (same thread) but sharing a lock table.
        // True multi-worker concurrent test requires worker thread infrastructure.
        const result1 = await runPhpWithLockTable(
            ["php", "-r", phpScript],
            lockTable,
            1,
        );
        expect(result1.exitCode).toBe(0);
        expect(result1.stdout).toContain("count=10");

        const result2 = await runPhpWithLockTable(
            ["php", "-r", phpScript],
            lockTable,
            2,
        );
        expect(result2.exitCode).toBe(0);
        // Second process adds 10 more rows to the 10 from first process
        expect(result2.stdout).toContain("count=20");
    }, 120_000);
});
