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
import rootfsVfsUrl from "@rootfs-vfs?url";

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
  rootfsBytes: ArrayBuffer,
  files: Record<string, string>,
  binaryFiles: Record<string, ArrayBuffer>,
  argv: string[],
): Promise<TestResult> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  const memfs = MemoryFileSystem.fromImage(new Uint8Array(rootfsBytes), {
    maxByteLength: 256 * 1024 * 1024,
  });
  for (const dir of ["/tmp", "/root", "/home", "/dev"]) ensureDir(memfs, dir);
  memfs.chmod("/tmp", 0o777);
  memfs.chmod("/root", 0o700);
  ensureDirRecursive(memfs, "/usr/local/bin");
  writeVfsBinary(memfs, PHP_PATH, new Uint8Array(phpBytes));
  for (const [path, content] of Object.entries(files)) {
    writeVfsFile(memfs, path, content);
  }
  for (const [path, content] of Object.entries(binaryFiles)) {
    const separator = path.lastIndexOf("/");
    if (separator > 0) ensureDirRecursive(memfs, path.slice(0, separator));
    writeVfsBinary(memfs, path, new Uint8Array(content));
  }
  const vfsImage = await memfs.saveImage();

  const kernel = new BrowserKernel({
    kernelOwnedFs: true,
    maxWorkers: 2,
    onStdout: (data) => { stdout += decoder.decode(data); },
    onStderr: (data) => { stderr += decoder.decode(data); },
    onHostDiagnostic: (diagnostic) => {
      stderr += `[host:${diagnostic.source} pid=${diagnostic.pid}${diagnostic.status === undefined ? "" : ` status=${diagnostic.status}`}] ${diagnostic.message}\n`;
    },
  });
  let exitCode: number;
  try {
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
    exitCode = await exit;
  } finally {
    // `exit` is posted before worker teardown completes. Awaiting destroy also
    // drains stdout/stderr messages that are still queued behind that signal.
    await kernel.destroy();
  }

  return { stdout, stderr, exitCode };
}

