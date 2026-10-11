import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixtureDir = resolve(here, "../../../.context/go-browser");
const browserKernelModulePath = resolve(repoRoot, "host/src/browser-kernel-host.ts");

type ProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  hostDiagnostics: unknown[];
};

type Probe = {
  name: string;
  file: string;
  argv: string[];
  stdout: string[];
  absentStdout?: string[];
  directories?: string[];
  imageCapacity?: number;
  threadMarkers?: number;
  env?: string[];
  dataFiles?: { path: string; data: number[] }[] | (() => { path: string; data: number[] }[]);
  selfExecPath?: string;
  launchFromVfs?: boolean;
  cwd?: string;
  executableFiles?: { path: string; file: string }[];
  passedTopLevelTests?: number;
};

const probes: Probe[] = [
  {
    name: "Go reports kernel-owned credentials and supplementary groups",
    file: "credentials-basic.wasm",
    argv: ["go-credentials-basic"],
    stdout: ["GO CREDENTIALS PASS"],
  },
  {
    name: "stdlib, startup metadata, and file syscalls",
    file: "basic.wasm",
    argv: ["go-basic", "alpha", "beta"],
    stdout: ["GO BASIC PASS"],
    env: ["KANDELO_GO_BROWSER=present"],
    dataFiles: [{
      path: "/etc/go-browser-input",
      data: Array.from(Buffer.from("browser fixture\n")),
    }],
  },
  {
    name: "Go account and supplementary-group lookup from VFS files",
    file: "user-basic.wasm",
    argv: ["go-user-basic"],
    stdout: ["GO USER PASS"],
    dataFiles: [
      {
        path: "/etc/passwd",
        data: Array.from(Buffer.from(
          "root:x:0:0:Root:/root:/bin/sh\ndaemon:x:1:1:Daemon:/home/daemon:/bin/sh\nrunner:x:1001:200:Runner:/home/runner:/bin/sh\n",
        )),
      },
      {
        path: "/etc/group",
        data: Array.from(Buffer.from("staff:x:200:runner\nworkers:x:201:runner\n")),
      },
    ],
  },
  {
    name: "Go cgo build retains VFS-backed account and group lookup",
    file: "user-cgo-basic.wasm",
    argv: ["go-user-cgo-basic"],
    stdout: ["GO USER PASS"],
    dataFiles: [
      {
        path: "/etc/passwd",
        data: Array.from(Buffer.from(
          "root:x:0:0:Root:/root:/bin/sh\ndaemon:x:1:1:Daemon:/home/daemon:/bin/sh\nrunner:x:1001:200:Runner:/home/runner:/bin/sh\n",
        )),
      },
      {
        path: "/etc/group",
        data: Array.from(Buffer.from("staff:x:200:runner\nworkers:x:201:runner\n")),
      },
    ],
  },
  {
    name: "upstream Go os/user full pure-Go suite",
    file: "user-test.wasm",
    argv: ["go-user-test", "-test.run=^Test", "-test.v"],
    stdout: ["PASS"],
    passedTopLevelTests: 12,
    dataFiles: [
      { path: "/etc/passwd", data: Array.from(Buffer.from("root:x:0:0:Root:/root:/bin/sh\ndaemon:x:1:1:Daemon:/home/daemon:/bin/sh\nrunner:x:1001:200:Runner:/home/runner:/bin/sh\n")) },
      { path: "/etc/group", data: Array.from(Buffer.from("root:x:0:\nstaff:x:200:runner\nworkers:x:201:runner\n")) },
    ],
  },
  {
    name: "upstream Go os file and directory tests",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^(TestStat|TestStatError|TestReadClosed|TestReadAt|TestReadAtOffset|TestReadAtNegativeOffset|TestOpenError|TestReaddirNValues|TestReaddirOfFile|TestChmod|TestOpenFileKeepsPermissions|TestChown|TestFileChown|TestLchown|TestReadFile|TestWriteFile|TestReadDir|TestMkdirAll|TestRemoveAll|TestSymlink|TestRename|TestCreateTemp|TestMkdirTemp|TestTruncate|TestDirSeek|TestReaddirSmallSeek|TestSeek|TestSeekError|TestRootOpen_File|TestRootOpen_Directory|TestRootSymlink|TestRootConsistencyMkdirAll|TestRootConsistencyRename|TestRootRemoveDot|TestRootDirFS|TestExpand|TestConsistentEnviron|TestUnsetenv|TestClearenv|TestLookupEnv|TestEnvironConsistency|TestErrIsExist|TestErrIsNotExist|TestIsExist|TestIsPermission|TestErrPathNUL|TestPathErrorUnwrap|TestErrorIsMethods|TestStatSymlinkLoop|TestFstat|TestLstat|TestRead0|TestHardLink|TestLongSymlink|TestRenameOverwriteDest|TestRenameFailed|TestRenameNotExisting|TestRenameToDirFailed|TestFTruncate|TestTruncateNonexistentFile)$", "-test.v"],
    stdout: ["--- PASS: TestOpenError", "--- PASS: TestReaddirNValues", "--- PASS: TestChmod", "--- PASS: TestChown", "--- PASS: TestFileChown", "--- PASS: TestLchown", "--- PASS: TestMkdirAll", "--- PASS: TestRemoveAll", "--- PASS: TestReadFile", "--- PASS: TestReadDir", "--- PASS: TestDirSeek", "--- PASS: TestReaddirSmallSeek", "--- PASS: TestSeek", "--- PASS: TestSeekError", "--- PASS: TestRootOpen_File", "--- PASS: TestRootOpen_Directory", "--- PASS: TestRootSymlink", "--- PASS: TestRootConsistencyMkdirAll", "--- PASS: TestRootConsistencyRename", "--- PASS: TestRootRemoveDot", "--- PASS: TestRootDirFS", "--- PASS: TestExpand", "--- PASS: TestEnvironConsistency", "--- PASS: TestHardLink", "--- PASS: TestFstat", "--- PASS: TestLstat", "--- PASS: TestRenameOverwriteDest", "--- PASS: TestFTruncate", "PASS"],
    directories: ["/tmp", "/exec", "/testdata", "/testdata/issue37161", "/testdata/dirfs", "/testdata/dirfs/dir"],
    imageCapacity: 8 * 1024 * 1024,
    dataFiles: [
      { path: "/etc/group", data: Array.from(Buffer.from("staff:x:200:runner\n")) },
      { path: "/read_test.go", data: Array.from(Buffer.from("package os_test\n")) },
      ...["a", "b", "dir/x"].map((name) => ({
        path: `/testdata/dirfs/${name}`,
        data: [],
      })),
      ...["a", "b", "c"].map((name) => ({
        path: `/testdata/issue37161/${name}`,
        data: Array.from(Buffer.from(`${name}\n`)),
      })),
    ],
  },
  {
    name: "upstream Go os chdir and fchdir preserve cwd",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestChdirAndGetwd$", "-test.v"],
    stdout: ["--- PASS: TestChdirAndGetwd", "PASS"],
    directories: ["/tmp", "/usr", "/usr/bin"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os getwd reaches the declared path limit",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestGetwdDeep", "-test.v"],
    stdout: ["--- PASS: TestGetwdDeep", "--- PASS: TestGetwdDeepWithPWDSet", "PASS"],
    passedTopLevelTests: 2,
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os broken pipe returns EPIPE without killing the process",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestEPIPE$", "-test.v"],
    stdout: ["--- PASS: TestEPIPE", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os pipe close race uses POSIX errno text",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestPipeIOCloseRace$", "-test.v"],
    stdout: ["--- PASS: TestPipeIOCloseRace", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os standard pipe signals and notifications",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestStdPipe$", "-test.v"],
    stdout: ["--- PASS: TestStdPipe", "PASS"],
    directories: ["/tmp"],
    selfExecPath: "/bin/os-test.wasm",
    launchFromVfs: true,
  },
  {
    name: "upstream Go os inherited blocking stdin stays blocking",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestReadNonblockingFd$", "-test.v"],
    stdout: ["--- PASS: TestReadNonblockingFd", "PASS"],
    directories: ["/tmp"],
    selfExecPath: "/bin/os-test.wasm",
    launchFromVfs: true,
  },
  {
    name: "upstream Go syscall dirent and repeat tests",
    file: "syscall-test.wasm",
    argv: ["go-syscall-test", "-test.run=^TestDirent(Repeat)?$", "-test.v"],
    stdout: ["--- PASS: TestDirent", "--- PASS: TestDirentRepeat", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go syscall.Gettimeofday reads kernel time",
    file: "syscall-test.wasm",
    argv: ["go-syscall-test", "-test.run=^TestGettimeofday$", "-test.v"],
    stdout: ["--- PASS: TestGettimeofday", "PASS"],
  },
  {
    name: "upstream Go os.Root Chtimes nanosecond precision",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestRootChtimes$", "-test.v"],
    stdout: ["--- PASS: TestRootChtimes", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os.Root survives directory rename after open",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestRootRenameAfterOpen$", "-test.v"],
    stdout: ["--- PASS: TestRootRenameAfterOpen", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os.Root links symlink inodes",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestRootLinkFrom$", "-test.v"],
    stdout: ["--- PASS: TestRootLinkFrom", "PASS"],
    directories: ["/tmp"],
    imageCapacity: 8 * 1024 * 1024,
  },
  {
    name: "upstream Go os.Root complete sweep",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestRoot", "-test.v"],
    stdout: ["--- PASS: TestRootLinkFrom", "--- PASS: TestRootRenameAfterOpen", "PASS"],
    passedTopLevelTests: 47,
    directories: ["/tmp", "/testdata", "/testdata/dirfs", "/testdata/dirfs/dir"],
    imageCapacity: 8 * 1024 * 1024,
    dataFiles: ["a", "b", "dir/x"].map((name) => ({
      path: `/testdata/dirfs/${name}`,
      data: [],
    })),
  },
  {
    name: "upstream Go os.Executable ignores forged argv",
    file: "os-test.wasm",
    argv: ["forged-display-name", "-test.run=^TestExecutable$", "-test.v"],
    stdout: ["--- PASS: TestExecutable", "PASS"],
    directories: ["/tmp"],
    selfExecPath: "/bin/os-test.wasm",
    launchFromVfs: true,
  },
  {
    name: "upstream Go os.Executable resolves child cwd before spawn",
    file: "os-test.wasm",
    argv: ["forged-display-name", "-test.run=^TestExecutable$", "-test.v"],
    stdout: ["--- PASS: TestExecutable", "PASS"],
    directories: ["/tmp", "/work"],
    selfExecPath: "/bin/os-test.wasm",
    launchFromVfs: true,
    cwd: "/work",
  },
  {
    name: "upstream Go os.StartProcess finds and runs pwd",
    file: "os-test.wasm",
    argv: ["go-os-test", "-test.run=^TestStartProcess$", "-test.v"],
    stdout: ["--- PASS: TestStartProcess", "--- PASS: TestStartProcess/relative", "PASS"],
    directories: ["/tmp", "/work"],
    selfExecPath: "/bin/os-test.wasm",
    executableFiles: [{ path: "/bin/pwd", file: "os-pwd.wasm" }],
    launchFromVfs: true,
    cwd: "/work",
    env: ["PATH=/bin:/usr/bin"],
    imageCapacity: 16 * 1024 * 1024,
  },
  {
    name: "upstream Go os/exec process and lookup tests",
    file: "os-exec-test.wasm",
    argv: ["go-os-exec-test", "-test.run=^(TestEcho|TestCatStdin|TestExitCode|TestPipes|TestLookPath|TestNoExistExecutable)$", "-test.short", "-test.parallel=1", "-test.v"],
    stdout: ["--- PASS: TestEcho", "--- PASS: TestPipes", "--- PASS: TestLookPath", "PASS"],
    directories: ["/tmp", "/work"],
    selfExecPath: "/bin/os-exec-test.wasm",
    launchFromVfs: true,
    cwd: "/work",
    env: ["PATH=/bin:/usr/bin"],
    passedTopLevelTests: 6,
  },
  {
    name: "upstream Go os/exec Unix path and wait tests",
    file: "os-exec-test.wasm",
    argv: ["go-os-exec-test", "-test.run=^(TestImplicitPWD|TestExplicitPWD|TestLookPathUnixEmptyPath|TestWaitid|TestSIGCHLD)$", "-test.short", "-test.parallel=1", "-test.v"],
    stdout: ["--- PASS: TestImplicitPWD", "--- PASS: TestWaitid", "--- PASS: TestSIGCHLD", "PASS"],
    directories: ["/tmp", "/work"],
    selfExecPath: "/bin/os-exec-test.wasm",
    launchFromVfs: true,
    cwd: "/work",
    env: ["PATH=/bin:/usr/bin"],
    passedTopLevelTests: 5,
  },
  {
    name: "upstream Go archive/tar complete suite",
    file: "tar-test.wasm",
    argv: ["go-tar-test", "-test.run=^Test", "-test.v"],
    stdout: ["--- PASS: TestKandeloFileInfoHeader", "PASS"],
    directories: ["/tmp", "/testdata"],
    imageCapacity: 16 * 1024 * 1024,
    dataFiles: () => readdirSync(resolve(repoRoot, "../go-kandelo/src/archive/tar/testdata")).map((name) => ({
      path: `/testdata/${name}`,
      data: Array.from(readFileSync(resolve(repoRoot, "../go-kandelo/src/archive/tar/testdata", name))),
    })),
  },
  {
    name: "Sortix spawn preflight honors fchdir file actions",
    file: "spawn-fchdir.wasm",
    argv: ["posix_spawn_file_actions_addfchdir"],
    stdout: [],
    directories: ["/work", "/work/spawn"],
    selfExecPath: "/work/spawn/posix_spawn_file_actions_addfchdir",
    launchFromVfs: true,
    cwd: "/work",
    env: ["PATH=."],
  },
  {
    name: "second-M bootstrap and per-M syscall channel",
    file: "second-m.wasm",
    argv: ["go-second-m"],
    stdout: ["M1: before spawn", "M1: after spawn"],
    threadMarkers: 1,
  },
  {
    name: "five sequential clone handoffs and arena slots",
    file: "clone-handoff.wasm",
    argv: ["go-clone-handoff"],
    stdout: ["M1: before spawn", "M1: after spawn"],
    threadMarkers: 5,
  },
  {
    name: "parallel goroutines on two scheduler Ms",
    file: "scheduler.wasm",
    argv: ["go-scheduler"],
    stdout: ["GOMAXPROCS: 2", "parallel M: complete"],
  },
  {
    name: "concurrent clone handoffs from two scheduler Ms",
    file: "concurrent-clone.wasm",
    argv: ["go-concurrent-clone"],
    stdout: ["parallel clone handoffs: complete"],
    threadMarkers: 4,
  },
  {
    name: "LockOSThread keeps a goroutine on one M until unlock",
    file: "locked-thread.wasm",
    argv: ["go-locked-thread"],
    stdout: ["locked worker affinity: complete"],
  },
  {
    name: "locked M exits and reuses thread slots across twelve rounds",
    file: "locked-exit.wasm",
    argv: ["go-locked-exit"],
    stdout: ["locked worker exit and slot reuse: complete"],
  },
  {
    name: "locked M burst churn exceeds the former eight-slot arena",
    file: "locked-exit.wasm",
    argv: ["go-locked-exit", "--burst"],
    stdout: ["locked worker burst exit and slot reuse: complete"],
  },
  {
    name: "sysmon preempts a CPU-bound goroutine for a timer",
    file: "sysmon.wasm",
    argv: ["go-sysmon"],
    stdout: ["sysmon cooperative preemption: complete"],
  },
  {
    name: "Go syscall TCP loopback socket",
    file: "socket-basic.wasm",
    argv: ["go-socket-basic"],
    stdout: ["GO SOCKET PASS"],
  },
  {
    name: "Go runtime TCP readiness and blocking syscall scheduler release",
    file: "netpoll-basic.wasm",
    argv: ["go-netpoll-basic"],
    stdout: ["GO NETPOLL PASS"],
  },
  {
    name: "Go net TCP dial and listener on IPv4 and IPv6",
    file: "net-basic.wasm",
    argv: ["go-net-basic"],
    stdout: ["GO NET PASS"],
  },
  {
    name: "Go HTTP request and response on IPv4 and IPv6",
    file: "http-basic.wasm",
    argv: ["go-http-basic"],
    stdout: ["GO HTTP PASS"],
  },
  {
    name: "Go spawn, wait, and command output through a pipe",
    file: "exec-basic.wasm",
    argv: ["go-exec-basic"],
    stdout: ["GO EXEC CHILD", "GO EXEC PATH PASS", "GO EXEC PASS"],
    selfExecPath: "/bin/go-exec-basic.wasm",
  },
  {
    name: "Go executable identity from a VFS launch",
    file: "exec-basic.wasm",
    argv: ["forged-display-name"],
    env: ["GO_EXPECT_EXE=present"],
    stdout: ["GO EXEC CHILD", "GO EXEC PATH PASS", "GO EXEC PASS"],
    selfExecPath: "/bin/go-exec-basic.wasm",
    launchFromVfs: true,
  },
  {
    name: "process exit from a worker M",
    file: "exit-worker.wasm",
    argv: ["go-exit-worker"],
    stdout: ["worker M: exiting process"],
  },
  {
    name: "Go atomic package short tests",
    file: "atomic-test.wasm",
    argv: ["go-atomic-test", "-test.short"],
    stdout: ["PASS"],
  },
  {
    name: "upstream Go sync full short suite",
    file: "sync-test.wasm",
    argv: ["go-sync-test", `-test.run=${process.env.KANDELO_GO_SYNC_FILTER ?? "^Test"}`, "-test.short", "-test.v"],
    stdout: ["PASS"],
    directories: ["/tmp"],
    selfExecPath: "/bin/sync-test.wasm",
    launchFromVfs: true,
  },
];

