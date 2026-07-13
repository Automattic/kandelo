/**
 * Regression test for #577: getColumnMeta() must return the column's
 * table name. Two halves have to line up, and each fails differently:
 *
 * 1. libsqlite3 must be built with -DSQLITE_ENABLE_COLUMN_METADATA so
 *    sqlite3_column_table_name() actually exists. Without it, PHP still
 *    links (the SDK passes -Wl,--allow-undefined), wasm-ld emits the
 *    symbol as an `env.` import, and worker-main.ts fills it with a
 *    throwing stub — the first getColumnMeta() call kills the PHP
 *    process (host reports the trap; the kernel marks it SIGSEGV).
 * 2. PHP must be compiled with HAVE_SQLITE3_COLUMN_TABLE_NAME defined.
 *    pdo_sqlite_stmt_col_meta() #ifdef-guards the "table" key behind it,
 *    so an undefined macro silently omits the key rather than crashing.
 *
 * The two must move together: defining the macro without the sqlite flag
 * gives the crash in (1), and the sqlite flag without the macro gives the
 * silent omission in (2). Hence the assertions below cover both — a table
 * name is returned AND no unimplemented-import trap occurred.
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
