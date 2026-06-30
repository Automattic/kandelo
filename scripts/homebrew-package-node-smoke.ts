/**
 * Node-side smoke coverage for Kandelo Homebrew package sidecars.
 *
 * The runner consumes generated Kandelo/Homebrew sidecars, materializes each
 * requested package into a VFS, and runs a package-specific smoke through
 * NodeKernelHost. Program packages execute their poured binary. SQLite
 * compiles test-only consumers from the poured headers and static libraries.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ABI_VERSION } from "../host/src/generated/abi";
import { fetchHomebrewBottleBytes } from "../host/src/homebrew-vfs-fetch";
import { buildHomebrewVfs } from "../host/src/homebrew-vfs-builder";
import {
  HomebrewVfsUnsupportedError,
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewTapMetadata,
  type HomebrewVfsPackagePlan,
} from "../host/src/homebrew-vfs-planner";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import { saveImage } from "../images/vfs/scripts/vfs-image-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const PREFIX = "/home/linuxbrew/.linuxbrew";
const CELLAR = `${PREFIX}/Cellar`;

type OutcomeStatus = "pass" | "fail" | "skip";
type FormulaName =
  | "sqlite"
  | "bzip2"
  | "xz"
  | "openssl"
  | "libcxx"
  | "libxml2"
  | "libpng"
  | "libcurl"
  | "ncurses"
  | "spidermonkey"
  | "spidermonkey-node"
  | "node"
  | "redis"
  | "nginx"
  | "mariadb";

interface CliOptions {
  resultDir: string;
  tapRoot: string;
  formulas: FormulaName[];
  arch: HomebrewBottleArch;
  bottleCache: string;
  timeoutMs: number;
  maxBytes: number;
  beadId: string;
}

interface Outcome {
  name: string;
  status: OutcomeStatus;
  durationMs: number;
  details?: string;
  error?: string;
}

interface BuiltVfs {
  fs: MemoryFileSystem;
  imageBytes: Uint8Array;
  reportPath: string;
}

class SkipCase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipCase";
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.resultDir, { recursive: true });
  mkdirSync(join(options.resultDir, "outcome-lists"), { recursive: true });
  mkdirSync(options.bottleCache, { recursive: true });

  const metadataPath = join(options.tapRoot, "Kandelo", "metadata.json");
  const metadata = readJsonFile<HomebrewTapMetadata>(metadataPath);
  const tapCommit = gitRevParse(options.tapRoot);
  const startedAt = new Date();
  const outcomes: Outcome[] = [];

  writeCurrentRun(options, {
    status: "running",
    startedAt,
    tapCommit,
    outcomes,
    currentCase: "startup",
  });

  const builtByFormula = new Map<FormulaName, BuiltVfs>();
  const unsupportedByFormula = new Map<FormulaName, string>();
  for (const formula of options.formulas) {
    const buildOutcome = await runCase(outcomes, options, tapCommit, `homebrew_vfs_build_${formula}`, async () => {
      const built = await buildFormulaVfs(metadata, formula, options);
      builtByFormula.set(formula, built);
      return `report=${built.reportPath}`;
    });
    if (buildOutcome.status === "skip" && buildOutcome.details) {
      unsupportedByFormula.set(formula, buildOutcome.details);
    }

    await runCase(outcomes, options, tapCommit, `node_smoke_${formula}`, async () => {
      const built = builtByFormula.get(formula);
      if (!built) {
        throw new SkipCase(
          unsupportedByFormula.get(formula) ?? `requires successful homebrew_vfs_build_${formula}`,
        );
      }
      return await runFormulaSmoke(formula, built, options);
    });
  }

  writeOutcomeLists(options.resultDir, outcomes);
  writeSummary(options, {
    startedAt,
    completedAt: new Date(),
    tapCommit,
    outcomes,
  });
  writeCurrentRun(options, {
    status: outcomes.some((outcome) => outcome.status === "fail") ? "failed" : "complete",
    startedAt,
    tapCommit,
    outcomes,
    currentCase: "complete",
  });

  process.exit(outcomes.some((outcome) => outcome.status === "fail") ? 1 : 0);
}

async function buildFormulaVfs(
  metadata: HomebrewTapMetadata,
  formula: FormulaName,
  options: CliOptions,
): Promise<BuiltVfs> {
  let plan;
  try {
    plan = await planHomebrewVfs(metadata, {
      packages: [formula],
      arch: options.arch,
      runtime: "node",
      expectedAbi: ABI_VERSION,
      loadLinkManifest: (relPath) => readJsonFile(join(options.tapRoot, relPath)),
    });
  } catch (err) {
    if (err instanceof HomebrewVfsUnsupportedError) {
      throw new SkipCase(formatUnsupportedRuntime(err, formula));
    }
    throw err;
  }
  const fs = createFs(options.maxBytes);
  const result = await buildHomebrewVfs(plan, {
    fs,
    createdBy: "scripts/homebrew-package-node-smoke.ts",
    loadBottleBytes: (pkg) => loadBottleBytes(pkg, options),
  });

  const reportPath = join(options.resultDir, `${formula}-${options.arch}-homebrew-vfs-report.json`);
  writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  const imagePath = join(options.resultDir, `${formula}-${options.arch}-homebrew.vfs.zst`);
  const imageBytes = await saveImage(fs, imagePath, {
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "scripts/homebrew-package-node-smoke.ts",
      homebrew: {
        tapRepository: plan.tapRepository,
        tapCommit: plan.tapCommit,
        releaseTag: plan.releaseTag,
        packages: plan.packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          arch: pkg.arch,
          sourceStatus: pkg.sourceStatus,
          cacheKeySha: pkg.cacheKeySha,
        })),
      },
    },
  });
  return { fs, imageBytes, reportPath };
}

function formatUnsupportedRuntime(err: HomebrewVfsUnsupportedError, requestedFormula: string): string {
  const status = err.runtimeStatus;
  const details = [
    `requested=${requestedFormula}`,
    `blocked_package=${err.packageName}`,
    `runtime=${err.runtime}`,
    `arch=${err.arch}`,
  ];
  if (status?.status) details.push(`status=${status.status}`);
  if (status?.reason_code) details.push(`reason_code=${status.reason_code}`);
  if (status?.reason) details.push(`reason=${status.reason}`);
  for (const failure of status?.artifact_policy_failures ?? []) {
    details.push(`artifact=${failure.path}: ${failure.failures.join("; ")}`);
  }
  return details.join("; ");
}

async function runFormulaSmoke(
  formula: FormulaName,
  built: BuiltVfs,
  options: CliOptions,
): Promise<string> {
  switch (formula) {
    case "sqlite":
      return runSqliteSmoke(built, options);
    case "bzip2":
      return runProgramVersionSmoke("bzip2", `${PREFIX}/bin/bzip2`, /bzip2/i, built, options, ["--help"]);
    case "xz":
      return runProgramVersionSmoke("xz", `${PREFIX}/bin/xz`, /xz/i, built, options);
    case "openssl":
      return runOpenSslSmoke(built, options);
    case "libcxx":
      return runLibcxxSmoke(built, options);
    case "libxml2":
      return runLibxml2Smoke(built, options);
    case "libpng":
      return runLibpngSmoke(built, options);
    case "libcurl":
      return runLibcurlSmoke(built, options);
    case "ncurses":
      return runNcursesSmoke(built, options);
    case "spidermonkey":
      return runSpiderMonkeySmoke(built, options);
    case "spidermonkey-node":
      return runSpiderMonkeyNodeSmoke("spidermonkey-node", `${PREFIX}/bin/spidermonkey-node`, built, options);
    case "node":
      return runSpiderMonkeyNodeSmoke("node", `${PREFIX}/bin/node`, built, options);
    case "redis":
      return runRedisSmoke(built, options);
    case "nginx":
      return runNginxSmoke(built, options);
    case "mariadb":
      return runMariadbSmoke(built, options);
  }
}

async function runProgramVersionSmoke(
  argv0: string,
  guestPath: string,
  expected: RegExp,
  built: BuiltVfs,
  options: CliOptions,
  args: string[] = ["--version"],
): Promise<string> {
  const programBytes = readVfsFile(built.fs, guestPath);
  const result = await runWasm(programBytes, [argv0, ...args], built.imageBytes, options);
  if (result.exitCode !== 0) {
    throw new Error(`${argv0} ${args.join(" ")} exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!expected.test(combined)) {
    throw new Error(`unexpected ${argv0} ${args.join(" ")} output: ${JSON.stringify(combined)}`);
  }
  return combined.trim().split("\n").find((line) => line.trim() !== "") ?? `${argv0} ${args.join(" ")} passed`;
}

async function runSqliteSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const stage = join(options.resultDir, "sqlite-consumer-build", options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "include"), { recursive: true });
  mkdirSync(join(stage, "lib"), { recursive: true });

  const version = findPackageVersion(built.fs, "sqlite");
  writeFileSync(
    join(stage, "include", "sqlite3.h"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/include/sqlite3.h`),
  );
  writeFileSync(
    join(stage, "include", "sqlite3ext.h"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/include/sqlite3ext.h`),
  );
  writeFileSync(
    join(stage, "lib", "libsqlite3.a"),
    readVfsFile(built.fs, `${CELLAR}/sqlite/${version}/lib/libsqlite3.a`),
  );

  const testSrc = join(repoRoot, "packages", "registry", "sqlite", "test", "sqlite_basic.c");
  const outWasm = join(stage, "sqlite_basic.wasm");
  const cc = join(repoRoot, "sdk", "bin", `${options.arch}posix-cc`);
  execFileSync(cc, [
    `-I${join(stage, "include")}`,
    testSrc,
    join(stage, "lib", "libsqlite3.a"),
    "-lm",
    "-o",
    outWasm,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${join(repoRoot, "sdk", "bin")}:${process.env.PATH ?? ""}`,
      WASM_POSIX_SYSROOT: join(repoRoot, options.arch === "wasm64" ? "sysroot64" : "sysroot"),
    },
    stdio: "pipe",
  });

  const consumerBytes = new Uint8Array(readFileSync(outWasm));
  const result = await runWasm(consumerBytes, ["sqlite_basic"], built.imageBytes, options);
  if (result.exitCode !== 0) {
    throw new Error(`sqlite_basic exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`);
  }
  if (!result.stdout.includes("PASS")) {
    throw new Error(`sqlite_basic did not report PASS: ${JSON.stringify(result.stdout)}`);
  }
  return "sqlite_basic linked against poured sqlite keg and reported PASS";
}

async function runOpenSslSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const stage = stagePackagePaths(built, options, "openssl", [
    "include/openssl",
    "lib/libssl.a",
    "lib/libcrypto.a",
  ]);
  const testSrc = join(repoRoot, "packages", "registry", "openssl", "test", "ssl_basic.c");
  const outWasm = join(stage, "ssl_basic.wasm");
  runCompiler(options, "cc", [
    `-I${join(stage, "include")}`,
    testSrc,
    join(stage, "lib", "libssl.a"),
    join(stage, "lib", "libcrypto.a"),
    "-ldl",
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["ssl_basic"], built.imageBytes, options);
  assertRunPassed("ssl_basic", result, "PASS");
  return "ssl_basic linked against poured openssl keg and reported PASS";
}

async function runLibcxxSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const stage = stagePackagePaths(built, options, "libcxx", [
    "include/c++/v1",
    "lib/libc++.a",
    "lib/libc++abi.a",
  ]);
  const testSrc = join(stage, "libcxx-smoke.cpp");
  const outWasm = join(stage, "libcxx-smoke.wasm");
  writeFileSync(testSrc, `#include <stdexcept>
#include <string>
#include <vector>
#include <cstdio>
int main() {
  try {
    std::vector<std::string> values;
    values.push_back("kandelo");
    if (values.size() != 1) throw std::runtime_error("vector failed");
    throw std::runtime_error(values[0]);
  } catch (const std::runtime_error& err) {
    std::printf("libcxx caught %s\\n", err.what());
    return 0;
  }
}
`);

  runCompiler(options, "c++", [
    "-std=c++20",
    "-fexceptions",
    "-fwasm-exceptions",
    "-mexception-handling",
    "-mllvm",
    "-wasm-enable-sjlj",
    "-mllvm",
    "-wasm-use-legacy-eh=false",
    "-nostdinc++",
    "-isystem",
    join(stage, "include", "c++", "v1"),
    testSrc,
    join(stage, "lib", "libc++.a"),
    join(stage, "lib", "libc++abi.a"),
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["libcxx-smoke"], built.imageBytes, options);
  assertRunPassed("libcxx-smoke", result, "libcxx caught kandelo");
  return "libcxx consumer linked against poured libcxx keg and caught an exception";
}

async function runLibxml2Smoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const xmlStage = stagePackagePaths(built, options, "libxml2", [
    "include/libxml",
    "lib/libxml2.a",
  ]);
  const zlibStage = stagePackagePaths(built, options, "zlib", ["lib/libz.a"], "libxml2-zlib");
  const testSrc = join(repoRoot, "packages", "registry", "libxml2", "test", "libxml2_basic.c");
  const outWasm = join(xmlStage, "libxml2_basic.wasm");
  runCompiler(options, "cc", [
    `-I${join(xmlStage, "include")}`,
    testSrc,
    join(xmlStage, "lib", "libxml2.a"),
    join(zlibStage, "lib", "libz.a"),
    "-lm",
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["libxml2_basic"], built.imageBytes, options);
  assertRunPassed("libxml2_basic", result, "PASS");
  return "libxml2_basic linked against poured libxml2 and zlib kegs and reported PASS";
}

async function runLibpngSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const pngStage = stagePackagePaths(built, options, "libpng", [
    "include/libpng16",
    "lib/libpng16.a",
  ]);
  const zlibStage = stagePackagePaths(built, options, "zlib", ["lib/libz.a"], "libpng-zlib");
  const testSrc = join(pngStage, "libpng-smoke.c");
  const outWasm = join(pngStage, "libpng-smoke.wasm");
  writeFileSync(testSrc, `#include <png.h>
#include <stdio.h>
int main(void) {
  printf("libpng %s ok\\n", png_get_libpng_ver(NULL));
  return 0;
}
`);

  runCompiler(options, "cc", [
    `-I${join(pngStage, "include", "libpng16")}`,
    testSrc,
    join(pngStage, "lib", "libpng16.a"),
    join(zlibStage, "lib", "libz.a"),
    "-lm",
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["libpng-smoke"], built.imageBytes, options);
  assertRunPassed("libpng-smoke", result, "libpng");
  return "libpng consumer linked against poured libpng and zlib kegs";
}

async function runLibcurlSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const curlStage = stagePackagePaths(built, options, "libcurl", [
    "include/curl",
    "lib/libcurl.a",
  ]);
  const opensslStage = stagePackagePaths(built, options, "openssl", [
    "include/openssl",
    "lib/libssl.a",
    "lib/libcrypto.a",
  ], "libcurl-openssl");
  const zlibStage = stagePackagePaths(built, options, "zlib", ["lib/libz.a"], "libcurl-zlib");
  const testSrc = join(curlStage, "libcurl-smoke.c");
  const outWasm = join(curlStage, "libcurl-smoke.wasm");
  writeFileSync(testSrc, `#include <curl/curl.h>
#include <stdio.h>
int main(void) {
  CURLcode rc = curl_global_init(CURL_GLOBAL_DEFAULT);
  if (rc != CURLE_OK) {
    printf("curl_global_init failed: %d\\n", (int)rc);
    return 1;
  }
  printf("libcurl %s ok\\n", curl_version());
  curl_global_cleanup();
  return 0;
}
`);

  runCompiler(options, "cc", [
    `-I${join(curlStage, "include")}`,
    `-I${join(opensslStage, "include")}`,
    testSrc,
    join(curlStage, "lib", "libcurl.a"),
    join(opensslStage, "lib", "libssl.a"),
    join(opensslStage, "lib", "libcrypto.a"),
    join(zlibStage, "lib", "libz.a"),
    "-ldl",
    "-lm",
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["libcurl-smoke"], built.imageBytes, options);
  assertRunPassed("libcurl-smoke", result, "libcurl");
  return "libcurl consumer linked against poured libcurl, openssl, and zlib kegs";
}

async function runNcursesSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const programBytes = readVfsFile(built.fs, `${PREFIX}/bin/tput`);
  const programResult = await runWasm(programBytes, ["tput", "-V"], built.imageBytes, options);
  assertRunPassed("tput -V", programResult, "ncurses");

  const stage = stagePackagePaths(built, options, "ncurses", [
    "include/ncursesw",
    "lib/libncursesw.a",
    "lib/libtinfow.a",
  ]);
  const testSrc = join(stage, "ncurses-smoke.c");
  const outWasm = join(stage, "ncurses-smoke.wasm");
  writeFileSync(testSrc, `#include <ncursesw/curses.h>
#include <stdio.h>
int main(void) {
  printf("%s\\n", curses_version());
  return 0;
}
`);

  runCompiler(options, "cc", [
    `-I${join(stage, "include")}`,
    testSrc,
    join(stage, "lib", "libncursesw.a"),
    join(stage, "lib", "libtinfow.a"),
    "-o",
    outWasm,
  ]);

  const result = await runWasm(new Uint8Array(readFileSync(outWasm)), ["ncurses-smoke"], built.imageBytes, options);
  assertRunPassed("ncurses-smoke", result, "ncurses");
  return "tput -V ran and an ncurses consumer linked against the poured keg";
}

async function runSpiderMonkeySmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const programBytes = readVfsFile(built.fs, `${PREFIX}/bin/js`);
  const result = await runWasm(programBytes, [
    "js",
    "-e",
    [
      "print(1 + 1)",
      "print([3, 1, 2].toSorted().join(','))",
      "print(typeof Intl)",
    ].join(";"),
  ], built.imageBytes, options);
  assertRunPassed("js -e", result, "2\n1,2,3\nobject");
  return "SpiderMonkey js shell evaluated arithmetic, modern array syntax, and Intl";
}

async function runSpiderMonkeyNodeSmoke(
  argv0: "spidermonkey-node" | "node",
  guestPath: string,
  built: BuiltVfs,
  options: CliOptions,
): Promise<string> {
  const programBytes = readVfsFile(built.fs, guestPath);
  const versionResult = await runWasm(programBytes, [argv0, "--version"], built.imageBytes, options);
  assertRunPassed(`${argv0} --version`, versionResult, "v22.0.0");

  const evalResult = await runWasm(programBytes, [
    argv0,
    "-e",
    [
      "const assert = require('node:assert')",
      "const path = require('path')",
      "const util = require('util')",
      "const b = Buffer.from('hello')",
      "assert.strictEqual(Buffer.isBuffer(b), true)",
      "assert.strictEqual(b.toString('hex'), '68656c6c6f')",
      "console.log(util.format('%s:%d:%s', path.basename('/usr/bin/node'), b.length, process.platform))",
    ].join(";"),
  ], built.imageBytes, options);
  assertRunPassed(`${argv0} -e`, evalResult, "node:5:linux");
  return `${argv0} reported v22.0.0 and exercised process, Buffer, path, util, and assert`;
}

async function runRedisSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const serverBytes = readVfsFile(built.fs, `${PREFIX}/bin/redis-server`);
  const serverResult = await runWasm(serverBytes, ["redis-server", "--version"], built.imageBytes, options);
  assertRunPassed("redis-server --version", serverResult, "Redis server");

  const cliBytes = readVfsFile(built.fs, `${PREFIX}/bin/redis-cli`);
  const cliResult = await runWasm(cliBytes, ["redis-cli", "--version"], built.imageBytes, options);
  assertRunPassed("redis-cli --version", cliResult, "redis-cli");

  await runRedisPingSmoke(serverBytes, cliBytes, built.imageBytes, options);
  return "redis-server and redis-cli version paths ran, and redis-cli PING returned PONG through a poured Homebrew VFS";
}

async function runRedisPingSmoke(
  serverBytes: Uint8Array,
  cliBytes: Uint8Array,
  rootfsImage: Uint8Array,
  options: CliOptions,
): Promise<void> {
  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage,
    enableTcpNetwork: true,
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });

  await host.init();
  let serverPid: number | undefined;
  let serverExitStatus: number | Error | undefined;
  const port = "26379";
  const env = programEnv();
  const serverExit = host.spawn(toArrayBuffer(serverBytes), [
    "redis-server",
    "--save", "",
    "--appendonly", "no",
    "--protected-mode", "no",
    "--bind", "127.0.0.1",
    "--port", port,
    "--dir", "/tmp",
  ], {
    env,
    cwd: "/",
    stdin: new Uint8Array(),
    onStarted: (pid) => { serverPid = pid; },
  });
  serverExit.then(
    (code) => { serverExitStatus = code; },
    (err) => { serverExitStatus = err instanceof Error ? err : new Error(String(err)); },
  );

  try {
    const pid = await waitForStarted(() => serverPid, "redis-server");
    const deadline = Date.now() + Math.max(options.timeoutMs, 15_000);
    let lastAttempt = "redis-cli PING was not attempted";

    while (Date.now() < deadline) {
      if (serverExitStatus !== undefined) {
        throw new Error(`redis-server exited before PING completed: ${serverExitStatus}; stderr=${JSON.stringify(stderr)}`);
      }

      const beforeStdout = stdout.length;
      const beforeStderr = stderr.length;
      let cliPid: number | undefined;
      const cliExit = host.spawn(toArrayBuffer(cliBytes), [
        "redis-cli",
        "-h", "127.0.0.1",
        "-p", port,
        "PING",
      ], {
        env,
        cwd: "/",
        stdin: new Uint8Array(),
        onStarted: (startedPid) => { cliPid = startedPid; },
      });
      await waitForStarted(() => cliPid, "redis-cli");
      const exitCode = await withTimeout(cliExit, 5_000, "redis-cli PING");
      const newStdout = stdout.slice(beforeStdout);
      const newStderr = stderr.slice(beforeStderr);
      lastAttempt = `exit=${exitCode} stdout=${JSON.stringify(newStdout)} stderr=${JSON.stringify(newStderr)}`;
      if (exitCode === 0 && newStdout.includes("PONG")) return;
      await sleep(250);
    }

    throw new Error(`redis-cli PING did not return PONG before timeout; ${lastAttempt}; server_pid=${pid}`);
  } finally {
    if (serverPid !== undefined) {
      await host.terminateProcess(serverPid, 0).catch(() => {});
      await Promise.race([serverExit, sleep(1_000)]).catch(() => {});
    }
    await host.destroy().catch(() => {});
  }
}

async function runNginxSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const programBytes = readVfsFile(built.fs, `${PREFIX}/bin/nginx`);
  const versionResult = await runWasm(programBytes, ["nginx", "-v"], built.imageBytes, options);
  if (versionResult.exitCode !== 0) {
    throw new Error(`nginx -v exited ${versionResult.exitCode}; stderr=${JSON.stringify(versionResult.stderr)}`);
  }
  if (!/nginx/i.test(`${versionResult.stdout}\n${versionResult.stderr}`)) {
    throw new Error(`nginx -v did not report nginx: ${JSON.stringify(versionResult.stderr || versionResult.stdout)}`);
  }
  await runNginxHttpSmoke(programBytes, built.imageBytes, options);
  return "nginx version path ran, and nginx served a static HTTP response through a poured Homebrew VFS";
}

async function runNginxHttpSmoke(
  programBytes: Uint8Array,
  rootfsImage: Uint8Array,
  options: CliOptions,
): Promise<void> {
  const stage = join(options.resultDir, "nginx-http-smoke", options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "html"), { recursive: true });
  mkdirSync(join(stage, "etc"), { recursive: true });
  writeFileSync(join(stage, "etc", "passwd"), [
    "root:x:0:0:root:/root:/bin/sh",
    "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    "",
  ].join("\n"));
  writeFileSync(join(stage, "etc", "group"), [
    "root:x:0:",
    "nobody:x:65534:",
    "",
  ].join("\n"));
  writeFileSync(join(stage, "html", "index.html"), "kandelo nginx smoke\n");
  writeFileSync(join(stage, "nginx.conf"), [
    "user nobody;",
    "worker_processes 1;",
    "pid /tmp/nginx-smoke/nginx.pid;",
    "error_log stderr notice;",
    "events { worker_connections 16; }",
    "http {",
    "  access_log off;",
    "  server {",
    "    listen 127.0.0.1:28080;",
    "    server_name localhost;",
    "    location / { root /tmp/nginx-smoke/html; }",
    "  }",
    "}",
    "",
  ].join("\n"));

  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage,
    enableTcpNetwork: true,
    extraMounts: [
      { mountPoint: "/tmp/nginx-smoke", hostPath: stage },
      { mountPoint: "/etc", hostPath: join(stage, "etc"), readonly: true },
    ],
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });

  await host.init();
  let serverPid: number | undefined;
  let serverExitStatus: number | Error | undefined;
  const serverExit = host.spawn(toArrayBuffer(programBytes), [
    "nginx",
    "-p", "/tmp/nginx-smoke",
    "-c", "/tmp/nginx-smoke/nginx.conf",
    "-g", "daemon off; master_process off;",
  ], {
    env: programEnv(),
    cwd: "/",
    stdin: new Uint8Array(),
    onStarted: (pid) => { serverPid = pid; },
  });
  serverExit.then(
    (code) => { serverExitStatus = code; },
    (err) => { serverExitStatus = err instanceof Error ? err : new Error(String(err)); },
  );

  try {
    await waitForStarted(() => serverPid, "nginx");
    let lastError: unknown = null;
    const deadline = Date.now() + Math.max(options.timeoutMs, 15_000);

    while (Date.now() < deadline) {
      if (serverExitStatus !== undefined) {
        throw new Error(`nginx exited before HTTP smoke completed: ${serverExitStatus}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
      }

      try {
        const response = await host.fetchInKernel(
          28080,
          { method: "GET", url: "/", headers: { Host: "localhost" }, body: null },
          { timeoutMs: 5_000 },
        );
        const body = new TextDecoder().decode(response.body);
        if (response.status !== 200 || body !== "kandelo nginx smoke\n") {
          throw new Error(`unexpected nginx response status=${response.status} body=${JSON.stringify(body)}`);
        }
        return;
      } catch (err) {
        lastError = err;
        await sleep(100);
      }
    }

    throw new Error(`nginx HTTP smoke did not complete before timeout: ${lastError}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
  } finally {
    if (serverPid !== undefined) {
      await host.terminateProcess(serverPid, 0).catch(() => {});
      await Promise.race([serverExit, sleep(1_000)]).catch(() => {});
    }
    await host.destroy().catch(() => {});
  }
}

async function runMariadbSmoke(built: BuiltVfs, options: CliOptions): Promise<string> {
  const serverBytes = readVfsFile(built.fs, `${PREFIX}/bin/mariadbd`);
  const serverResult = await runWasm(serverBytes, ["mariadbd", "--help", "--verbose"], built.imageBytes, options);
  if (serverResult.exitCode !== 0) {
    throw new Error(`mariadbd --help --verbose exited ${serverResult.exitCode}; stderr=${JSON.stringify(serverResult.stderr)}`);
  }
  const combined = `${serverResult.stdout}\n${serverResult.stderr}`;
  if (!/MariaDB|mariadbd/i.test(combined)) {
    throw new Error(`mariadbd help did not mention MariaDB: ${JSON.stringify(combined.slice(0, 4000))}`);
  }

  readVfsFile(built.fs, `${PREFIX}/bin/mysqltest`);
  return "mariadbd help ran through a poured Homebrew VFS and mysqltest was present";
}

function stagePackagePaths(
  built: BuiltVfs,
  options: CliOptions,
  formula: string,
  relPaths: string[],
  label = formula,
): string {
  const stage = join(options.resultDir, `${label}-consumer-build`, options.arch);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const version = findPackageVersion(built.fs, formula);
  for (const rel of relPaths) {
    copyVfsPath(
      built.fs,
      `${CELLAR}/${formula}/${version}/${rel}`,
      join(stage, rel),
    );
  }
  return stage;
}

function copyVfsPath(fs: MemoryFileSystem, vfsPath: string, localPath: string): void {
  const st = fs.stat(vfsPath);
  if ((st.mode & 0xf000) === 0x4000) {
    mkdirSync(localPath, { recursive: true });
    const dh = fs.opendir(vfsPath);
    try {
      while (true) {
        const entry = fs.readdir(dh);
        if (!entry) break;
        if (entry.name === "." || entry.name === "..") continue;
        copyVfsPath(fs, `${vfsPath}/${entry.name}`, join(localPath, entry.name));
      }
    } finally {
      fs.closedir(dh);
    }
    return;
  }

  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, readVfsFile(fs, vfsPath));
}

function runCompiler(options: CliOptions, compiler: "cc" | "c++", args: string[]): void {
  const command = join(repoRoot, "sdk", "bin", `${options.arch}posix-${compiler}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${join(repoRoot, "sdk", "bin")}:${process.env.PATH ?? ""}`,
      WASM_POSIX_SYSROOT: join(repoRoot, options.arch === "wasm64" ? "sysroot64" : "sysroot"),
      WASM_POSIX_GLUE_DIR: join(repoRoot, "libc", "glue"),
    },
    stdio: "pipe",
  });
}

function assertRunPassed(
  label: string,
  result: { exitCode: number; stdout: string; stderr: string },
  expectedStdout: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`);
  }
  if (!result.stdout.includes(expectedStdout)) {
    throw new Error(`${label} did not print ${JSON.stringify(expectedStdout)}: ${JSON.stringify(result.stdout)}`);
  }
}

async function runWasm(
  programBytes: Uint8Array,
  argv: string[],
  rootfsImage: Uint8Array,
  options: CliOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage,
    onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  });
  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(toArrayBuffer(programBytes), argv, {
      env: programEnv(),
      cwd: "/",
      stdin: new Uint8Array(),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${argv[0]} timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }
}

function programEnv(): string[] {
  return [
    "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "TMPDIR=/tmp",
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStarted(
  getPid: () => number | undefined,
  label: string,
): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const pid = getPid();
    if (pid !== undefined) return pid;
    await sleep(10);
  }
  throw new Error(`${label} did not start`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runCase(
  outcomes: Outcome[],
  options: CliOptions,
  tapCommit: string,
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<Outcome> {
  writeCurrentRun(options, {
    status: "running",
    tapCommit,
    outcomes,
    currentCase: name,
  });
  const started = Date.now();
  try {
    const details = await fn();
    const outcome = { name, status: "pass" as const, durationMs: Date.now() - started, details };
    outcomes.push(outcome);
    writeOutcomeLists(options.resultDir, outcomes);
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const outcome = {
      name,
      status: error instanceof SkipCase ? "skip" as const : "fail" as const,
      durationMs: Date.now() - started,
      details: error.message,
      error: error.stack ?? error.message,
    };
    outcomes.push(outcome);
    writeOutcomeLists(options.resultDir, outcomes);
    return outcome;
  }
}

async function loadBottleBytes(
  pkg: HomebrewVfsPackagePlan,
  options: CliOptions,
): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }

  const cachePath = join(options.bottleCache, `${pkg.sha256}.tar.gz`);
  if (existsSync(cachePath)) return new Uint8Array(readFileSync(cachePath));
  if (!pkg.url.startsWith("https://")) {
    throw new Error(
      `package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`,
    );
  }

  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  writeFileSync(cachePath, bytes);
  return bytes;
}

function findPackageVersion(fs: MemoryFileSystem, formula: string): string {
  const info = JSON.parse(new TextDecoder().decode(readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json")));
  const pkg = info.packages?.find((candidate: { name?: string }) => candidate.name === formula);
  if (!pkg) throw new Error(`package ${formula} missing from /etc/kandelo/homebrew-vfs.json`);
  const keg = String(pkg.keg ?? "");
  const prefix = `${CELLAR}/${formula}/`;
  if (!keg.startsWith(prefix)) throw new Error(`unexpected ${formula} keg path: ${keg}`);
  return keg.slice(prefix.length);
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.byteLength) {
      const n = fs.read(fd, out.subarray(offset), null, out.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    fs.close(fd);
  }
}

function createFs(maxBytes: number): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  return MemoryFileSystem.create(
    new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes }),
    maxBytes,
  );
}

function parseArgs(args: string[]): CliOptions {
  const defaultResultDir = join(
    repoRoot,
    "test-runs",
    "homebrew-package-node-smoke",
    new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z"),
  );
  const options: CliOptions = {
    resultDir: process.env.KANDELO_TEST_RESULT_DIR || defaultResultDir,
    tapRoot: process.env.KANDELO_HOMEBREW_TAP_ROOT || "",
    formulas: [],
    arch: "wasm32",
    bottleCache: "",
    timeoutMs: 30_000,
    maxBytes: 512 * 1024 * 1024,
    beadId: process.env.KANDELO_BEAD_ID || "kd-1mr.2",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--result-dir":
        options.resultDir = requireValue(args, ++i, arg);
        break;
      case "--tap-root":
        options.tapRoot = requireValue(args, ++i, arg);
        break;
      case "--formula":
        options.formulas.push(parseFormula(requireValue(args, ++i, arg)));
        break;
      case "--arch":
        options.arch = parseArch(requireValue(args, ++i, arg));
        break;
      case "--bottle-cache":
        options.bottleCache = requireValue(args, ++i, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(requireValue(args, ++i, arg), arg);
        break;
      case "--max-bytes":
        options.maxBytes = parseByteSize(requireValue(args, ++i, arg));
        break;
      case "--bead-id":
        options.beadId = requireValue(args, ++i, arg);
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        usage(2, `unexpected argument ${arg}`);
    }
  }

  if (!options.tapRoot) usage(2, "--tap-root is required");
  if (options.formulas.length === 0) usage(2, "at least one --formula is required");
  options.resultDir = resolve(options.resultDir);
  options.tapRoot = resolve(options.tapRoot);
  options.bottleCache = options.bottleCache
    ? resolve(options.bottleCache)
    : join(options.resultDir, "bottle-cache");
  return options;
}

function parseFormula(value: string): FormulaName {
  if (
    value === "sqlite" ||
    value === "bzip2" ||
    value === "xz" ||
    value === "openssl" ||
    value === "libcxx" ||
    value === "libxml2" ||
    value === "libpng" ||
    value === "libcurl" ||
    value === "ncurses" ||
    value === "spidermonkey" ||
    value === "spidermonkey-node" ||
    value === "node" ||
    value === "redis" ||
    value === "nginx" ||
    value === "mariadb"
  ) return value;
  usage(2, `--formula must be one of sqlite, bzip2, xz, openssl, libcxx, libxml2, libpng, libcurl, ncurses, spidermonkey, spidermonkey-node, node, redis, nginx, mariadb; got ${value}`);
}

function parseArch(value: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  usage(2, `--arch must be wasm32 or wasm64, got ${value}`);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) usage(2, `${flag} must be a positive integer`);
  return parsed;
}

function parseByteSize(value: string): number {
  const match = /^([1-9][0-9]*)([kKmMgG]i?[bB]?|[bB])?$/.exec(value);
  if (!match) usage(2, `--max-bytes must be a positive byte size, got ${value}`);
  const amount = Number(match[1]);
  const suffix = (match[2] ?? "b").toLowerCase();
  const multiplier = suffix.startsWith("g") ? 1024 ** 3
    : suffix.startsWith("m") ? 1024 ** 2
    : suffix.startsWith("k") ? 1024
    : 1;
  return amount * multiplier;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage(2, `${flag} requires a value`);
  return value;
}

function usage(code: number, message?: string): never {
  if (message) console.error(`homebrew-package-node-smoke: ${message}`);
  console.error(`usage: npx tsx scripts/homebrew-package-node-smoke.ts \\
  --tap-root <dir> --formula <name> [--formula ...] \\
  [--arch <wasm32|wasm64>] [--result-dir <dir>] [--bottle-cache <dir>]`);
  process.exit(code);
}

function writeOutcomeLists(resultDir: string, outcomes: Outcome[]): void {
  const listsDir = join(resultDir, "outcome-lists");
  mkdirSync(listsDir, { recursive: true });
  const passed = outcomes.filter((outcome) => outcome.status === "pass");
  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  const skipped = outcomes.filter((outcome) => outcome.status === "skip");
  writeFileSync(
    join(listsDir, "passed-tests.tsv"),
    ["test\tduration_ms\tdetails", ...passed.map((outcome) =>
      `${outcome.name}\t${outcome.durationMs}\t${tsv(outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "failed-tests.tsv"),
    ["test\tduration_ms\terror", ...failed.map((outcome) =>
      `${outcome.name}\t${outcome.durationMs}\t${tsv(outcome.error ?? outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(
    join(listsDir, "skipped-tests.tsv"),
    ["test\treason", ...skipped.map((outcome) =>
      `${outcome.name}\t${tsv(outcome.details ?? "")}`,
    )].join("\n") + "\n",
  );
  writeFileSync(join(resultDir, "failures.json"), `${JSON.stringify(failed, null, 2)}\n`);
}

function writeSummary(
  options: CliOptions,
  data: {
    startedAt: Date;
    completedAt: Date;
    tapCommit: string;
    outcomes: Outcome[];
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const summary = {
    suite: "Homebrew package Node VFS smoke",
    bead_id: options.beadId,
    started_at: data.startedAt.toISOString(),
    completed_at: data.completedAt.toISOString(),
    duration_ms: data.completedAt.getTime() - data.startedAt.getTime(),
    result_dir: options.resultDir,
    tap_root: options.tapRoot,
    tap_commit: data.tapCommit,
    arch: options.arch,
    formulas: options.formulas,
    counts,
    outcomes: data.outcomes,
    artifacts: {
      passed: join(options.resultDir, "outcome-lists", "passed-tests.tsv"),
      failed: join(options.resultDir, "outcome-lists", "failed-tests.tsv"),
      skipped: join(options.resultDir, "outcome-lists", "skipped-tests.tsv"),
      failures: join(options.resultDir, "failures.json"),
      current_run: join(options.resultDir, "current-run.json"),
    },
  };
  writeFileSync(join(options.resultDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(options.resultDir, "summary.md"), [
    "# Homebrew package Node VFS smoke",
    "",
    `Result dir: \`${options.resultDir}\``,
    `Tap commit: \`${data.tapCommit}\``,
    `Counts: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`,
    "",
    "| Test | Status | Details |",
    "|---|---:|---|",
    ...data.outcomes.map((outcome) =>
      `| \`${outcome.name}\` | ${outcome.status} | ${outcome.details ? outcome.details.replace(/\|/g, "\\|") : ""} |`,
    ),
    "",
  ].join("\n"));
}

function writeCurrentRun(
  options: CliOptions,
  data: {
    status: "running" | "complete" | "failed";
    startedAt?: Date;
    tapCommit: string;
    outcomes: Outcome[];
    currentCase: string;
  },
): void {
  const counts = countOutcomes(data.outcomes);
  const currentRun = {
    suite: "homebrew-package-node-smoke",
    bead_id: options.beadId,
    worktree: repoRoot,
    result_dir: options.resultDir,
    status: data.status,
    started_at: data.startedAt?.toISOString(),
    updated_at: new Date().toISOString(),
    current_case: data.currentCase,
    progress: {
      completed: data.outcomes.length,
      total: options.formulas.length * 2,
      pass: counts.pass,
      fail: counts.fail,
      skip: counts.skip,
    },
    tap_root: options.tapRoot,
    tap_commit: data.tapCommit,
    command: {
      cwd: repoRoot,
      argv: process.argv,
    },
    outcome_lists: {
      passed: join(options.resultDir, "outcome-lists", "passed-tests.tsv"),
      failed: join(options.resultDir, "outcome-lists", "failed-tests.tsv"),
      skipped: join(options.resultDir, "outcome-lists", "skipped-tests.tsv"),
    },
    stale_no_runner_threshold_seconds: 600,
    expected_next: data.status === "running"
      ? { deterministic: true, action: "continue current smoke case" }
      : { deterministic: false, action: "suite terminal" },
  };
  const out = join(options.resultDir, "current-run.json");
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(currentRun, null, 2)}\n`);
  renameSync(tmp, out);
}

function countOutcomes(outcomes: Outcome[]): { pass: number; fail: number; skip: number } {
  return {
    pass: outcomes.filter((outcome) => outcome.status === "pass").length,
    fail: outcomes.filter((outcome) => outcome.status === "fail").length,
    skip: outcomes.filter((outcome) => outcome.status === "skip").length,
  };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function gitRevParse(path: string): string {
  return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function tsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