if (process.env.KANDELO_GO_CGO_LINK_TESTS === "1") {
  probes.push({
    name: "Go calls linked C code with initialized data",
    file: "../go-c-link-only/combined.wasm",
    argv: ["go-c-data"],
    stdout: ["GO TO C DATA PASS"],
  });
}

if (process.env.KANDELO_GO_HIGH_THREAD_TESTS === "1") {
  probes.push({
    name: "48 concurrent locked Go threads under a declared 64-slot ceiling",
    file: "slot-pressure.wasm",
    argv: ["go-slot-pressure"],
    stdout: ["48 concurrent locked Go threads: complete"],
  });
}

if (process.env.KANDELO_GO_MAX_THREAD_SLOTS_TESTS === "1") {
  const liveThreads = Number(process.env.KANDELO_GO_LIVE_THREAD_COUNT ?? "48");
  if (!Number.isSafeInteger(liveThreads) || liveThreads < 1 || liveThreads > 1023) {
    throw new Error("KANDELO_GO_LIVE_THREAD_COUNT must be an integer from 1 to 1023");
  }
  const rounds = Number(process.env.KANDELO_GO_LIVE_THREAD_ROUNDS ?? "1");
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) {
    throw new Error("KANDELO_GO_LIVE_THREAD_ROUNDS must be an integer from 1 to 50");
  }
  probes.push({
    name: `${liveThreads} concurrent locked Go threads under a declared 1024-slot ceiling${rounds > 1 ? ` over ${rounds} rounds` : ""}`,
    file: "slot-pressure-1024.wasm",
    argv: ["go-slot-pressure-1024", String(liveThreads), String(rounds)],
    stdout: [`${liveThreads} concurrent locked Go threads: complete${rounds > 1 ? ` after ${rounds} rounds` : ""}`],
  });
}

