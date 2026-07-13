import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const zipSoPath = tryResolveBinary("programs/php/zip.so");
const ZIP_AVAILABLE = PHP_AVAILABLE && zipSoPath !== null;
const zipExtArgs = ZIP_AVAILABLE
  ? ["-n", "-d", `extension_dir=${dirname(zipSoPath!)}`, "-d", "extension=zip.so"]
  : [];

describe.skipIf(!PHP_AVAILABLE)("PHP CLI on kandelo", () => {
    it("runs 'echo Hello World' via php -r", async () => {
        const { stdout, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'echo "Hello World\n";'],
        });
        expect(stdout).toContain("Hello World");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("writes binary data to stdout", async () => {
        const { stdoutBytes, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", 'fwrite(STDOUT, "A" . chr(0) . "B" . chr(255));'],
        });
        expect(Array.from(stdoutBytes)).toEqual([0x41, 0x00, 0x42, 0xff]);
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

        // The script lives at a real host path (under packages/registry/php/...),
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

describe.skipIf(!PHP_AVAILABLE)("PHP extensions on kandelo", () => {
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

describe.skipIf(!PHP_AVAILABLE)("PHP session + SQLite on kandelo", () => {
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

describe.skipIf(!PHP_AVAILABLE)("PHP fileinfo + exif on kandelo", () => {
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

describe.skipIf(!PHP_AVAILABLE)("PHP zlib + openssl on kandelo", () => {
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

    it("exposes rootfs OpenSSL defaults while key and CSR generation succeeds", async () => {
        const { stdout, stderr, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", "-r", `
                $key = openssl_pkey_new();
                $csr = $key ? openssl_csr_new(["commonName" => "kandelo.test"], $key) : false;
                if (!$key || !$csr) {
                    while ($error = openssl_error_string()) {
                        fwrite(STDERR, $error . "\\n");
                    }
                    exit(1);
                }
                echo "openssl-defaults-ok";
            `],
            timeout: 120_000,
        });
        expect(stderr).toBe("");
        expect(stdout).toContain("openssl-defaults-ok");
        expect(exitCode).toBe(0);
    }, 120_000);
});

describe.skipIf(!PHP_AVAILABLE)("PHP XML extensions on kandelo", () => {
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

describe.skipIf(!ZIP_AVAILABLE)("PHP zip extension on kandelo", () => {
    // The package side module lives at a resolver-owned host path. Opt into
    // NodePlatformIO for this extension-loading test; the browser companion
    // test mounts the same artifact into the kernel-owned VFS.
    it("registers ZipArchive through the packaged side module", async () => {
        const { stdout, stderr, exitCode } = await runCentralizedProgram({
            programPath: phpBinaryPath,
            argv: ["php", ...zipExtArgs, "-r",
                'echo class_exists("ZipArchive") ? "ziparchive-ok" : "missing";'],
            io: new NodePlatformIO(),
        });
        expect(stderr).toBe("");
        expect(stdout).toContain("ziparchive-ok");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("round-trips a DEFLATE entry through ZipArchive", async () => {
        const scratch = mkdtempSync(join(tmpdir(), "kandelo-php-zip-"));
        const archive = join(scratch, "smoke.zip");
        try {
            const { stdout, stderr, exitCode } = await runCentralizedProgram({
                programPath: phpBinaryPath,
                argv: ["php", ...zipExtArgs, "-r", `
                    $z = new ZipArchive;
                    if ($z->open(${JSON.stringify(archive)}, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) { exit(10); }
                    if (!$z->addFromString("hello.txt", "kandelo-zip-ok")) { exit(11); }
                    if (!$z->setCompressionName("hello.txt", ZipArchive::CM_DEFLATE)) { exit(12); }
                    if (!$z->close()) { exit(13); }
                    $r = new ZipArchive;
                    if ($r->open(${JSON.stringify(archive)}) !== true) { exit(14); }
                    $stat = $r->statName("hello.txt");
                    if ($stat === false || $stat["comp_method"] !== ZipArchive::CM_DEFLATE) { exit(15); }
                    echo $r->getFromName("hello.txt");
                    $r->close();
                `],
                io: new NodePlatformIO(),
            });
            expect(stderr).toBe("");
            expect(stdout).toContain("kandelo-zip-ok");
            expect(exitCode).toBe(0);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }, 60_000);
});
