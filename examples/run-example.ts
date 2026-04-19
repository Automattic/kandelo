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

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

// Built-in program resolution
const coreutilsWasm = resolve(repoRoot, "examples/libs/coreutils/bin/coreutils.wasm");
const dashBuilt = resolve(repoRoot, "examples/libs/dash/bin/dash.wasm");
const dashWasm = existsSync(dashBuilt) ? dashBuilt : resolve(repoRoot, "host/wasm/sh.wasm");
const grepWasm = resolve(repoRoot, "examples/libs/grep/bin/grep.wasm");
const sedWasm = resolve(repoRoot, "examples/libs/sed/bin/sed.wasm");
const gitWasm = resolve(repoRoot, "examples/libs/git/bin/git.wasm");
const bcWasm = resolve(repoRoot, "examples/libs/bc/bin/bc.wasm");
const fileWasm = resolve(repoRoot, "examples/libs/file/bin/file.wasm");
const lessWasm = resolve(repoRoot, "examples/libs/less/bin/less.wasm");
const m4Wasm = resolve(repoRoot, "examples/libs/m4/bin/m4.wasm");
const makeWasm = resolve(repoRoot, "examples/libs/make/bin/make.wasm");
const tarWasm = resolve(repoRoot, "examples/libs/tar/bin/tar.wasm");
const curlWasm = resolve(repoRoot, "examples/libs/curl/bin/curl.wasm");
const wgetWasm = resolve(repoRoot, "examples/libs/wget/bin/wget.wasm");
const gzipWasm = resolve(repoRoot, "examples/libs/gzip/bin/gzip.wasm");
const bzip2Wasm = resolve(repoRoot, "examples/libs/bzip2/bin/bzip2.wasm");
const xzWasm = resolve(repoRoot, "examples/libs/xz/bin/xz.wasm");
const zstdWasm = resolve(repoRoot, "examples/libs/zstd/bin/zstd.wasm");
const zipWasm = resolve(repoRoot, "examples/libs/zip/bin/zip.wasm");
const unzipWasm = resolve(repoRoot, "examples/libs/unzip/bin/unzip.wasm");
const qjsWasm = resolve(repoRoot, "examples/libs/quickjs/bin/qjs.wasm");
const nodeWasm = resolve(repoRoot, "examples/libs/quickjs/bin/node.wasm");
const lsofWasm = resolve(repoRoot, "examples/lsof.wasm");
const rubyWasm = resolve(repoRoot, "examples/libs/ruby/bin/ruby.wasm");
const vimWasm = resolve(repoRoot, "examples/libs/vim/bin/vim.wasm");
const gawkWasm = resolve(repoRoot, "examples/libs/gawk/bin/gawk.wasm");
const findWasm = resolve(repoRoot, "examples/libs/findutils/bin/find.wasm");
const xargsWasm = resolve(repoRoot, "examples/libs/findutils/bin/xargs.wasm");
const diffWasm = resolve(repoRoot, "examples/libs/diffutils/bin/diff.wasm");
const cmpWasm = resolve(repoRoot, "examples/libs/diffutils/bin/cmp.wasm");
const sdiffWasm = resolve(repoRoot, "examples/libs/diffutils/bin/sdiff.wasm");
const diff3Wasm = resolve(repoRoot, "examples/libs/diffutils/bin/diff3.wasm");
const perlWasm = resolve(repoRoot, "examples/libs/perl/bin/perl.wasm");
const nanoWasm = resolve(repoRoot, "examples/libs/nano/bin/nano.wasm");
const tclshWasm = resolve(repoRoot, "examples/libs/tcl/bin/tclsh.wasm");
const testfixtureWasm = resolve(repoRoot, "examples/libs/sqlite/bin/testfixture.wasm");
const mysqltestWasm = resolve(repoRoot, "examples/libs/mariadb/mariadb-install/bin/mysqltest.wasm");

// GNU coreutils multi-call binary supports all of these as argv[0]
const coreutilsNames = [
    "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
    "head", "tail", "wc", "sort", "uniq", "tr", "cut", "paste", "tee",
    "true", "false", "yes", "env", "printenv", "printf", "expr", "test", "[",
    "basename", "dirname", "readlink", "realpath", "stat", "touch", "date",
    "sleep", "id", "whoami", "uname", "hostname", "pwd", "dd", "od", "md5sum",
    "sha256sum", "base64", "seq", "factor", "nproc", "du", "df",
];

const builtinPrograms: Record<string, string> = {
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
    if (mapped && existsSync(mapped)) {
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
    } else if (builtinPrograms[name] && existsSync(builtinPrograms[name])) {
        programPath = builtinPrograms[name];
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
