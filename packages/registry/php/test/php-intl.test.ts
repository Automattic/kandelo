import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

// intl is a RUNTIME-OPTIONAL side module: base php.wasm is built with
// --enable-intl=shared, so intl is NOT compiled in. intl.so is loaded on
// demand via `extension=intl.so`, and pulls its ICU common data from the
// separate icu.dat at runtime (udata_setCommonData in intl-icu-data-loader.c).
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(__dirname, "../php-src/sapi/cli/php");
const intlSoPath = tryResolveBinary("programs/php/intl.so");

// icu.dat remains owned by the ICU library package, not copied into PHP's
// program outputs. CI/manual callers can name the exact resolved file; the
// cache fallback is restricted to this checkout's ICU version and revision so
// an unrelated newer ICU build cannot silently satisfy the test.
function findIcuDat(): string | undefined {
  const explicit = process.env.PHP_INTL_ICU_DATA;
  if (explicit !== undefined) {
    if (!existsSync(explicit) || !statSync(explicit).isFile()) {
      throw new Error(`PHP_INTL_ICU_DATA is not a regular file: ${explicit}`);
    }
    return explicit;
  }

  const icuDir = join(__dirname, "../../icu");
  const version = readFileSync(join(icuDir, "package.toml"), "utf8")
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const revision = readFileSync(join(icuDir, "build.toml"), "utf8")
    .match(/^revision\s*=\s*(\d+)/m)?.[1];
  if (!version || !revision) return undefined;

  const libsDir = join(homedir(), ".cache/kandelo/libs");
  if (!existsSync(libsDir)) return undefined;
  const expectedPrefix = `icu-${version}-rev${revision}-wasm32-`;
  const candidates = readdirSync(libsDir)
    .filter((n) => n.startsWith(expectedPrefix) && !n.includes(".tmp-"))
    .map((n) => join(libsDir, n, "share", "icu.dat"))
    .filter((p) => existsSync(p));
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
const icuDatPath = findIcuDat();

const READY = existsSync(phpBinaryPath) && intlSoPath != null && icuDatPath != null;

describe.skipIf(!READY)("PHP intl as a runtime-loadable side module", () => {
  // Proves the base binary is genuinely ICU-free / intl-free: intl only
  // appears when explicitly loaded. This is the whole point of the design.
  it("base php.wasm does NOT include intl", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-m"],
      // Same host-I/O adapter as the other cases: `php -m` needs no files,
      // but it keeps the harness off the "default" rootfs.vfs image (not a
      // fixture this package ships) so the run stays self-contained.
      io: new NodePlatformIO(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("intl");
  }, 60_000);

  it("loads intl.so at runtime via extension=", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${intlSoPath}`, "-r",
        'echo extension_loaded("intl") ? "intl-loaded" : "intl-missing";'],
      env: [`KANDELO_ICU_DAT_PATH=${icuDatPath}`],
      io: new NodePlatformIO(),
    });
    expect(stdout).toContain("intl-loaded");
    expect(exitCode).toBe(0);
  }, 60_000);

  // Exercises real ICU data (locale display names) to prove icu.dat is
  // actually loaded and usable, not just that the module registered.
  it("intl uses ICU data (Locale::getDisplayLanguage)", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${intlSoPath}`, "-r",
        'echo Locale::getDisplayLanguage("fr", "en");'],
      env: [`KANDELO_ICU_DAT_PATH=${icuDatPath}`],
      io: new NodePlatformIO(),
    });
    expect(stdout).toContain("French");
    expect(exitCode).toBe(0);
  }, 60_000);

  // Collator sorting is a core ICU service that requires collation data.
  it("intl Collator sorts with locale rules", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${intlSoPath}`, "-r", `
        $c = new Collator("en_US");
        $a = ["banana", "apple", "cherry"];
        $c->sort($a);
        echo implode(",", $a);
      `],
      env: [`KANDELO_ICU_DAT_PATH=${icuDatPath}`],
      io: new NodePlatformIO(),
    });
    expect(stdout).toContain("apple,banana,cherry");
    expect(exitCode).toBe(0);
  }, 60_000);
});
