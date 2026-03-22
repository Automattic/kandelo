/**
 * php-concurrent-sqlite.test.ts — Tests concurrent SQLite access from
 * multiple PHP-Wasm processes sharing a SharedLockTable.
 *
 * Requires the PHP wasm binary at ../php-src/sapi/cli/php,
 * recompiled with channel_syscall.c for centralized mode.
 * Skipped if the binary is not present.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const phpBinaryPath = join(__dirname, "../php-src/sapi/cli/php");
const PHP_AVAILABLE = existsSync(phpBinaryPath);

describe.skipIf(!PHP_AVAILABLE)("PHP concurrent SQLite access", () => {
    it("two PHP processes safely insert rows with proper locking", async () => {
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

        const result1 = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", phpScript],
        });
        expect(result1.exitCode).toBe(0);
        expect(result1.stdout).toContain("count=10");

        const result2 = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", phpScript],
        });
        expect(result2.exitCode).toBe(0);
        expect(result2.stdout).toContain("count=20");
    }, 120_000);
});
