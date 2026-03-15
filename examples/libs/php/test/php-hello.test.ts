import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WasmPosixKernel } from "../../../../host/src/kernel";
import { ProgramRunner } from "../../../../host/src/program-runner";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");

const kernelWasm = readFileSync(join(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
const phpWasm = readFileSync(join(__dirname, "../php-src/sapi/cli/php"));

async function runPhp(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = "";
    let stderr = "";
    const io = new NodePlatformIO();

    const kernel = new WasmPosixKernel(
        { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
        io,
        {
            onStdout: (data: Uint8Array) => {
                stdout += new TextDecoder().decode(data);
            },
            onStderr: (data: Uint8Array) => {
                stderr += new TextDecoder().decode(data);
            },
        },
    );

    await kernel.init(kernelWasm);

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(phpWasm, { argv });

    if (exitCode !== 0) {
        console.log("STDOUT:", stdout);
        console.log("STDERR:", stderr);
    }

    return { stdout, stderr, exitCode };
}

describe("PHP CLI on wasm-posix-kernel", () => {
    it("runs 'echo Hello World' via php -r", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r", 'echo "Hello World\n";']);
        expect(stdout).toContain("Hello World");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe("PHP session + SQLite on wasm-posix-kernel", () => {
    it("session works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";']);
        expect(stdout).toContain("session-ok");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("SQLite3 works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r", `
            $db = new SQLite3(":memory:");
            $db->exec("CREATE TABLE t(id INTEGER, name TEXT)");
            $db->exec("INSERT INTO t VALUES(1, 'hello')");
            $r = $db->querySingle("SELECT name FROM t WHERE id=1");
            echo $r;
        `]);
        expect(stdout).toContain("hello");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("PDO SQLite works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r", `
            $pdo = new PDO("sqlite::memory:");
            $pdo->exec("CREATE TABLE t(v TEXT)");
            $pdo->exec("INSERT INTO t VALUES('pdo-ok')");
            echo $pdo->query("SELECT v FROM t")->fetchColumn();
        `]);
        expect(stdout).toContain("pdo-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe("PHP fileinfo + exif on wasm-posix-kernel", () => {
    it("fileinfo works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            '$f = new finfo(FILEINFO_MIME_TYPE); echo $f->buffer("GIF89a");']);
        expect(stdout).toContain("image/gif");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("exif extension loaded", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            'echo extension_loaded("exif") ? "exif-ok" : "fail";']);
        expect(stdout).toContain("exif-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe("PHP zlib + openssl on wasm-posix-kernel", () => {
    it("zlib works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            '$c = gzcompress("hello"); echo gzuncompress($c);']);
        expect(stdout).toContain("hello");
        expect(exitCode).toBe(0);
    }, 60_000);

    it("openssl extension loaded", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            'echo extension_loaded("openssl") ? "openssl-ok" : "fail";']);
        expect(stdout).toContain("openssl-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});

describe("PHP XML extensions on wasm-posix-kernel", () => {
    it("SimpleXML works", async () => {
        const { stdout, exitCode } = await runPhp(["php", "-r",
            '$x = new SimpleXMLElement("<root><item>xml-ok</item></root>"); echo $x->item;']);
        expect(stdout).toContain("xml-ok");
        expect(exitCode).toBe(0);
    }, 60_000);
});