if (process.env.KANDELO_GO_CGO_RUNTIME_TESTS === "1") {
  probes.push({
    name: "mixed-width C pointer struct and by-value cgo call",
    file: "../go-cgo-mixed-struct-instrumented.wasm",
    argv: ["go-cgo-mixed-struct"],
    stdout: ["CGO MIXED STRUCT PASS"],
  });
  probes.push({
    name: "PHP ZTS embed initializes, evaluates, and shuts down in Go cgo",
    file: "../go-php-embed/probe-instrumented.wasm",
    argv: ["go-php-embed"],
    stdout: ["PHP EMBED PASS", "GO PHP EMBED PASS"],
  });
  probes.push({
    name: "cgo links a declared C static archive",
    file: "../go-static-archive/probe-instrumented.wasm",
    argv: ["go-cgo-static-archive"],
    stdout: ["CGO STATIC ARCHIVE PASS"],
  });
  probes.push({
    name: "standard cgo calls C with scalar, pointer, and per-M TLS state",
    file: "../go-c-abs-instrumented.wasm",
    argv: ["go-cgo-basic"],
    env: ["KANDELO_CGO_PROBE=cgo-startup"],
    stdout: ["CGO ABS PASS"],
  });
  probes.push({
    name: "Go-owned M cgo callback yields and calls C again",
    file: "../go-callback-same-instrumented.wasm",
    argv: ["go-cgo-callback"],
    stdout: ["CGO CALLBACK PASS"],
  });
  probes.push({
    name: "C-created pthread callback grows its Go stack",
    file: "../cgo-callback-probe-instrumented.wasm",
    argv: ["go-cgo-pthread-callback"],
    stdout: ["CGO CALLBACK PASS"],
  });
  probes.push({
    name: "Concurrent C pthread callbacks survive Go/C allocation churn",
    file: "../cgo-callback-probe-instrumented.wasm",
    argv: ["go-cgo-pthread-callback", "stress"],
    stdout: ["CGO CALLBACK STRESS PASS"],
  });
  probes.push({
    name: "C constructors run in priority order before Go main",
    file: "../go-constructors-instrumented.wasm",
    argv: ["go-cgo-constructors"],
    stdout: ["CGO CONSTRUCTORS PASS"],
  });
  probes.push({
    name: "C exit dispatches registered handlers from Go/cgo",
    file: "../go-constructors-instrumented.wasm",
    argv: ["go-cgo-constructors", "c-exit"],
    stdout: ["CGO C EXIT HANDLER PASS"],
  });
  probes.push({
    name: "C _exit bypasses registered handlers from Go/cgo",
    file: "../go-constructors-instrumented.wasm",
    argv: ["go-cgo-constructors", "c-immediate-exit"],
    stdout: ["CGO C _EXIT PASS"],
    absentStdout: ["CGO C EXIT HANDLER PASS"],
  });
  for (const { name, mode } of [
    { name: "Go main return bypasses C exit handlers", mode: "go-return" },
    { name: "Go os.Exit bypasses C exit handlers", mode: "go-os-exit" },
  ]) {
    probes.push({
      name,
      file: "../go-constructors-instrumented.wasm",
      argv: ["go-cgo-constructors", mode],
      stdout: ["CGO GO EXIT PASS"],
      absentStdout: ["CGO C EXIT HANDLER PASS"],
    });
  }
}

