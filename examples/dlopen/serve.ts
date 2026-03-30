/**
 * serve.ts — Run the dlopen example program.
 *
 * Loads main.wasm, which dynamically loads hello-lib.so via dlopen,
 * calls its exported functions, and prints results.
 *
 * Usage:
 *   bash examples/dlopen/build.sh
 *   npx tsx examples/dlopen/serve.ts
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper";

const scriptDir = dirname(new URL(import.meta.url).pathname);

async function main() {
    const mainWasm = resolve(scriptDir, "main.wasm");
    const libPath = resolve(scriptDir, "hello-lib.so");

    if (!existsSync(mainWasm) || !existsSync(libPath)) {
        console.error("Build artifacts not found. Run: bash examples/dlopen/build.sh");
        process.exit(1);
    }

    const result = await runCentralizedProgram({
        programPath: mainWasm,
        argv: ["main", libPath],
        timeout: 10_000,
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