async function main() {
  try {
    const [kernelBytes, rootfsBytes, phpBytes, zipBytes, curlBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(rootfsVfsUrl).then((r) => r.arrayBuffer()),
      fetch("/php-artifacts/php.wasm").then((r) => r.arrayBuffer()),
      fetch("/php-artifacts/zip.so").then((r) => r.arrayBuffer()),
      fetch("/php-artifacts/curl.so").then((r) => r.arrayBuffer()),
    ]);

    const files = {
      "/home/script.php": '<?php echo "Browser File OK\\n"; ?>',
      "/home/ext_test.php":
        '<?php echo json_encode(["mb" => mb_strlen("hello"), "ctype" => ctype_alpha("hello") ? "yes" : "no"]); ?>',
    };
    const binaryFiles = {
      "/usr/lib/php/extensions/zip.so": zipBytes,
      "/usr/lib/php/extensions/curl.so": curlBytes,
    };

    // Test 1: Hello World (inline)
    const r1 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", 'echo "Hello World\n";']);

    // Test 2: File-based execution
    const r2 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "/home/script.php"]);

    // Test 3: Extensions (mbstring + ctype)
    const r3 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "/home/ext_test.php"]);

    // Test 4: Session
    const r4 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", 'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";']);

    // Test 5: SQLite3 in-memory
    const r5 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", '$db=new SQLite3(":memory:");$db->exec("CREATE TABLE t(v TEXT)");$db->exec("INSERT INTO t VALUES(\'sqlite-ok\')");echo $db->querySingle("SELECT v FROM t");']);

    // Test 6: fileinfo
    const r6 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", '$f=new finfo(FILEINFO_MIME_TYPE);echo $f->buffer("GIF89a");']);

    // Test 7: SimpleXML
    const r7 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", '$x=new SimpleXMLElement("<r><i>xml-ok</i></r>");echo $x->i;']);

    // Test 8: rootfs OpenSSL defaults are present and key + CSR generation succeeds.
    const r8 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-r", '$k=openssl_pkey_new();$c=$k?openssl_csr_new(["commonName"=>"kandelo.test"],$k):false;if(!$k||!$c){while($e=openssl_error_string()){fwrite(STDERR,$e."\\n");}exit(1);}echo "openssl-defaults-ok";']);

    // Test 9: load the packaged zip side module from the kernel-owned VFS and
    // prove that a DEFLATE archive survives close/reopen in the browser host.
    const r9 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=zip.so", "-r",
        '$p="/tmp/browser-zip-smoke.zip";$z=new ZipArchive;if($z->open($p,ZipArchive::CREATE|ZipArchive::OVERWRITE)!==true)exit(10);if(!$z->addFromString("hello.txt","browser-zip-ok"))exit(11);if(!$z->setCompressionName("hello.txt",ZipArchive::CM_DEFLATE))exit(12);if(!$z->close())exit(13);$r=new ZipArchive;if($r->open($p)!==true)exit(14);$s=$r->statName("hello.txt");if($s===false||$s["comp_method"]!==ZipArchive::CM_DEFLATE)exit(15);echo $r->getFromName("hello.txt");$r->close();']);

    // Test 10: load the packaged curl side module from the same browser VFS
    // path and call into the linked libcurl implementation. The next test
    // exercises browser TCP; this one isolates the PHP/dlopen side-module
    // contract on the real browser host.
    const r10 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=curl.so", "-r",
        'echo json_encode(["loaded"=>extension_loaded("curl"),"version"=>curl_version()["version"],"constant"=>defined("CURLOPT_URL"),"handle"=>is_object(curl_init())]);']);

    // Test 11: serve one HTTP response on the kernel's loopback network and
    // fetch it with libcurl from a fork child. Loading curl.so before fork
    // also exercises browser-side dlopen replay in the child process.
    const r11 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files, binaryFiles,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=curl.so", "-r",
        '$server=stream_socket_server("tcp://127.0.0.1:0",$errno,$error);if($server===false){fwrite(STDERR,"$errno:$error");exit(10);}$address=stream_socket_get_name($server,false);$pid=pcntl_fork();if($pid<0){fwrite(STDERR,"fork failed");exit(11);}if($pid===0){fclose($server);$ch=curl_init("http://$address/probe");curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);curl_setopt($ch,CURLOPT_TIMEOUT,10);$body=curl_exec($ch);if($body===false){fwrite(STDERR,curl_error($ch));exit(12);}echo json_encode(["body"=>$body,"status"=>curl_getinfo($ch,CURLINFO_RESPONSE_CODE)]);exit(0);}$client=stream_socket_accept($server,10);if($client===false){fwrite(STDERR,"accept failed");exit(13);}$request="";while(!str_contains($request,"\\r\\n\\r\\n")){$chunk=fread($client,4096);if($chunk===false||$chunk===""){fwrite(STDERR,"request read failed");exit(14);}$request.=$chunk;}fwrite($client,"HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 16\\r\\nConnection: close\\r\\n\\r\\nkandelo-curl-ok\\n");fclose($client);fclose($server);pcntl_waitpid($pid,$status);if(!pcntl_wifexited($status)||pcntl_wexitstatus($status)!==0)exit(15);']);

    const results = {
      hello: r1.stdout.trim(),
      file: r2.stdout.trim(),
      extensions: r3.stdout.trim(),
      session: r4.stdout.trim(),
      sqlite: r5.stdout.trim(),
      fileinfo: r6.stdout.trim(),
      xml: r7.stdout.trim(),
      openssl: r8.stdout.trim(),
      zip: r9.stdout.trim(),
      curl: r10.stdout.trim(),
      curlHttp: r11.stdout.trim(),
    };

    stdoutEl.textContent = r1.stdout;
    stderrEl.textContent = [r1.stderr, r2.stderr, r3.stderr, r4.stderr, r5.stderr, r6.stderr, r7.stderr, r8.stderr, r9.stderr, r10.stderr, r11.stderr].filter(Boolean).join("\n---\n");
    exitCodeEl.textContent = String(Math.max(r1.exitCode, r2.exitCode, r3.exitCode, r4.exitCode, r5.exitCode, r6.exitCode, r7.exitCode, r8.exitCode, r9.exitCode, r10.exitCode, r11.exitCode));
    resultsEl.textContent = JSON.stringify(results);
    statusEl.textContent = "done";
  } catch (e) {
    stderrEl.textContent += String(e);
    statusEl.textContent = "error";
  }
}

main();
