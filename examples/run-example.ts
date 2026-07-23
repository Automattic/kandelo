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
 *   KERNEL_UID=1000 KERNEL_GID=1000 npx tsx examples/run-example.ts hello
 */

import { closeSync, existsSync, openSync, readFileSync, statSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinaries } from "../host/src/binary-resolver";
import { writeAllSync } from "./run-example-output";
import { isWithinRealDirectory } from "./run-example-paths";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

const MAX_CONFIGURABLE_CREDENTIAL = 0xfffffffe;

function parseKernelCredential(name: "KERNEL_UID" | "KERNEL_GID"): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;

    // u32::MAX is the host/kernel protocol's "leave unchanged" sentinel. If
    // it were accepted here, a request for that ID would silently leave the
    // new process running as root.
    if (!/^[0-9]+$/.test(raw)) {
        throw new Error(
            `${name} must be a decimal integer from 0 to ${MAX_CONFIGURABLE_CREDENTIAL}`,
        );
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > MAX_CONFIGURABLE_CREDENTIAL) {
        throw new Error(
            `${name} must be a decimal integer from 0 to ${MAX_CONFIGURABLE_CREDENTIAL}`,
        );
    }
    return value;
}

interface OptionalBinary {
    readonly relPaths: readonly string[];
    readonly fallback?: string;
}

function optionalBinary(...relPaths: string[]): OptionalBinary {
    return { relPaths };
}

function optionalBinaryWithFallback(fallback: string, ...relPaths: string[]): OptionalBinary {
    return { relPaths, fallback };
}

// These declarations describe optional program sources without probing package
// state at module import time. resolveBuiltinPrograms() checks all package paths
// together after CLI input is validated.
const coreutilsWasm = optionalBinary("programs/coreutils.wasm");
const dashWasm = optionalBinary("programs/dash.wasm");
const grepWasm = optionalBinary("programs/grep.wasm");
const sedWasm = optionalBinary("programs/sed.wasm");
const gitWasm = optionalBinary("programs/git/git.wasm");
const bcWasm = optionalBinary("programs/bc.wasm");
const fileWasm = optionalBinary("programs/file/file.wasm");
const lessWasm = optionalBinary("programs/less.wasm");
const m4Wasm = optionalBinary("programs/m4.wasm");
const makeWasm = optionalBinary("programs/make.wasm");
const tarWasm = optionalBinary("programs/tar.wasm");
const curlWasm = optionalBinary("programs/curl.wasm");
const wgetWasm = optionalBinary("programs/wget.wasm");
const gzipWasm = optionalBinary("programs/gzip.wasm");
const bzip2Wasm = optionalBinary("programs/bzip2.wasm");
const xzWasm = optionalBinary("programs/xz.wasm");
const zstdWasm = optionalBinary("programs/zstd.wasm");
const zipWasm = optionalBinary("programs/zip.wasm");
const unzipWasm = optionalBinary("programs/unzip.wasm");
const nodeWasm = optionalBinary(
    "programs/node.wasm",
    "programs/spidermonkey-node.wasm",
);
const lsofWasm = resolve(repoRoot, "examples/lsof.wasm");
const rubyWasm = optionalBinary("programs/ruby/ruby.wasm");
const vimWasm = optionalBinary("programs/vim.zip");
const gawkWasm = optionalBinary("programs/gawk.wasm");
const findWasm = optionalBinary("programs/findutils/find.wasm");
const xargsWasm = optionalBinary("programs/findutils/xargs.wasm");
const diffWasm = optionalBinary("programs/diffutils/diff.wasm");
const cmpWasm = optionalBinary("programs/diffutils/cmp.wasm");
const sdiffWasm = optionalBinary("programs/diffutils/sdiff.wasm");
const diff3Wasm = optionalBinary("programs/diffutils/diff3.wasm");
const perlWasm = optionalBinary("programs/perl.wasm");
const nanoWasm = optionalBinary("programs/nano.wasm");
const tclshWasm = optionalBinary("programs/tcl.wasm");
const testfixtureBuild = resolve(
    repoRoot,
    "packages/registry/sqlite/bin/testfixture.wasm",
);
const testfixtureWasm = existsSync(testfixtureBuild) ? testfixtureBuild : null;
const mysqltestWasm = optionalBinary("programs/mariadb/mysqltest.wasm");
const echoWasm = optionalBinaryWithFallback(
    resolve(repoRoot, "examples/echo.wasm"),
    "programs/echo.wasm",
);

// GNU coreutils multi-call binary supports all of these as argv[0]
const coreutilsNames = [
    "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
    "head", "tail", "wc", "sort", "uniq", "tr", "cut", "paste", "tee",
    "true", "false", "yes", "env", "printenv", "printf", "expr", "test", "[",
    "basename", "dirname", "readlink", "realpath", "stat", "touch", "date",
    "sleep", "id", "whoami", "uname", "hostname", "pwd", "dd", "od", "md5sum",
    "sha256sum", "base64", "seq", "factor", "nproc", "du", "df",
];

// Static paths and optional package references share this command map. The
// package references become concrete paths or null after the batch lookup.
const builtinProgramSources: Record<string, string | OptionalBinary | null> = {
    "echo": echoWasm,
    "/bin/echo": echoWasm,
    "/usr/bin/echo": echoWasm,
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
    "/bin/gencat": resolve(repoRoot, "examples/gencat.wasm"),
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
    // Node.js-compatible runtime backed by SpiderMonkey.
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
    builtinProgramSources[name] = coreutilsWasm;
    builtinProgramSources[`/bin/${name}`] = coreutilsWasm;
    builtinProgramSources[`/usr/bin/${name}`] = coreutilsWasm;
}

