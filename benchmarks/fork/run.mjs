#!/usr/bin/env node
//
// Sweep recursion depth on each variant of chain.wasm and report the
// maximum depth that survives V8's call-stack budget before the
// engine throws `RangeError: Maximum call stack size exceeded`.
//
// All kernel imports are stubbed; the recursion never actually forks.
// Only per-frame instrumentation overhead on V8's stack is measured.
//
// Usage:
//   node run.mjs                            # default sweep, both variants
//   node run.mjs --variants=forkinstr --max=5000
//
// Exits non-zero if forkinstr's max depth is not strictly less than
// baseline's — that invariant is the benchmark's reason to exist.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork as forkProcess } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, "out");

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? "true"] : [a, "true"];
    }),
);

const VARIANTS = (args.variants ?? "baseline,forkinstr").split(",");
const MAX_DEPTH = parseInt(args.max ?? "20000", 10);
const MIN_DEPTH = parseInt(args.min ?? "1", 10);

// Each probe runs in a fresh child process so a RangeError trap can't
// corrupt isolate state across measurements.

if (args._probe === "true") {
    const wasmPath = args.wasm;
    const depth = parseInt(args.depth, 10);
    const bytes = fs.readFileSync(wasmPath);
    // 2048 pages comfortably covers the 64 MB shadow stack reserved
    // by build.sh plus data segments.
    const memory = new WebAssembly.Memory({
        initial: 2048,
        maximum: 16384,
        shared: true,
    });
    const channelBase = new WebAssembly.Global({ value: "i32", mutable: true }, 0);

    // kernel_fork returns 1 so the leaf takes the parent branch and
    // returns cleanly. Any sweep large enough to overflow V8 never
    // reaches the leaf anyway.
    const stubFork = () => 1;
    const noop = () => 0;
    const importObject = new Proxy(
        {},
        {
            get: (_t, modName) =>
                new Proxy(
                    {},
                    {
                        get: (_t2, importName) => {
                            if (modName === "env" && importName === "memory")
                                return memory;
                            if (modName === "env" && importName === "__channel_base")
                                return channelBase;
                            if (modName === "kernel" && importName === "kernel_fork")
                                return stubFork;
                            return noop;
                        },
                    },
                ),
        },
    );

    try {
        const mod = await WebAssembly.compile(bytes);
        const instance = await WebAssembly.instantiate(mod, importObject);
        instance.exports.benchmark_walk(depth);
        process.exit(0);
    } catch (e) {
        // Distinguish the signal (RangeError = V8 stack overflow) from
        // real bugs (LinkError, validation, etc.) so the sweep doesn't
        // misattribute the latter to a particular depth.
        if (e instanceof RangeError) process.exit(2);
        process.stderr.write(`UNEXPECTED: ${e.stack ?? e}\n`);
        process.exit(3);
    }
}

function probe(wasmPath, depth) {
    return new Promise((resolve, reject) => {
        const child = forkProcess(
            __filename,
            ["--_probe=true", `--wasm=${wasmPath}`, `--depth=${depth}`],
            { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("exit", (code) => {
            if (code === 0) resolve({ ok: true });
            else if (code === 2) resolve({ ok: false, reason: "rangeerror" });
            else reject(new Error(`probe failed (code ${code}): ${stderr}`));
        });
        child.on("error", reject);
    });
}

async function findMaxDepth(wasmPath, label) {
    const sanity = await probe(wasmPath, MIN_DEPTH);
    if (!sanity.ok) {
        return { label, max_survived: null, error: "baseline_depth_fails" };
    }

    // Exponential probe up to find a failing upper bound, then binary
    // search inward. Avoids assuming any particular depth range.
    let lo = MIN_DEPTH;
    let hi = MIN_DEPTH;
    while (hi <= MAX_DEPTH) {
        const r = await probe(wasmPath, hi);
        if (!r.ok) break;
        lo = hi;
        hi = hi * 2;
    }
    if (hi > MAX_DEPTH) {
        return { label, max_survived: ">= " + MAX_DEPTH, note: "hit_max_depth_cap" };
    }

    while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        const r = await probe(wasmPath, mid);
        if (r.ok) lo = mid;
        else hi = mid;
    }
    return { label, max_survived: lo };
}

const variantPaths = {
    baseline: path.join(OUT_DIR, "chain.baseline.wasm"),
    forkinstr: path.join(OUT_DIR, "chain.forkinstr.wasm"),
};

const results = [];
for (const name of VARIANTS) {
    const wasmPath = variantPaths[name];
    if (!wasmPath) {
        console.error(`unknown variant: ${name}`);
        process.exit(1);
    }
    if (!fs.existsSync(wasmPath)) {
        console.error(`missing wasm: ${wasmPath}  (run ./build.sh first)`);
        process.exit(1);
    }
    process.stderr.write(`sweeping ${name}... `);
    const r = await findMaxDepth(wasmPath, name);
    process.stderr.write(`max_survived=${r.max_survived}\n`);
    results.push(r);
}

console.log(JSON.stringify({ results, node_version: process.version }, null, 2));

const baseline = results.find((r) => r.label === "baseline");
const forkinstr = results.find((r) => r.label === "forkinstr");
if (
    typeof baseline?.max_survived === "number" &&
    typeof forkinstr?.max_survived === "number" &&
    forkinstr.max_survived >= baseline.max_survived
) {
    process.stderr.write(
        `INVARIANT FAILED: forkinstr (${forkinstr.max_survived}) ` +
            `should survive fewer frames than baseline (${baseline.max_survived})\n`,
    );
    process.exit(1);
}
