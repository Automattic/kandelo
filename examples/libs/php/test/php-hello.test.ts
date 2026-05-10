import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");

// Prefer the package-managed binary (always built against the current ABI).
// Fall back to a freshly built local php-src/sapi/cli/php for development.
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(__dirname, "../php-src/sapi/cli/php");
const PHP_AVAILABLE = existsSync(phpBinaryPath);

describe.skipIf(!PHP_AVAILABLE)("PHP CLI on wasm-posix-kernel", () => {
    it("runs 'echo Hello World' via php -r", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo "Hello World\n";'],
        });
        expect(stdout).toContain("Hello World");
        expect(exitCode).toBe(0);
    }, 60_000);

    const tmpDir = join(__dirname, ".tmp");

    afterAll(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("runs a PHP script from a file", async () => {
        mkdirSync(tmpDir, { recursive: true });
        const scriptPath = join(tmpDir, "test.php");
        writeFileSync(scriptPath, '<?php echo "File Script OK\\n"; ?>');

        // The script lives at a real host path (under examples/libs/php/...),
        // which the new mount-based default VFS doesn't expose. Opt out
        // with raw NodePlatformIO so PHP can read it. (Migration: ship
        // the fixture into the rootfs image, or use the kernel's exec
        // path which serves wasm bytes from the host.)
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", scriptPath],
            io: new NodePlatformIO(),
        });
        expect(stdout).toContain("File Script OK");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP extensions on wasm-posix-kernel", () => {
    it("mbstring works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo mb_strlen("hello");'],
        });
        expect(stdout).toContain("5");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("ctype works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo ctype_alpha("hello") ? "yes" : "no";'],
        });
        expect(stdout).toContain("yes");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("tokenizer works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo count(token_get_all("<?php echo 1; ?>"));'],
        });
        expect(stdout).toMatch(/\d+/);
        expect(exitCode).toBe(0);
    }, 60_000);

    it("filter works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo filter_var("test@example.com", FILTER_VALIDATE_EMAIL);'],
        });
        expect(stdout).toContain("test@example.com");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("json works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo json_encode(["a" => 1]);'],
        });
        expect(stdout).toContain('{"a":1}');
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP session + SQLite on wasm-posix-kernel", () => {
    it("session works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";'],
        });
        expect(stdout).toContain("session-ok");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("SQLite3 works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", `
            $db = new SQLite3(":memory:");
            $db->exec("CREATE TABLE t(id INTEGER, name TEXT)");
            $db->exec("INSERT INTO t VALUES(1, 'hello')");
            $r = $db->querySingle("SELECT name FROM t WHERE id=1");
            echo $r;
        `],
        });
        expect(stdout).toContain("hello");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("PDO SQLite works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", `
            $pdo = new PDO("sqlite::memory:");
            $pdo->exec("CREATE TABLE t(v TEXT)");
            $pdo->exec("INSERT INTO t VALUES('pdo-ok')");
            echo $pdo->query("SELECT v FROM t")->fetchColumn();
        `],
        });
        expect(stdout).toContain("pdo-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP fileinfo + exif on wasm-posix-kernel", () => {
    it("fileinfo works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                '$f = new finfo(FILEINFO_MIME_TYPE); echo $f->buffer("GIF89a");'],
        });
        expect(stdout).toContain("image/gif");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("exif extension loaded", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                'echo extension_loaded("exif") ? "exif-ok" : "fail";'],
        });
        expect(stdout).toContain("exif-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP zlib + openssl on wasm-posix-kernel", () => {
    it("zlib works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                '$c = gzcompress("hello"); echo gzuncompress($c);'],
        });
        expect(stdout).toContain("hello");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("openssl extension loaded", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                'echo extension_loaded("openssl") ? "openssl-ok" : "fail";'],
        });
        expect(stdout).toContain("openssl-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP XML extensions on wasm-posix-kernel", () => {
    it("SimpleXML works", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r",
                '$x = new SimpleXMLElement("<root><item>xml-ok</item></root>"); echo $x->item;'],
        });
        expect(stdout).toContain("xml-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});
