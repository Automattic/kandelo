/**
 * WordPress boot test — verifies that WordPress can load and run
 * on wasm-posix-kernel via PHP-Wasm with SQLite.
 *
 * Uses PHP script files instead of -r inline code because PHP variable
 * interpolation ($) conflicts with template literal escaping.
 *
 * Requires:
 *   1. PHP binary: examples/libs/php/php-src/sapi/cli/php
 *      (build with: cd examples/libs/php && bash build.sh)
 *   2. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const wpDir = join(__dirname, "../wordpress");
const dbPath = join(wpDir, "wp-content/database/wordpress.db");

const PHP_AVAILABLE = existsSync(phpBinaryPath);
const WP_AVAILABLE = existsSync(join(wpDir, "wp-settings.php"));

const SKIP_REASON = !PHP_AVAILABLE
  ? "PHP binary not built"
  : !WP_AVAILABLE
    ? "WordPress not downloaded (run examples/wordpress/setup.sh)"
    : "";

// Helper: write a PHP script file, run it, clean up
function writeTempScript(name: string, content: string): string {
  const path = join(wpDir, name);
  writeFileSync(path, content);
  return path;
}

const tempScripts: string[] = [];

afterAll(() => {
  for (const p of tempScripts) {
    try { unlinkSync(p); } catch {}
  }
});

describe.skipIf(!!SKIP_REASON)("WordPress on wasm-posix-kernel", () => {
  it("PHP can parse wp-settings.php without syntax errors", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-l", join(wpDir, "wp-settings.php")],
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
    tempScripts.push(script);

    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", script],
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      timeout: 30_000,
    });

    if (exitCode !== 0) {
      console.log("STDOUT:", stdout);
      console.log("STDERR:", stderr);
    }

    expect(stdout).toContain("BOOT_OK");
    expect(stdout).toContain("WP_VERSION=6.");
    expect(stdout).toContain("WPDB=WP_SQLite_DB");
    expect(stdout).toContain("DB_QUERY=42");
    expect(exitCode).toBe(0);
  }, 60_000);
});
