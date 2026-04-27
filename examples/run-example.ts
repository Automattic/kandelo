/**
 * run-example.ts — Run any compiled .wasm example on the kernel.
 *
 * Uses NodeKernelHost which spawns the kernel in a dedicated worker_thread
 * for optimal syscall throughput.
 *
 * Usage:
 *   npx tsx examples/run-example.ts <name>
 *
 * Example:
 *   npx tsx examples/run-example.ts hello
 *   npx tsx examples/run-example.ts /path/to/test.wasm
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

// Built-in program resolution via the binary-resolver. Resolver returns
// null for programs that aren't fetched or locally built; callers that
// need the path must handle null explicitly.
const coreutilsWasm = tryResolveBinary("programs/coreutils.wasm");
const dashWasm = tryResolveBinary("programs/dash.wasm");
const grepWasm = tryResolveBinary("programs/grep.wasm");
const sedWasm = tryResolveBinary("programs/sed.wasm");
const gitWasm = tryResolveBinary("programs/git/git.wasm");
const bcWasm = tryResolveBinary("programs/bc.wasm");
const fileWasm = tryResolveBinary("programs/file.wasm");
const lessWasm = tryResolveBinary("programs/less.wasm");
const m4Wasm = tryResolveBinary("programs/m4.wasm");
const makeWasm = tryResolveBinary("programs/make.wasm");
const tarWasm = tryResolveBinary("programs/tar.wasm");
const curlWasm = tryResolveBinary("programs/curl.wasm");
const wgetWasm = tryResolveBinary("programs/wget.wasm");
const gzipWasm = tryResolveBinary("programs/gzip.wasm");
const bzip2Wasm = tryResolveBinary("programs/bzip2.wasm");
const xzWasm = tryResolveBinary("programs/xz.wasm");
const zstdWasm = tryResolveBinary("programs/zstd.wasm");
const zipWasm = tryResolveBinary("programs/zip.wasm");
const unzipWasm = tryResolveBinary("programs/unzip.wasm");
const qjsWasm = tryResolveBinary("programs/quickjs/qjs.wasm");
const nodeWasm = tryResolveBinary("programs/quickjs/node.wasm");
const lsofWasm = resolve(repoRoot, "examples/lsof.wasm");
const rubyWasm = tryResolveBinary("programs/ruby.wasm");
const vimWasm = tryResolveBinary("programs/vim.zip");
const gawkWasm = tryResolveBinary("programs/gawk.wasm");
const findWasm = tryResolveBinary("programs/findutils/find.wasm");
const xargsWasm = tryResolveBinary("programs/findutils/xargs.wasm");
const diffWasm = tryResolveBinary("programs/diffutils/diff.wasm");
const cmpWasm = tryResolveBinary("programs/diffutils/cmp.wasm");
const sdiffWasm = tryResolveBinary("programs/diffutils/sdiff.wasm");
const diff3Wasm = tryResolveBinary("programs/diffutils/diff3.wasm");
const perlWasm = tryResolveBinary("programs/perl.wasm");
const nanoWasm = tryResolveBinary("programs/nano.wasm");
const tclshWasm = tryResolveBinary("programs/tcl.wasm");
const testfixtureWasm = tryResolveBinary("programs/sqlite/testfixture.wasm");
const mysqltestWasm = tryResolveBinary("programs/mariadb/mysqltest.wasm");

// GNU coreutils multi-call binary supports all of these as argv[0]
const coreutilsNames = [
    "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
    "head", "tail", "wc", "sort", "uniq", "tr", "cut", "paste", "tee",
    "true", "false", "yes", "env", "printenv", "printf", "expr", "test", "[",
    "basename", "dirname", "readlink", "realpath", "stat", "touch", "date",
    "sleep", "id", "whoami", "uname", "hostname", "pwd", "dd", "od", "md5sum",
    "sha256sum", "base64", "seq", "factor", "nproc", "du", "df",
];

// Values may be null when a program isn't fetched/built locally.
// Consumers filter out null entries before use.
const builtinPrograms: Record<string, string | null> = {
    "echo": resolve(repoRoot, "examples/echo.wasm"),
    "/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "/usr/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "sh": dashWasm,
    "/bin/sh": dashWasm,
    "dash": dashWasm,
    "/bin/dash": dashWasm,
    "grep": grepWasm,
    "/bin/grep": grepWasm,
    "/usr/bin/grep": grepWasm,
    "egrep": grepWasm,
    "/bin/egrep": grepWasm,
    "/usr/bin/egrep": grepWasm,
    "fgrep": grepWasm,
    "/bin/fgrep": grepWasm,
    "/usr/bin/fgrep": grepWasm,
    "sed": sedWasm,
    "/bin/sed": sedWasm,
    "/usr/bin/sed": sedWasm,
    "gencat": resolve(repoRoot, "examples/gencat.wasm"),
    "/usr/bin/gencat": resolve(repoRoot, "examples/gencat.wasm"),
    "git": gitWasm,
    "/usr/bin/git": gitWasm,
    "/bin/git": gitWasm,
    "bc": bcWasm,
    "/usr/bin/bc": bcWasm,
    "/bin/bc": bcWasm,
    "file": fileWasm,
    "/usr/bin/file": fileWasm,
    "/bin/file": fileWasm,
    "less": lessWasm,
    "/usr/bin/less": lessWasm,
    "/bin/less": lessWasm,
    "m4": m4Wasm,
    "/usr/bin/m4": m4Wasm,
    "/bin/m4": m4Wasm,
    "make": makeWasm,
    "/usr/bin/make": makeWasm,
    "/bin/make": makeWasm,
    "tar": tarWasm,
    "/usr/bin/tar": tarWasm,
    "/bin/tar": tarWasm,
    "curl": curlWasm,
    "/usr/bin/curl": curlWasm,
    "/bin/curl": curlWasm,
    "wget": wgetWasm,
    "/usr/bin/wget": wgetWasm,
    "/bin/wget": wgetWasm,
    "gzip": gzipWasm,
    "/usr/bin/gzip": gzipWasm,
    "/bin/gzip": gzipWasm,
    "gunzip": gzipWasm,
    "/usr/bin/gunzip": gzipWasm,
    "/bin/gunzip": gzipWasm,
    "zcat": gzipWasm,
    "/usr/bin/zcat": gzipWasm,
    "/bin/zcat": gzipWasm,
    "bzip2": bzip2Wasm,
    "/usr/bin/bzip2": bzip2Wasm,
    "/bin/bzip2": bzip2Wasm,
    "bunzip2": bzip2Wasm,
    "/usr/bin/bunzip2": bzip2Wasm,
    "/bin/bunzip2": bzip2Wasm,
    "bzcat": bzip2Wasm,
    "/usr/bin/bzcat": bzip2Wasm,
    "/bin/bzcat": bzip2Wasm,
    "xz": xzWasm,
    "/usr/bin/xz": xzWasm,
    "/bin/xz": xzWasm,
    "unxz": xzWasm,
    "/usr/bin/unxz": xzWasm,
    "/bin/unxz": xzWasm,
    "xzcat": xzWasm,
    "/usr/bin/xzcat": xzWasm,
    "/bin/xzcat": xzWasm,
    "lzma": xzWasm,
    "/usr/bin/lzma": xzWasm,
    "/bin/lzma": xzWasm,
    "unlzma": xzWasm,
    "/usr/bin/unlzma": xzWasm,
    "/bin/unlzma": xzWasm,
    "lzcat": xzWasm,
    "/usr/bin/lzcat": xzWasm,
    "/bin/lzcat": xzWasm,
    "zstd": zstdWasm,
    "/usr/bin/zstd": zstdWasm,
    "/bin/zstd": zstdWasm,
    "unzstd": zstdWasm,
    "/usr/bin/unzstd": zstdWasm,
    "/bin/unzstd": zstdWasm,
    "zstdcat": zstdWasm,
    "/usr/bin/zstdcat": zstdWasm,
    "/bin/zstdcat": zstdWasm,
    "zip": zipWasm,
    "/usr/bin/zip": zipWasm,
    "/bin/zip": zipWasm,
    "unzip": unzipWasm,
    "/usr/bin/unzip": unzipWasm,
    "/bin/unzip": unzipWasm,
    "zipinfo": unzipWasm,
    "/usr/bin/zipinfo": unzipWasm,
    "/bin/zipinfo": unzipWasm,
    "funzip": unzipWasm,
    "/usr/bin/funzip": unzipWasm,
    "/bin/funzip": unzipWasm,
    // QuickJS-NG JavaScript interpreter
    "qjs": qjsWasm,
    "/usr/bin/qjs": qjsWasm,
    "/bin/qjs": qjsWasm,
    // Node.js-compatible runtime (QuickJS-NG with Node.js API compat layer)
    "node": nodeWasm,
    "/usr/bin/node": nodeWasm,
    "/bin/node": nodeWasm,
    "/usr/local/bin/node": nodeWasm,
    "lsof": lsofWasm,
    "/usr/bin/lsof": lsofWasm,
    "/bin/lsof": lsofWasm,
    "ruby": rubyWasm,
    "/usr/bin/ruby": rubyWasm,
    "/bin/ruby": rubyWasm,
    "vim": vimWasm,
    "/usr/bin/vim": vimWasm,
    "/bin/vim": vimWasm,
    "vi": vimWasm,
    "/usr/bin/vi": vimWasm,
    "/bin/vi": vimWasm,
    "gawk": gawkWasm,
    "/bin/gawk": gawkWasm,
    "/usr/bin/gawk": gawkWasm,
    "awk": gawkWasm,
    "/bin/awk": gawkWasm,
    "/usr/bin/awk": gawkWasm,
    "find": findWasm,
    "/bin/find": findWasm,
    "/usr/bin/find": findWasm,
    "xargs": xargsWasm,
    "/bin/xargs": xargsWasm,
    "/usr/bin/xargs": xargsWasm,
    "diff": diffWasm,
    "/bin/diff": diffWasm,
    "/usr/bin/diff": diffWasm,
    "cmp": cmpWasm,
    "/bin/cmp": cmpWasm,
    "/usr/bin/cmp": cmpWasm,
    "sdiff": sdiffWasm,
    "/bin/sdiff": sdiffWasm,
    "/usr/bin/sdiff": sdiffWasm,
    "diff3": diff3Wasm,
    "/bin/diff3": diff3Wasm,
    "/usr/bin/diff3": diff3Wasm,
    "perl": perlWasm,
    "/usr/bin/perl": perlWasm,
    "/bin/perl": perlWasm,
    "nano": nanoWasm,
    "/usr/bin/nano": nanoWasm,
    "/bin/nano": nanoWasm,
    "tclsh": tclshWasm,
    "tclsh8.6": tclshWasm,
    "/usr/bin/tclsh": tclshWasm,
    "/usr/bin/tclsh8.6": tclshWasm,
    "/bin/tclsh": tclshWasm,
    "/bin/tclsh8.6": tclshWasm,
    "testfixture": testfixtureWasm,
    "/usr/bin/testfixture": testfixtureWasm,
    "/bin/testfixture": testfixtureWasm,
    "mysqltest": mysqltestWasm,
    "/usr/bin/mysqltest": mysqltestWasm,
    "/bin/mysqltest": mysqltestWasm,
};

// Add coreutils mappings for all known tool names
for (const name of coreutilsNames) {
    builtinPrograms[name] = coreutilsWasm;
    builtinPrograms[`/bin/${name}`] = coreutilsWasm;
    builtinPrograms[`/usr/bin/${name}`] = coreutilsWasm;
}

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolveProgram(path: string): ArrayBuffer | null {
    const mapped = builtinPrograms[path];
    if (mapped) {
        return loadBytes(mapped);
    }
    const kernelCwd = process.env.KERNEL_CWD || process.cwd();
    const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(repoRoot, `examples/${path}.wasm`),
        // Resolve relative to kernel CWD (sortix tests exec themselves by relative path)
        resolve(kernelCwd, path),
        resolve(kernelCwd, path.endsWith(".wasm") ? path : `${path}.wasm`),
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            return loadBytes(c);
        }
    }
    return null;
}

async function main() {
    const name = process.argv[2];
    if (!name) {
        console.error("Usage: npx tsx examples/run-example.ts <name>");
        process.exit(1);
    }

    let programPath: string;
    if (name.endsWith(".wasm")) {
        programPath = resolve(name);
    } else if (builtinPrograms[name]) {
        programPath = builtinPrograms[name]!;
    } else {
        programPath = resolve(`examples/${name}.wasm`);
    }

    // Git system config via environment (Node.js VFS is the host filesystem,
    // so we can't write /etc/gitconfig; use GIT_CONFIG_COUNT instead).
    const gitConfigEntries: [string, string][] = [
        ["gc.auto", "0"],
        ["maintenance.auto", "false"],
        ["core.pager", "cat"],
        ["user.name", "User"],
        ["user.email", "user@wasm.local"],
        ["init.defaultBranch", "main"],
    ];
    const gitEnv: string[] = [
        "GIT_CONFIG_NOSYSTEM=1",
        `GIT_CONFIG_COUNT=${gitConfigEntries.length}`,
        ...gitConfigEntries.flatMap(([key, val], i) => [
            `GIT_CONFIG_KEY_${i}=${key}`,
            `GIT_CONFIG_VALUE_${i}=${val}`,
        ]),
    ];

    // When stdin is not a terminal (piped or redirected), read all piped
    // data and set it as finite stdin so reads get the data then EOF.
    let stdinData: Uint8Array | undefined;
    if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        stdinData = new Uint8Array(Buffer.concat(chunks));
    }

    const host = new NodeKernelHost({
        maxWorkers: 4,
        onStdout: (_pid, data) => process.stdout.write(data),
        onStderr: (_pid, data) => process.stderr.write(data),
        onResolveExec: (path) => resolveProgram(path),
    });

    await host.init();

    const processArgv = [programPath, ...process.argv.slice(3)];

    const timeoutMs = parseInt(process.env.TIMEOUT || "30000", 10);
    const exitPromise = host.spawn(loadBytes(programPath), processArgv, {
        env: [
            ...Object.entries(process.env)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`),
            ...gitEnv,
        ],
        cwd: process.env.KERNEL_CWD || process.cwd(),
        stdin: stdinData,
    });

    const timeoutPromise = new Promise<number>((_, reject) => {
        setTimeout(() => reject(new Error("Process timed out")), timeoutMs);
    });

    try {
        const status = await Promise.race([exitPromise, timeoutPromise]);
        await host.destroy().catch(() => {});
        process.exit(status);
    } catch (e) {
        await host.destroy().catch(() => {});
        throw e;
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