async function runProbe(page: Page, baseURL: string, probe: Probe): Promise<ProbeResult> {
  const programBytes = readFileSync(resolve(fixtureDir, probe.file));
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const programDigest = readWasmCustomSectionPayload(
    Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
  );
  const kernelDigest = readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  );
  expect(kernelDigest?.length).toBe(32);
  expect(programDigest).toEqual(kernelDigest);
  const programUrl = new URL("/__kandelo_go_probe__.wasm", baseURL).href;
  const kernelUrl = new URL("/__kandelo_go_kernel__.wasm", baseURL).href;
  const imageUrl = new URL("/__kandelo_go_probe__.vfs", baseURL).href;
  const browserKernelUrl = new URL(`/@fs/${browserKernelModulePath}`, baseURL).href;
  await page.route(programUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: programBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: kernelBytes,
  }));
  const imageCapacity = probe.selfExecPath
    ? Math.max(probe.imageCapacity ?? 8 * 1024 * 1024, programBytes.byteLength + 2 * 1024 * 1024)
    : (probe.imageCapacity ?? 2 * 1024 * 1024);
  const image = MemoryFileSystem.create(new SharedArrayBuffer(Math.ceil(imageCapacity / 4) * 4));
  image.mkdir("/etc", 0o755);
  for (const directory of probe.directories ?? []) {
    image.mkdir(directory, 0o777);
  }
  if (probe.selfExecPath) {
    image.mkdir("/bin", 0o755);
    image.createFileWithOwner(probe.selfExecPath, 0o755, 0, 0, new Uint8Array(programBytes));
  }
  for (const executable of probe.executableFiles ?? []) {
    image.createFileWithOwner(
      executable.path, 0o755, 0, 0,
      new Uint8Array(readFileSync(resolve(fixtureDir, executable.file))),
    );
  }
  for (const file of (typeof probe.dataFiles === "function" ? probe.dataFiles() : probe.dataFiles) ?? []) {
    image.createFileWithOwner(file.path, 0o644, 0, 0, new Uint8Array(file.data));
  }
  const vfsImage = await image.saveImage();
  await page.route(imageUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/octet-stream",
    body: Buffer.from(vfsImage),
  }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  return page.evaluate(async ({ programUrl, kernelUrl, imageUrl, browserKernelUrl, argv, env, cwd, launchFromVfs, selfExecPath, traceOutput }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [programResponse, kernelResponse, imageResponse] = await Promise.all([
      fetch(programUrl),
      fetch(kernelUrl),
      fetch(imageUrl),
    ]);
    if (!programResponse.ok || !kernelResponse.ok || !imageResponse.ok) {
      throw new Error(`Go fixture fetch failed: program=${programResponse.status}, kernel=${kernelResponse.status}, image=${imageResponse.status}`);
    }
    const [programBytes, kernelWasm, vfsImage] = await Promise.all([
      programResponse.arrayBuffer(),
      kernelResponse.arrayBuffer(),
      imageResponse.arrayBuffer(),
    ]);
    if (!WebAssembly.validate(programBytes) || !WebAssembly.validate(kernelWasm)) {
      throw new Error("Go program or kernel is not valid WebAssembly");
    }
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const hostDiagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => {
        const output = decoder.decode(data);
        stdout += output;
        if (traceOutput) console.info(`guest stdout: ${output}`);
      },
      onStderr: (data: Uint8Array) => {
        const output = decoder.decode(data);
        stderr += output;
        if (traceOutput) console.info(`guest stderr: ${output}`);
      },
      onHostDiagnostic: (diagnostic: unknown) => { hostDiagnostics.push(diagnostic); },
    });
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(vfsImage) });
      const exitCode = launchFromVfs
        ? await (await kernel.spawnFromVfs(selfExecPath!, argv, { env, cwd })).exit
        : await kernel.spawn(programBytes, argv, { env, cwd });
      return { exitCode, stdout, stderr, hostDiagnostics };
    } finally {
      await kernel.destroy();
    }
  }, {
    programUrl,
    kernelUrl,
    imageUrl,
    browserKernelUrl,
    argv: probe.argv,
    env: probe.env,
    cwd: probe.cwd,
    launchFromVfs: probe.launchFromVfs,
    selfExecPath: probe.selfExecPath,
    traceOutput: process.env.KANDELO_GO_TRACE_TESTS === "1",
  });
}

