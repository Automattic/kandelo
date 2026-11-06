import { it, expect } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";
import { renderWordPressConfig } from "../../apps/browser-demos/lib/init/wordpress-runtime-config";

it("uses the direct HTTP root for LAN clients and preserves HTTPS preview prefixes", async () => {
  const config = renderWordPressConfig("sqlite", "/configured-preview", "https").replace(/^<\?php/, "");
  const body = config.replace("require_once ABSPATH . 'wp-settings.php';", "echo json_encode([WP_HOME, WP_SITEURL]);");
  expect(body).not.toBe(config);
  for (const [server, expected] of [
    [{ HTTP_HOST: "host:8080" }, "http://host:8080"],
    [{ HTTP_HOST: "internal:8080", HTTP_X_FORWARDED_HOST: "example.test", HTTP_X_FORWARDED_PREFIX: "/computer/test/app" }, "https://example.test/computer/test/app"],
    [{ HTTP_HOST: "internal:8080", HTTP_X_FORWARDED_HOST: "example.test" }, "https://example.test/configured-preview"],
  ] as const) {
    const script = "define('AUTH_KEY', 'public-test-placeholder'); $_SERVER = json_decode(" + JSON.stringify(JSON.stringify(server)) + ", true); " + body;
    const result = await runCentralizedProgram({ programPath: resolveBinary("programs/php/php.wasm"), argv: ["php", "-n", "-r", script], timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([expected, expected]);
  }
}, 120_000);

it("selects independent WordPress data directories through request context while sharing the core", async () => {
  const config = renderWordPressConfig("selectable", "/computer/site", "https").replace(/^<\?php/, "");
  const body = config.replace("require_once ABSPATH . 'wp-settings.php';", "echo json_encode([DB_HOST, defined('DB_DIR') ? DB_DIR : null, WP_CONTENT_DIR, WP_CONTENT_URL]);");
  expect(body).not.toBe(config);
  for (const backend of ["sqlite", "mariadb"]) {
    const server = { KANDELO_WORDPRESS_BACKEND: backend, HTTP_X_FORWARDED_HOST: "example.test", HTTP_X_FORWARDED_PREFIX: "/computer/site" };
    const script = "define('AUTH_KEY', 'public-test-placeholder'); $_SERVER = json_decode(" + JSON.stringify(JSON.stringify(server)) + ", true); " + body;
    const result = await runCentralizedProgram({ programPath: resolveBinary("programs/php/php.wasm"), argv: ["php", "-n", "-r", script], timeout: 30_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      backend === "sqlite" ? "" : "localhost",
      backend === "sqlite" ? "/var/lib/wordpress-sites/sqlite/wp-content/database/" : null,
      `/var/lib/wordpress-sites/${backend}/wp-content`, "https://example.test/computer/site/wp-content",
    ]);
  }
}, 120_000);
