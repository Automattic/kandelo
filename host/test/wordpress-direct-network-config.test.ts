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
