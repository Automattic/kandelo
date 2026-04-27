/**
 * serve.ts — Run CPython 3.13.3 in the wasm-posix-kernel.
 *
 * Usage:
 *   bash examples/libs/cpython/build-cpython.sh
 *   npx tsx examples/cpython/serve.ts [python-args...]
 *
 * Examples:
 *   npx tsx examples/cpython/serve.ts -c "print('Hello from CPython!')"
 *   npx tsx examples/cpython/serve.ts script.py
 *   npx tsx examples/cpython/serve.ts   # interactive REPL (stdin)
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../host/src/binary-resolver";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

async function main() {
    const pythonWasm = tryResolveBinary("programs/cpython.wasm");
    const pythonHome = resolve(scriptDir, "../libs/cpython/cpython-install");

    if (!pythonWasm) {
        console.error(
            "cpython.wasm not found. Run: scripts/fetch-binaries.sh " +
            "(or bash examples/libs/cpython/build-cpython.sh to build locally).",
        );
        process.exit(1);
    }

    if (!existsSync(resolve(pythonHome, "lib/python3.13/os.py"))) {
        console.error("Python stdlib not found. Run: bash examples/libs/cpython/build-cpython.sh");
        process.exit(1);
    }

    // Pass through CLI args after serve.ts
    const pythonArgs = process.argv.slice(2);
    const argv = ["python3", ...pythonArgs];

    const result = await runCentralizedProgram({
        programPath: pythonWasm,
        argv,
        env: [
            `PYTHONHOME=${pythonHome}`,
            `HOME=/tmp`,
            `TMPDIR=/tmp`,
            `PYTHONDONTWRITEBYTECODE=1`,
        ],
        timeout: 300_000,
    });

    process.stdout.write(result.stdout);
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    process.exit(result.exitCode);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
