/**
 * Browser test harness — runs PHP CLI via wasm-posix-kernel using
 * VirtualPlatformIO + MemoryFileSystem (the browser code path).
 *
 * Runs multiple PHP invocations and reports results as JSON in #results.
 */

import { WasmPosixKernel, type KernelCallbacks } from "../../../../../host/src/kernel";
import { ProgramRunner } from "../../../../../host/src/program-runner";
import { VirtualPlatformIO } from "../../../../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import { DeviceFileSystem } from "../../../../../host/src/vfs/device-fs";
import { BrowserTimeProvider } from "../../../../../host/src/vfs/time";
import kernelWasmUrl from "../../../../../host/wasm/wasm_posix_kernel.wasm?url";

const stdoutEl = document.getElementById("stdout")!;
const stderrEl = document.getElementById("stderr")!;
const exitCodeEl = document.getElementById("exit-code")!;
const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;

async function runPhp(
  phpBytes: ArrayBuffer,
  kernelBytes: ArrayBuffer,
  memfs: MemoryFileSystem,
  devfs: DeviceFileSystem,
  argv: string[],
): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  const io = new VirtualPlatformIO(
    [
      { mountPoint: "/dev", backend: devfs },
      { mountPoint: "/", backend: memfs },
    ],
    new BrowserTimeProvider(),
  );

  const decoder = new TextDecoder();
  const callbacks: KernelCallbacks = {
    onStdout: (data) => { stdout += decoder.decode(data); },
    onStderr: (data) => { stderrEl.textContent += decoder.decode(data); },
  };

  const kernel = new WasmPosixKernel(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
    io,
    callbacks,
  );

  await kernel.init(kernelBytes);
  const runner = new ProgramRunner(kernel);
  const exitCode = await runner.run(phpBytes, {
    argv,
    env: [
      "HOME=/home",
      "TMPDIR=/tmp",
      "TERM=xterm-256color",
    ],
  });

  return { stdout, exitCode };
}

async function main() {
  try {
    const [kernelBytes, phpBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch("/php.wasm").then((r) => r.arrayBuffer()),
    ]);

    // Set up virtual filesystem (browser path — no Node.js fs)
    const memfs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
    const devfs = new DeviceFileSystem();
    memfs.mkdir("/tmp", 0o777);
    memfs.mkdir("/home", 0o755);
    memfs.mkdir("/dev", 0o755);

    // Test 1: Hello World
    const r1 = await runPhp(phpBytes, kernelBytes, memfs, devfs,
      ["php", "-r", 'echo "Hello World\n";']);

    // Test 2: Session
    const r2 = await runPhp(phpBytes, kernelBytes, memfs, devfs,
      ["php", "-r", 'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";']);

    // Test 3: SQLite3 in-memory
    const r3 = await runPhp(phpBytes, kernelBytes, memfs, devfs,
      ["php", "-r", '$db=new SQLite3(":memory:");$db->exec("CREATE TABLE t(v TEXT)");$db->exec("INSERT INTO t VALUES(\'sqlite-ok\')");echo $db->querySingle("SELECT v FROM t");']);

    // Test 4: fileinfo
    const r4 = await runPhp(phpBytes, kernelBytes, memfs, devfs,
      ["php", "-r", '$f=new finfo(FILEINFO_MIME_TYPE);echo $f->buffer("GIF89a");']);

    // Test 5: SimpleXML
    const r5 = await runPhp(phpBytes, kernelBytes, memfs, devfs,
      ["php", "-r", '$x=new SimpleXMLElement("<r><i>xml-ok</i></r>");echo $x->i;']);

    const results = {
      hello: r1.stdout.trim(),
      session: r2.stdout.trim(),
      sqlite: r3.stdout.trim(),
      fileinfo: r4.stdout.trim(),
      xml: r5.stdout.trim(),
    };

    stdoutEl.textContent = r1.stdout;
    exitCodeEl.textContent = String(r1.exitCode);
    resultsEl.textContent = JSON.stringify(results);
    statusEl.textContent = "done";
  } catch (e) {
    stderrEl.textContent += String(e);
    statusEl.textContent = "error";
  }
}

main();
