/**
 * Suite 1: Erlang Ring
 *
 * Spawns 1000 Erlang processes in a ring, sends a token around 100 times.
 * Uses the BEAM VM running on the wasm-posix-kernel.
 *
 * Metrics:
 *   total_ms         — Wall-clock time for full ring completion
 *   messages_per_sec — Total messages / elapsed seconds
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";
import { tryResolveBinary } from "../../host/src/binary-resolver.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const MAX_PAGES = 16384;

const erlangLibDir = resolve(repoRoot, "examples/libs/erlang");
const installDir = resolve(erlangLibDir, "erlang-install");
const beamWasm = tryResolveBinary("programs/erlang.wasm");
const ringDir = resolve(repoRoot, "examples/erlang");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runErlangRing(): Promise<Record<string, number>> {
  const beamBytes = loadBytes(beamWasm!);

  let stdout = "";
  let lastOutputTime = 0;
  let outputSeen = false;

  const host = new NodeKernelHost({
    maxWorkers: 8,
    onStdout: (_pid, data) => {
      outputSeen = true;
      lastOutputTime = Date.now();
      stdout += new TextDecoder().decode(data);
    },
    onStderr: () => {},
  });

  await host.init();

  // Protect thread region
  const maxThreads = 8;
  const pagesPerThread = 4;
  const lowestThreadTlsPage = MAX_PAGES - 2 - maxThreads * pagesPerThread - 2;

  const beamArgs = [
    "beam.smp",
    "-S", "1:1",
    "-A", "0",
    "-SDio", "1",
    "-SDcpu", "1:1",
    "-P", "262144",
    "--",
    "-root", installDir,
    "-bindir", resolve(installDir, "erts-16.1.2/bin"),
    "-progname", "erl",
    "-home", "/tmp",
    "-start_epmd", "false",
    "-boot", resolve(installDir, "releases/28/start_clean"),
    "-noshell",
    "-pa", ".", ringDir,
    resolve(installDir, "lib/kernel-10.4.2/ebin"),
    resolve(installDir, "lib/stdlib-7.1/ebin"),
    "-eval", "ring:start().",
  ];

  const t0 = performance.now();

  const exitPromise = host.spawn(beamBytes, beamArgs, {
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TMPDIR=/tmp",
      "LANG=en_US.UTF-8",
      `ROOTDIR=${installDir}`,
      `BINDIR=${installDir}/erts-16.1.2/bin`,
      "EMU=beam",
      "PROGNAME=erl",
    ],
    cwd: ringDir,
    maxAddr: lowestThreadTlsPage * 65536,
  });

  // Halt detection: BEAM's halt gets stuck in pthread_join
  let haltResolve: (status: number) => void;
  const haltDetector = setInterval(() => {
    if (outputSeen && Date.now() - lastOutputTime > 2000) {
      clearInterval(haltDetector);
      haltResolve(0);
    }
  }, 500);

  const timeoutPromise = new Promise<number>((r) => {
    haltResolve = r;
    setTimeout(() => { clearInterval(haltDetector); r(1); }, 120_000);
  });

  await Promise.race([exitPromise, timeoutPromise]);
  const t1 = performance.now();

  await host.destroy().catch(() => {});

  // Parse output: "Completed in X.XXX seconds (XXXXX us)"
  const usMatch = stdout.match(/\((\d+) us\)/);
  const msgMatch = stdout.match(/Total messages: (\d+)/);

  if (!usMatch || !msgMatch) {
    throw new Error(`Failed to parse ring output:\n${stdout}`);
  }

  const elapsedUs = parseInt(usMatch[1], 10);
  const totalMessages = parseInt(msgMatch[1], 10);
  const totalMs = elapsedUs / 1000;
  const messagesPerSec = Math.round(totalMessages / (elapsedUs / 1e6));

  return {
    total_ms: totalMs,
    messages_per_sec: messagesPerSec,
  };
}

const suite: BenchmarkSuite = {
  name: "erlang-ring",

  async run(): Promise<Record<string, number>> {
    if (!beamWasm) {
      console.warn("  erlang.wasm not found, skipping. Run: scripts/fetch-binaries.sh (or build locally).");
      return {};
    }
    const { existsSync } = await import("fs");
    if (!existsSync(resolve(installDir, "releases/28/start_clean.boot"))) {
      console.warn("  Erlang OTP not installed, skipping.");
      return {};
    }
    return runErlangRing();
  },
};

export default suite;
