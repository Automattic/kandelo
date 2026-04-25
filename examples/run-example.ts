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

/**
 * Active /work → host-dir mapping when KERNEL_CWD was auto-mounted. Set by
 * main() before the kernel starts so resolveProgram can translate VFS
 * paths like /work/unistd/execv back to the real host file.
 */
let activeWorkMount: { vfsPath: string; hostPath: string } | null = null;

function resolveProgram(path: string): ArrayBuffer | null {
    const mapped = builtinPrograms[path];
    if (mapped && existsSync(mapped)) {
        return loadBytes(mapped);
    }
    // Translate /work/* (the auto-mount) to its host path so loadBytes
    // can read the real file. Without this, exec of a VFS path like
    // /work/unistd/execv sees the literal host path /work/... which
    // doesn't exist.
    let translated = path;
    if (activeWorkMount && path.startsWith(activeWorkMount.vfsPath + "/")) {
        translated = activeWorkMount.hostPath + path.slice(activeWorkMount.vfsPath.length);
    } else if (activeWorkMount && path === activeWorkMount.vfsPath) {
        translated = activeWorkMount.hostPath;
    }
    const kernelCwd = process.env.KERNEL_CWD || process.cwd();
    const candidates = [
        translated,
        translated.endsWith(".wasm") ? translated : `${translated}.wasm`,
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

    // If KERNEL_CWD is an absolute host path that isn't already a VFS
    // path (e.g., the sortix runner sets KERNEL_CWD to a per-suite
    // scratch dir under os.tmpdir() containing symlinked test binaries),
    // auto-mount it at /work and translate cwd. The kernel still sees a
    // VFS path; the host files are reachable through the HostDirBackend.
    //
    // The list below must match DEFAULT_MOUNT_SPEC's mount points
    // exactly. A path like /var/folders/.../T (macOS tmpdir) must NOT
    // match the /var prefix since /var itself isn't mounted — only
    // /var/tmp, /var/log, /var/run are.
    const rawCwd = process.env.KERNEL_CWD || process.cwd();
    const VFS_MOUNTS = [
        "/etc",
        "/tmp",
        "/var/tmp",
        "/var/log",
        "/var/run",
        "/home/user",
        "/root",
        "/srv",
    ];
    const isVfsPath =
        rawCwd === "/" ||
        VFS_MOUNTS.some((m) => rawCwd === m || rawCwd.startsWith(m + "/"));
    // When auto-mounting, bind the PARENT of rawCwd to /work instead of
    // rawCwd itself. This lets tests that open(".." + path) see the
    // sibling directories — sortix stages all suites under a common
    // parent, and its fstatat/faccessat tests do open("..") then
    // lookup "${suite}/${test}.c" relative to that fd.
    let extraMounts: { vfsPath: string; hostPath: string }[] | undefined;
    let kernelCwd: string;
    if (isVfsPath || !rawCwd.startsWith("/")) {
        extraMounts = undefined;
        kernelCwd = isVfsPath ? rawCwd : "/work";
    } else {
        // rawCwd is an absolute host path. Split off the parent so
        // cwd-relative ".." works.
        const lastSlash = rawCwd.lastIndexOf("/");
        const parent = lastSlash > 0 ? rawCwd.slice(0, lastSlash) : "/";
        const base = rawCwd.slice(lastSlash + 1);
        extraMounts = [{ vfsPath: "/work", hostPath: parent }];
        kernelCwd = base ? `/work/${base}` : "/work";
    }
    activeWorkMount = extraMounts ? extraMounts[0] : null;

    const host = new NodeKernelHost({
        maxWorkers: 4,
        onStdout: (_pid, data) => process.stdout.write(data),
        onStderr: (_pid, data) => process.stderr.write(data),
        onResolveExec: (path) => resolveProgram(path),
        extraMounts,
    });

    await host.init();

    const processArgv = [programPath, ...process.argv.slice(3)];

    const timeoutMs = parseInt(process.env.TIMEOUT || "30000", 10);
    // The kernel runs on a virtualized filesystem — host paths leaking
    // through env vars (e.g. macOS TMPDIR=/var/folders/...) point at
    // nothing inside the VFS. Override a handful of path-bearing env
    // vars with their VFS equivalents before forwarding.
    const hostEnv = { ...process.env };
    hostEnv.TMPDIR = "/tmp";
    hostEnv.TMP = "/tmp";
    hostEnv.TEMP = "/tmp";
    hostEnv.HOME = hostEnv.HOME && hostEnv.HOME.startsWith("/home/") ? hostEnv.HOME : "/home/user";
    // If we auto-mounted KERNEL_CWD at /work, reflect that via PWD too.
    hostEnv.PWD = kernelCwd;

    const exitPromise = host.spawn(loadBytes(programPath), processArgv, {
        env: [
            ...Object.entries(hostEnv)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`),
            ...gitEnv,
        ],
        cwd: kernelCwd,
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
