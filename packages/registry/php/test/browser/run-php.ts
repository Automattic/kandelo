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

interface BinaryFixture {
  bytes: ArrayBuffer;
  mode: number;
}

async function runPhp(
  phpBytes: ArrayBuffer,
  kernelBytes: ArrayBuffer,
  rootfsBytes: ArrayBuffer,
  files: Record<string, string>,
  argv: string[],
  binaryFiles: Record<string, BinaryFixture> = {},
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
  for (const [path, fixture] of Object.entries(binaryFiles)) {
    ensureDirRecursive(memfs, path.slice(0, path.lastIndexOf("/")) || "/");
    writeVfsBinary(memfs, path, new Uint8Array(fixture.bytes), fixture.mode);
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
    const [kernelBytes, rootfsBytes, phpBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(rootfsVfsUrl).then((r) => r.arrayBuffer()),
      fetch("/php-artifacts/php.wasm").then((r) => r.arrayBuffer()),
    ]);

    // Run the dedicated intl/fork contract only for its Playwright case. The
    // server exposes bytes and installation metadata from PHP's declared
    // runtime closure; this browser path does not duplicate the ICU guest path.
    if (new URL(window.location.href).searchParams.has("intl")) {
      const [intlBytes, icuDataBytes, icuContract] = await Promise.all([
        fetch("/php-artifacts/intl.so").then((r) => r.arrayBuffer()),
        fetch("/php-artifacts/icu.dat").then((r) => r.arrayBuffer()),
        fetch("/php-runtime-files/icu.dat").then(async (response) => {
          if (!response.ok) throw new Error(await response.text());
          return await response.json() as {
            artifact: string;
            guestPath: string;
            mode: number;
          };
        }),
      ]);
      const intlResult = await runPhp(
        phpBytes,
        kernelBytes,
        rootfsBytes,
        {},
        ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=intl.so", "-r", `
          $before = Locale::getDisplayLanguage("fr", "en");
          $pid = pcntl_fork();
          if ($pid < 0) { fwrite(STDERR, "fork-failed"); exit(20); }
          if ($pid === 0) {
            $child = Locale::getDisplayLanguage("fr", "en");
            echo "child=" . $child . "\\n";
            exit($child === "French" ? 0 : 21);
          }
          $status = 0;
          $waited = pcntl_waitpid($pid, $status);
          $c = new Collator("en_US");
          $a = ["banana", "apple", "cherry"];
          $c->sort($a);
          echo "parent=" . $before . ":" . implode(",", $a) . "\\n";
          if ($waited !== $pid || !pcntl_wifexited($status) || pcntl_wexitstatus($status) !== 0) {
            fwrite(STDERR, "child-status=" . $status);
            exit(22);
          }
        `],
        {
          "/usr/lib/php/extensions/intl.so": { bytes: intlBytes, mode: 0o755 },
          [icuContract.guestPath]: { bytes: icuDataBytes, mode: icuContract.mode },
        },
      );
      stdoutEl.textContent = intlResult.stdout;
      stderrEl.textContent = intlResult.stderr;
      exitCodeEl.textContent = String(intlResult.exitCode);
      resultsEl.textContent = JSON.stringify({ intlFork: intlResult.stdout.trim() });
      statusEl.textContent = "done";
      return;
    }

    const [zipBytes, curlBytes] = await Promise.all([
      fetch("/php-artifacts/zip.so").then((r) => r.arrayBuffer()),
      fetch("/php-artifacts/curl.so").then((r) => r.arrayBuffer()),
    ]);
    const binaryFiles: Record<string, BinaryFixture> = {
      "/usr/lib/php/extensions/zip.so": { bytes: zipBytes, mode: 0o755 },
      "/usr/lib/php/extensions/curl.so": { bytes: curlBytes, mode: 0o755 },
    };

    const files = {
      "/home/script.php": '<?php echo "Browser File OK\\n"; ?>',
      "/home/ext_test.php":
        '<?php echo json_encode(["mb" => mb_strlen("hello"), "ctype" => ctype_alpha("hello") ? "yes" : "no"]); ?>',
    };

    // Test 1: Hello World (inline)
    const r1 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", 'echo "Hello World\n";'], binaryFiles);

    // Test 2: File-based execution
    const r2 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "/home/script.php"], binaryFiles);

    // Test 3: Extensions (mbstring + ctype)
    const r3 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "/home/ext_test.php"], binaryFiles);

    // Test 4: Session
    const r4 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", 'session_start(); echo strlen(session_id()) > 0 ? "session-ok" : "fail";'], binaryFiles);

    // Test 5: SQLite3 in-memory
    const r5 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", '$db=new SQLite3(":memory:");$db->exec("CREATE TABLE t(v TEXT)");$db->exec("INSERT INTO t VALUES(\'sqlite-ok\')");echo $db->querySingle("SELECT v FROM t");'], binaryFiles);

    // Test 6: fileinfo
    const r6 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", '$f=new finfo(FILEINFO_MIME_TYPE);echo $f->buffer("GIF89a");'], binaryFiles);

    // Test 7: SimpleXML
    const r7 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", '$x=new SimpleXMLElement("<r><i>xml-ok</i></r>");echo $x->i;'], binaryFiles);

    // Test 8: rootfs OpenSSL defaults are present and key + CSR generation succeeds.
    const r8 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-r", '$k=openssl_pkey_new();$c=$k?openssl_csr_new(["commonName"=>"kandelo.test"],$k):false;if(!$k||!$c){while($e=openssl_error_string()){fwrite(STDERR,$e."\\n");}exit(1);}echo "openssl-defaults-ok";'], binaryFiles);

    // Test 9: load the packaged zip side module from the kernel-owned VFS and
    // prove that a DEFLATE archive survives close/reopen in the browser host.
    const r9 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=zip.so", "-r",
        '$p="/tmp/browser-zip-smoke.zip";$z=new ZipArchive;if($z->open($p,ZipArchive::CREATE|ZipArchive::OVERWRITE)!==true)exit(10);if(!$z->addFromString("hello.txt","browser-zip-ok"))exit(11);if(!$z->setCompressionName("hello.txt",ZipArchive::CM_DEFLATE))exit(12);if(!$z->close())exit(13);$r=new ZipArchive;if($r->open($p)!==true)exit(14);$s=$r->statName("hello.txt");if($s===false||$s["comp_method"]!==ZipArchive::CM_DEFLATE)exit(15);echo $r->getFromName("hello.txt");$r->close();'], binaryFiles);

    // Test 10: load the packaged curl side module from the same browser VFS
    // path and call into the linked libcurl implementation.
    const r10 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=curl.so", "-r",
        'echo json_encode(["loaded"=>extension_loaded("curl"),"version"=>curl_version()["version"],"constant"=>defined("CURLOPT_URL"),"handle"=>is_object(curl_init())]);'], binaryFiles);

    // Test 11: exercise browser TCP with libcurl from a fork child. Loading
    // curl.so before fork also verifies browser-side dlopen replay.
    const r11 = await runPhp(phpBytes, kernelBytes, rootfsBytes, files,
      ["php", "-n", "-d", "extension_dir=/usr/lib/php/extensions", "-d", "extension=curl.so", "-r",
        '$server=stream_socket_server("tcp://127.0.0.1:0",$errno,$error);if($server===false){fwrite(STDERR,"$errno:$error");exit(10);}$address=stream_socket_get_name($server,false);$pid=pcntl_fork();if($pid<0){fwrite(STDERR,"fork failed");exit(11);}if($pid===0){fclose($server);$ch=curl_init("http://$address/probe");curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);curl_setopt($ch,CURLOPT_TIMEOUT,10);$body=curl_exec($ch);if($body===false){fwrite(STDERR,curl_error($ch));exit(12);}echo json_encode(["body"=>$body,"status"=>curl_getinfo($ch,CURLINFO_RESPONSE_CODE)]);exit(0);}$client=stream_socket_accept($server,10);if($client===false){fwrite(STDERR,"accept failed");exit(13);}$request="";while(!str_contains($request,"\\r\\n\\r\\n")){$chunk=fread($client,4096);if($chunk===false||$chunk===""){fwrite(STDERR,"request read failed");exit(14);}$request.=$chunk;}fwrite($client,"HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 16\\r\\nConnection: close\\r\\n\\r\\nkandelo-curl-ok\\n");fclose($client);fclose($server);pcntl_waitpid($pid,$status);if(!pcntl_wifexited($status)||pcntl_wexitstatus($status)!==0)exit(15);'], binaryFiles);

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
