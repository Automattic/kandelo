/**
 * WordPress boot test — verifies that WordPress can load and run
 * on kandelo via PHP-Wasm with SQLite.
 *
 * Uses PHP script files instead of -r inline code because PHP variable
 * interpolation ($) conflicts with template literal escaping.
 *
 * Requires:
 *   1. PHP binary: packages/registry/php/php-src/sapi/cli/php
 *      (build with: cd packages/registry/php && bash build.sh)
 *   2. WordPress files: packages/registry/wordpress/wordpress/
 *      (download with: bash packages/registry/wordpress/setup.sh)
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(repoRoot, "packages/registry/php/php-src/sapi/cli/php");
const wpDir = join(repoRoot, "packages/registry/wordpress/wordpress");
const dbPath = join(wpDir, "wp-content/database/wordpress.db");
const guestWpDir = "/wordpress";
const requiredWordPressFiles = [
  "wp-settings.php",
  "wp-load.php",
  "wp-config.php",
  "wp-content/db.php",
  "wp-content/database",
  "wp-content/plugins/sqlite-database-integration/load.php",
];

const PHP_AVAILABLE = existsSync(phpBinaryPath);
const missingWordPressFile = requiredWordPressFiles.find(
  (path) => !existsSync(join(wpDir, path)),
);
const WP_AVAILABLE = missingWordPressFile === undefined;

const SKIP_REASON = !PHP_AVAILABLE
  ? "PHP binary not built"
  : !WP_AVAILABLE
    ? `WordPress setup incomplete: missing ${missingWordPressFile} (run packages/registry/wordpress/setup.sh)`
    : "";

// Helper: write a PHP script file, run it, clean up
function writeTempScript(name: string, content: string): { hostPath: string; guestPath: string } {
  const hostPath = join(wpDir, name);
  writeFileSync(hostPath, content);
  return { hostPath, guestPath: posix.join(guestWpDir, name) };
}

function wordpressMounts(): Array<{ mountPoint: string; hostPath: string; readonly: boolean }> {
  return [{ mountPoint: guestWpDir, hostPath: wpDir, readonly: false }];
}

const tempScripts: string[] = [];

afterAll(() => {
  for (const p of tempScripts) {
    try { unlinkSync(p); } catch {}
  }
});

describe.skipIf(!!SKIP_REASON)("WordPress on kandelo", () => {
  it("PHP can parse wp-settings.php without syntax errors", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-l", posix.join(guestWpDir, "wp-settings.php")],
      extraMounts: wordpressMounts(),
      timeout: 30_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No syntax errors");
  }, 60_000);

  it("WordPress boots with SHORTINIT (DB + core)", async () => {
    // Clean previous DB to start fresh
    try { unlinkSync(dbPath); } catch {}

    const script = writeTempScript("_test_shortinit.php", `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
$_SERVER['REQUEST_METHOD'] = 'GET';

define('WP_INSTALLING', true);
define('SHORTINIT', true);

require __DIR__ . '/wp-load.php';

global $wp_version, $wpdb;
echo "WP_VERSION=" . $wp_version . "\\n";
echo "WPDB=" . (isset($wpdb) ? get_class($wpdb) : 'null') . "\\n";

// Verify SQLite is working by running a query
if (isset($wpdb)) {
    $wpdb->query("CREATE TABLE IF NOT EXISTS _wasm_test (id INTEGER PRIMARY KEY)");
    $wpdb->query("INSERT INTO _wasm_test (id) VALUES (42)");
    $result = $wpdb->get_var("SELECT id FROM _wasm_test LIMIT 1");
    echo "DB_QUERY=" . $result . "\\n";
    $wpdb->query("DROP TABLE _wasm_test");
}

echo "BOOT_OK\\n";
`);
    tempScripts.push(script.hostPath);

    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", script.guestPath],
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      extraMounts: wordpressMounts(),
      timeout: 30_000,
    });

    if (exitCode !== 0) {
      console.log("STDOUT:", stdout);
      console.log("STDERR:", stderr);
    }

    expect(stdout).toContain("BOOT_OK");
    expect(stdout).toMatch(/WP_VERSION=\d+\./);
    expect(stdout).toContain("WPDB=WP_SQLite_DB");
    expect(stdout).toContain("DB_QUERY=42");
    expect(exitCode).toBe(0);
  }, 60_000);
});
