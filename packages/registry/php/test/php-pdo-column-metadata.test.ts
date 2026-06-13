/**
 * Regression test for #577: pdo_sqlite calls sqlite3_column_table_name()
 * unconditionally from pdo_sqlite_stmt_col_meta(). If libsqlite3 was built
 * without -DSQLITE_ENABLE_COLUMN_METADATA, that symbol is dropped from the
 * static library, the wasm linker emits an env. import, and the kernel
 * worker stubs it with a throwing function — any getColumnMeta() call
 * kills the worker on the first row read.
 *
 * Skipped if the PHP CLI binary is not present.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(__dirname, "../php-src/sapi/cli/php");
const PHP_AVAILABLE = existsSync(phpBinaryPath);

describe.skipIf(!PHP_AVAILABLE)("PHP PDO sqlite column metadata", () => {
    it("PDOStatement::getColumnMeta returns table name without trapping", async () => {
        const phpScript = `
$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE t (c INTEGER)');
$pdo->exec('INSERT INTO t VALUES (1)');
$stmt = $pdo->query('SELECT c FROM t');
$meta = $stmt->getColumnMeta(0);
echo "name=", $meta['name'], "\\n";
echo "table=", $meta['table'], "\\n";
`;

        const result = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", phpScript],
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("name=c");
        expect(result.stdout).toContain("table=t");
        expect(result.stderr).not.toContain("Unimplemented import");
        expect(result.stderr).not.toContain("sqlite3_column_table_name");
    }, 60_000);
});
