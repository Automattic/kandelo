import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(__dirname, "../bin/php.wasm");
const curlSoPath =
  tryResolveBinary("programs/php/curl.so") ??
  join(__dirname, "../bin/curl.so");

const READY = existsSync(phpBinaryPath) && existsSync(curlSoPath);
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe.skipIf(!READY)("PHP curl as a runtime-loadable side module", () => {
  it("has a closed main-module import set", () => {
    const mainModule = new WebAssembly.Module(readFileSync(phpBinaryPath));
    const sideModule = new WebAssembly.Module(readFileSync(curlSoPath));
    const mainExports = new Set(
      WebAssembly.Module.exports(mainModule).map(({ name }) => name),
    );
    const sideExports = new Set(
      WebAssembly.Module.exports(sideModule).map(({ name }) => name),
    );
    const loaderImports = new Set([
      "memory",
      "__indirect_function_table",
      "__stack_pointer",
      "__memory_base",
      "__table_base",
      "__c_longjmp",
    ]);

    const missing = WebAssembly.Module.imports(sideModule)
      .filter(({ module, name }) => {
        if (module === "env") {
          return !loaderImports.has(name) && !mainExports.has(name);
        }
        if (module === "GOT.mem" || module === "GOT.func") {
          return !mainExports.has(name) && !sideExports.has(name);
        }
        return true;
      })
      .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it("keeps curl out of base php.wasm", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-m"],
      io: new NodePlatformIO(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("curl");
  }, 60_000);

  it("loads curl.so and reports its linked libcurl", async () => {
    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: [
        "php",
        "-d",
        `extension=${curlSoPath}`,
        "-r",
        'echo json_encode(["loaded" => extension_loaded("curl"), "version" => curl_version()["version"], "constant" => defined("CURLOPT_URL"), "handle" => is_object(curl_init())]);',
      ],
      io: new NodePlatformIO(),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      loaded: true,
      version: "8.11.1",
      constant: true,
      handle: true,
    });
  }, 60_000);

  it("transfers file URL bytes through libcurl", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kandelo-php-curl-"));
    scratchDirs.push(scratch);
    const fixture = join(scratch, "fixture.txt");
    writeFileSync(fixture, "kandelo-curl-ok\n");
    const fixtureUrl = pathToFileURL(fixture).href;

    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: [
        "php",
        "-d",
        `extension=${curlSoPath}`,
        "-r",
        `$ch = curl_init(${JSON.stringify(fixtureUrl)});
         curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
         $body = curl_exec($ch);
         if ($body === false) { fwrite(STDERR, curl_error($ch)); exit(1); }
         echo $body;`,
      ],
      io: new NodePlatformIO(),
      timeout: 60_000,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("kandelo-curl-ok\n");
  }, 60_000);

  it("performs HTTP over kernel loopback after fork", async () => {
    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: [
        "php",
        "-d",
        `extension=${curlSoPath}`,
        "-r",
        `$server = stream_socket_server("tcp://127.0.0.1:0", $errno, $error);
         if ($server === false) { fwrite(STDERR, "$errno:$error"); exit(10); }
         $address = stream_socket_get_name($server, false);
         $pid = pcntl_fork();
         if ($pid < 0) { fwrite(STDERR, "fork failed"); exit(11); }
         if ($pid === 0) {
             fclose($server);
             $ch = curl_init("http://$address/probe");
             curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
             curl_setopt($ch, CURLOPT_TIMEOUT, 10);
             $body = curl_exec($ch);
             if ($body === false) { fwrite(STDERR, curl_error($ch)); exit(12); }
             echo json_encode(["body" => $body, "status" => curl_getinfo($ch, CURLINFO_RESPONSE_CODE)]);
             exit(0);
         }
         $client = stream_socket_accept($server, 10);
         if ($client === false) { fwrite(STDERR, "accept failed"); exit(13); }
         $request = "";
         while (!str_contains($request, "\\r\\n\\r\\n")) {
             $chunk = fread($client, 4096);
             if ($chunk === false || $chunk === "") { fwrite(STDERR, "request read failed"); exit(14); }
             $request .= $chunk;
         }
         fwrite($client, "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 16\\r\\nConnection: close\\r\\n\\r\\nkandelo-curl-ok\\n");
         fclose($client);
         fclose($server);
         pcntl_waitpid($pid, $status);
         if (!pcntl_wifexited($status) || pcntl_wexitstatus($status) !== 0) { exit(15); }`,
      ],
      io: new NodePlatformIO(),
      timeout: 120_000,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      body: "kandelo-curl-ok\n",
      status: 200,
    });
  }, 120_000);
});
