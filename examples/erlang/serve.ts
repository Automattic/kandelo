/**
 * serve.ts — Run Erlang/OTP BEAM VM on the wasm-posix-kernel.
 *
 * Starts the BEAM emulator with single scheduler (+S 1:1) and
 * threading support for dirty schedulers and async threads.
 *
 * Usage:
 *   npx tsx examples/erlang/serve.ts -eval "io:format(\"Hello from BEAM!~n\"), halt()."
 *   npx tsx examples/erlang/serve.ts -eval "ring:start()."
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { findRepoRoot, tryResolveBinary } from "../../host/src/binary-resolver";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = findRepoRoot();

const erlangLibDir = resolve(repoRoot, "examples/libs/erlang");
const installDir = resolve(erlangLibDir, "erlang-install");

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const beamWasm = tryResolveBinary("programs/erlang.wasm");
    if (!beamWasm) {
        console.error(
            "erlang.wasm not found. Run: scripts/fetch-binaries.sh " +
            "(or bash examples/libs/erlang/build-erlang.sh to build locally).",
        );
        process.exit(1);
    }

    const beamBytes = loadBytes(beamWasm);

    // Track output timing for halt detection
    let lastOutputTime = 0;
    let outputSeen = false;

    // Capture BEAM output to files for debugging
    try { writeFileSync('/tmp/beam-stdout.log', ''); writeFileSync('/tmp/beam-stderr.log', ''); } catch {}

    const host = new NodeKernelHost({
        maxWorkers: 8,
        onStdout: (_pid, data) => {
            outputSeen = true;
            lastOutputTime = Date.now();
            const text = new TextDecoder().decode(data);
            process.stdout.write(text);
            try { appendFileSync('/tmp/beam-stdout.log', text); } catch {}
        },
        onStderr: (_pid, data) => {
            const text = new TextDecoder().decode(data);
            process.stderr.write(text);
            try { appendFileSync('/tmp/beam-stderr.log', text); } catch {}
        },
    });

    await host.init();

    // BEAM emulator arguments
    const userArgs = process.argv.slice(2);

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
        "-pa", ".", scriptDir,
        resolve(installDir, "lib/kernel-10.4.2/ebin"),
        resolve(installDir, "lib/stdlib-7.1/ebin"),
        ...userArgs,
    ];

    console.log("Starting BEAM emulator...");
    console.log("Args:", beamArgs.slice(1).join(" "));
    console.log("");

    // Reserve top of memory for thread channels/TLS
    const maxThreads = 8;
    const pagesPerThread = 4;
    const MAX_PAGES = 16384;
    const lowestThreadTlsPage = MAX_PAGES - 2 - maxThreads * pagesPerThread - 2;
    const safeMaxAddr = lowestThreadTlsPage * 65536;
    console.log(`[setup] max_addr set to 0x${safeMaxAddr.toString(16)} (page ${lowestThreadTlsPage}) to protect thread region`);

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
        cwd: scriptDir,
        maxAddr: safeMaxAddr,
    });

    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        await host.destroy().catch(() => {});
        process.exit(0);
    });

    // Detect stuck halt: BEAM's halt(0) gets stuck in pthread_join because
    // threads are blocked on futex waits. If output was produced and no new
    // output for 2s, BEAM is likely stuck — force clean exit.
    let exitResolve: (status: number) => void;
    const haltDetector = setInterval(() => {
        if (outputSeen && Date.now() - lastOutputTime > 2000) {
            clearInterval(haltDetector);
            exitResolve(0);
        }
    }, 500);

    const timeoutPromise = new Promise<number>((resolveP) => {
        exitResolve = resolveP;
        setTimeout(() => {
            clearInterval(haltDetector);
            console.log("\nTimeout reached. Forcing shutdown.");
            resolveP(1);
        }, 120_000);
    });

    const status = await Promise.race([exitPromise, timeoutPromise]);
    await host.destroy().catch(() => {});
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