function resolveBuiltinPrograms(): Record<string, string | null> {
    const references = Array.from(new Set(
        Object.values(builtinProgramSources).filter(
            (source): source is OptionalBinary =>
                typeof source === "object" && source !== null,
        ),
    ));
    const relPaths = references.flatMap((reference) => reference.relPaths);

    // A source checkout must prove that its package projection is current
    // before using any cached artifact. Checking this independent optional set
    // as one batch preserves that boundary without paying once per command.
    const resolvedPaths = tryResolveBinaries(relPaths);
    const resolvedByPath = new Map(
        relPaths.map((relPath, index) => [relPath, resolvedPaths[index]]),
    );
    const resolvedByReference = new Map(
        references.map((reference) => [
            reference,
            reference.relPaths
                .map((relPath) => resolvedByPath.get(relPath) ?? null)
                .find((path) => path !== null) ??
                reference.fallback ??
                null,
        ]),
    );

    const programs: Record<string, string | null> = {};
    for (const [name, source] of Object.entries(builtinProgramSources)) {
        programs[name] =
            typeof source === "object" && source !== null
                ? resolvedByReference.get(source) ?? null
                : source;
    }
    return programs;
}

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function tryLoadGuestCandidate(candidate: string, kernelCwd: string): ArrayBuffer | null {
    const resolved = resolve(candidate);
    if (!existsSync(resolved)) return null;

    // Guest exec resolution may read scripts and test binaries staged under
    // KERNEL_CWD. Outside that guest workdir, only explicit .wasm paths are
    // valid candidates; never treat host /usr/bin tools as guest programs.
    try {
        if (!resolved.endsWith(".wasm") &&
            !isWithinRealDirectory(kernelCwd, resolved)) {
            return null;
        }
        if (!statSync(resolved).isFile()) return null;
        return loadBytes(resolved);
    } catch {
        return null;
    }
}

function resolveProgram(
    path: string,
    builtinPrograms: Record<string, string | null>,
): ArrayBuffer | null {
    const mapped = builtinPrograms[path];
    if (mapped) {
        return loadBytes(mapped);
    }
    const kernelCwd = resolve(process.env.KERNEL_CWD || process.cwd());
    const candidates = [
        // Resolve relative to kernel CWD (sortix tests exec themselves by relative path)
        isAbsolute(path) ? path : resolve(kernelCwd, path),
        path.endsWith(".wasm")
            ? (isAbsolute(path) ? path : resolve(kernelCwd, path))
            : (isAbsolute(path) ? `${path}.wasm` : resolve(kernelCwd, `${path}.wasm`)),
        resolve(repoRoot, `examples/${path}.wasm`),
    ];
    for (const c of candidates) {
        const bytes = tryLoadGuestCandidate(c, kernelCwd);
        if (bytes) return bytes;
    }
    return null;
}

function guestEnv(): string[] {
    const kernelPath = process.env.KERNEL_PATH ?? "/usr/local/bin:/usr/bin:/bin";
    const inherited = Object.entries(process.env)
        .filter(([k, v]) =>
            v !== undefined &&
            k !== "PATH" &&
            k !== "KANDELO_GUEST_OUTPUT_FILE"
        )
        .map(([k, v]) => `${k}=${v}`);
    return [...inherited, `PATH=${kernelPath}`];
}

async function main() {
    const name = process.argv[2];
    if (!name) {
        console.error("Usage: npx tsx examples/run-example.ts <name>");
        process.exit(1);
    }
    const uid = parseKernelCredential("KERNEL_UID");
    const gid = parseKernelCredential("KERNEL_GID");
    const builtinPrograms = resolveBuiltinPrograms();

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

    // Conformance runners need guest fd 1 and fd 2 in one ordered stream while
    // keeping host-runtime diagnostics out of expectation comparisons. The
    // explicit file sink preserves callback order without changing the normal
    // CLI behavior or hiding worker diagnostics from the outer process streams.
    const guestOutputPath = process.env.KANDELO_GUEST_OUTPUT_FILE;
    const guestOutputFd = guestOutputPath ? openSync(guestOutputPath, "w") : null;
    const writeGuestOutput = (fallback: NodeJS.WriteStream, data: Uint8Array): void => {
        if (guestOutputFd === null) {
            fallback.write(data);
        } else {
            writeAllSync(guestOutputFd, data);
        }
    };

    let host: NodeKernelHost | undefined;
    let status = 1;
    try {
        host = new NodeKernelHost({
            maxWorkers: 4,
            onStdout: (_pid, data) => writeGuestOutput(process.stdout, data),
            onStderr: (_pid, data) => writeGuestOutput(process.stderr, data),
            onResolveExec: (path) => resolveProgram(path, builtinPrograms),
        });

        await host.init();

        const processArgv = [programPath, ...process.argv.slice(3)];
        const timeoutMs = parseInt(process.env.TIMEOUT || "30000", 10);
        const exitPromise = host.spawn(loadBytes(programPath), processArgv, {
            env: [
                ...guestEnv(),
                ...gitEnv,
            ],
            cwd: process.env.KERNEL_CWD || process.cwd(),
            uid,
            gid,
            stdin: stdinData,
        });
        const timeoutPromise = new Promise<number>((_, reject) => {
            setTimeout(() => reject(new Error("Process timed out")), timeoutMs);
        });

        status = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
        await host?.destroy().catch(() => {});
        if (guestOutputFd !== null) closeSync(guestOutputFd);
    }

    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