test.describe("native Go port milestones", () => {
  test.skip(
    process.env.KANDELO_GO_BROWSER_TESTS !== "1",
    "Build the Go fork fixtures and set KANDELO_GO_BROWSER_TESTS=1",
  );

  for (const probe of probes) {
    test(probe.name, async ({ page, baseURL }) => {
      expect(baseURL).toBeTruthy();

      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") {
          runtimeErrors.push(`console: ${message.text()}`);
        }
        if (process.env.KANDELO_GO_TRACE_TESTS === "1") {
          process.stdout.write(`${message.text()}\n`);
        }
      });

      const result = await runProbe(page, baseURL!, probe);
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      for (const marker of probe.stdout) {
        expect(result.stdout).toContain(marker);
      }
      if (probe.passedTopLevelTests !== undefined) {
        expect(result.stdout.match(/^--- PASS: /gm) ?? []).toHaveLength(
          probe.passedTopLevelTests,
        );
      }
      for (const marker of probe.absentStdout ?? []) {
        expect(result.stdout).not.toContain(marker);
      }
      if (probe.threadMarkers !== undefined) {
        expect(result.stderr.match(/M2 alive via kernel_clone/g) ?? []).toHaveLength(
          probe.threadMarkers,
        );
        expect(result.stderr.replaceAll("M2 alive via kernel_clone\n", "")).toBe("");
      } else {
        expect(result.stderr).toBe("");
      }
      expect(result.hostDiagnostics).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    });
  }

  test("Go thread-slot ceiling reports exhaustion", async ({ page, baseURL }) => {
    expect(baseURL).toBeTruthy();
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    const result = await runProbe(page, baseURL!, {
      name: "one-slot ceiling",
      file: "one-slot-second-m.wasm",
      argv: ["go-one-slot-second-m"],
      stdout: [],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("newosproc: kernel_clone failed");
    expect(JSON.stringify(result.hostDiagnostics)).toContain("pthread slot limit exhausted (limit=1");
    expect(runtimeErrors).toEqual([]);
  });
});
