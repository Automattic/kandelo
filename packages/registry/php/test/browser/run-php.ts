/**
 * Browser test harness — runs PHP CLI via kandelo using
 * BrowserKernel + kernel-owned MemoryFileSystem image (the browser code path).
 *
 * Runs multiple PHP invocations and reports results as JSON in #results.
 */

import { BrowserKernel } from "../../../../../host/src/browser-kernel-host";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";

const stdoutEl = document.getElementById("stdout")!;
const stderrEl = document.getElementById("stderr")!;
const exitCodeEl = document.getElementById("exit-code")!;
const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;

const PHP_PATH = "/usr/local/bin/php";

interface TestResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runPhp(
  phpBytes: ArrayBuffer,
  kernelBytes: ArrayBuffer,
  files: Record<string, string>,
  argv: string[],
): Promise<TestResult> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  const memfs = MemoryFileSystem.create(
    new SharedArrayBuffer(16 * 1024 * 1024, { maxByteLength: 64 * 1024 * 1024 }),
    64 * 1024 * 1024,
  );
  for (const dir of ["/tmp", "/root", "/home", "/dev"]) ensureDir(memfs, dir);
  memfs.chmod("/tmp", 0o777);
  memfs.chmod("/root", 0o700);
  ensureDirRecursive(memfs, "/usr/local/bin");
  writeVfsBinary(memfs, PHP_PATH, new Uint8Array(phpBytes));
  for (const [path, content] of Object.entries(files)) {
    writeVfsFile(memfs, path, content);
  }
  const vfsImage = await memfs.saveImage();

  const kernel = new BrowserKernel({
    kernelOwnedFs: true,
    maxWorkers: 1,
    onStdout: (data) => { stdout += decoder.decode(data); },
    onStderr: (data) => { stderr += decoder.decode(data); },
  });
  const { exit } = await kernel.boot({
    kernelWasm: kernelBytes,
    vfsImage,
    argv: [PHP_PATH, ...argv.slice(1)],
    env: [
      "HOME=/root",
      "TMPDIR=/tmp",
      "TERM=xterm-256color",
      "USER=root",
      "LOGNAME=root",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ],
    cwd: "/root",
    uid: 0,
    gid: 0,
  });
  const exitCode = await exit;

  return { stdout, stderr, exitCode };
}

async function main() {
  try {
    const [kernelBytes, phpBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch("/php.wasm").then((r) => r.arrayBuffer()),
    ]);

    const files = {
      "/home/script.php": '<?php echo "Browser File OK\\n"; ?>',
      "/home/ext_test.php":
        '<?php echo json_encode(["mb" => mb_strlen("hello"), "ctype" => ctype_alpha("hello") ? "yes" : "no"]); ?>',
    };

    // Test 1: Hello World (inline)
    const r1 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "-r", 'echo "Hello World\n";']);

    // Test 2: File-based execution
    const r2 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "/home/script.php"]);

    // Test 3: Extensions (mbstring + ctype)
    const r3 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "/home/ext_test.php"]);

    // Test 4: Session
    const r4 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "-r", 'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";']);

    // Test 5: SQLite3 in-memory
    const r5 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "-r", '$db=new SQLite3(":memory:");$db->exec("CREATE TABLE t(v TEXT)");$db->exec("INSERT INTO t VALUES(\'sqlite-ok\')");echo $db->querySingle("SELECT v FROM t");']);

    // Test 6: fileinfo
    const r6 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "-r", '$f=new finfo(FILEINFO_MIME_TYPE);echo $f->buffer("GIF89a");']);

    // Test 7: SimpleXML
    const r7 = await runPhp(phpBytes, kernelBytes, files,
      ["php", "-r", '$x=new SimpleXMLElement("<r><i>xml-ok</i></r>");echo $x->i;']);

    const results = {
      hello: r1.stdout.trim(),
      file: r2.stdout.trim(),
      extensions: r3.stdout.trim(),
      session: r4.stdout.trim(),
      sqlite: r5.stdout.trim(),
      fileinfo: r6.stdout.trim(),
      xml: r7.stdout.trim(),
    };

    stdoutEl.textContent = r1.stdout;
    stderrEl.textContent = [r1.stderr, r2.stderr, r3.stderr, r4.stderr, r5.stderr, r6.stderr, r7.stderr].filter(Boolean).join("\n---\n");
    exitCodeEl.textContent = String(Math.max(r1.exitCode, r2.exitCode, r3.exitCode, r4.exitCode, r5.exitCode, r6.exitCode, r7.exitCode));
    resultsEl.textContent = JSON.stringify(results);
    statusEl.textContent = "done";
  } catch (e) {
    stderrEl.textContent += String(e);
    statusEl.textContent = "error";
  }
}

main();
