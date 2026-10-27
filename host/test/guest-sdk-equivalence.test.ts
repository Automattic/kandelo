/**
 * The SDK inside Kandelo builds what the build machine's SDK builds.
 *
 * Both SDKs run one driver (crates/kandelo-cc): natively on the build
 * machine, as a Kandelo program in kandelo-sdk.zip. The guest's clang has the
 * compiler-facts plugin compiled in, and the guest ships the build machine's
 * Binaryen release. So each command below must produce the same bytes in both
 * places: objects, archives, linked programs (with clang's post-link
 * wasm-opt) and fork-capable programs (facts and code hash, no wasm-opt).
 *
 * Both sides compile against the sysroot and glue inside kandelo-sdk.zip: the
 * build machine's side extracts them and points the SDK at them, so the
 * comparison is of the two toolchains, not of two sysroots. The SDK maps
 * both locations to the same stable paths (/usr/src/kandelo-sdk/...).
 *
 * Out of scope: -g builds. DWARF records the compiler's resource directory,
 * which is a different path on each side. Also out of scope: fork
 * instrumentation, because the SDK inside Kandelo has no fork instrumenter
 * yet (docs/sdk-guide.md).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createSourceOnlyBinarySnapshotSession,
  tryResolveBinaries,
} from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { extractZipEntry, parseZipCentralDirectory } from "../src/vfs/zip";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostCc = join(repoRoot, "sdk/bin/wasm32posix-cc");
const hostAr = join(repoRoot, "sdk/bin/wasm32posix-ar");

const utilityNames = ["coreutils", "grep", "sed"];
const artifactNames = [
  "kernel.wasm",
  "programs/wasm32/shell.vfs.zst",
  "programs/wasm32/kandelo-sdk.zip",
  ...utilityNames.map((name) => `programs/wasm32/${name}.wasm`),
];
const sourceOnly = process.env.WASM_POSIX_RESOLUTION_POLICY === "source-only-v1";
const artifacts = sourceOnly
  ? createSourceOnlyBinarySnapshotSession().snapshots(artifactNames, 512 * 1024 * 1024)
    .map((snapshot) => snapshot?.bytes ?? null)
  : tryResolveBinaries(artifactNames).map((path) =>
      path === null ? null : new Uint8Array(readFileSync(path)));
const available = artifacts.every((bytes) => bytes !== null);
if (!available && (sourceOnly || process.env.KANDELO_REQUIRE_GUEST_COMPILER === "1")) {
  throw new Error("Build the current kernel and browser-main-shell product before SDK equivalence");
}

const sources: Record<string, string> = {
  "hello.c": `#include <stdio.h>
#include <assert.h>
static int add(int a, int b) { return a + b; }
int (*volatile op)(int, int) = add;
int main(int argc, char **argv) {
  assert(argc >= 1);
  printf("hello %d %s\\n", op(argc, 2), __FILE__);
  return 0;
}
`,
  "util.c": "int util_value(int x) { return x * 3; }\n",
  "main.c": `#include <stdio.h>
int util_value(int);
int main(void) { printf("%d\\n", util_value(4)); return 0; }
`,
  "fork.c": `#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  pid_t pid = fork();
  if (pid == 0) { printf("child\\n"); _exit(3); }
  int status = 0;
  waitpid(pid, &status, 0);
  printf("parent %d\\n", WEXITSTATUS(status));
  return 0;
}
`,
  "thread.c": `#include <pthread.h>
#include <stdio.h>
static void *run(void *arg) { return arg; }
int main(void) {
  pthread_t t; void *r;
  pthread_create(&t, 0, run, (void *)7);
  pthread_join(t, &r);
  printf("%ld\\n", (long)r);
  return 0;
}
`,
  "lib.c": "int side_value(void) { return 42; }\n",
  "io.cpp": `#include <iostream>
#include <vector>
struct Base { virtual int f() const { return 1; } virtual ~Base() {} };
struct Derived : Base { int f() const override { return 2; } };
int main() {
  std::vector<int> v{1, 2, 3};
  Derived d; const Base &b = d;
  std::cout << v.size() << " " << b.f() << std::endl;
  return 0;
}
`,
  "link.rsp": "-O2\nmain.c\nutil.c\n-o\nrsp.wasm\n",
  // The executable a program reports for itself (LLVM's getMainExecutable
  // relies on dladdr; clang starts its own compile jobs at that path).
  "self.c": `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  char exe[4096];
  Dl_info info;
  ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
  if (n < 0 || !dladdr((void *)main, &info)) return 1;
  exe[n] = 0;
  printf("%s\\n%s\\n", exe, info.dli_fname);
  return 0;
}
`,
};

interface Step {
  /** Tool: an SDK tool name. */
  tool: "cc" | "c++" | "ar";
  args: string[];
}

interface Case {
  name: string;
  steps: Step[];
  /** Files whose bytes must match. */
  outputs: string[];
  /** Run these programs inside Kandelo and expect this output. */
  runs?: { program: string; stdout: string }[];
}

const cases: Case[] = [
  { name: "compile-O2", steps: [{ tool: "cc", args: ["-O2", "-c", "hello.c", "-o", "hello.o"] }], outputs: ["hello.o"] },
  { name: "compile-O0", steps: [{ tool: "cc", args: ["-c", "hello.c", "-o", "hello.o"] }], outputs: ["hello.o"] },
  {
    name: "link-O2",
    steps: [{ tool: "cc", args: ["-O2", "hello.c", "-o", "hello.wasm"] }],
    outputs: ["hello.wasm"],
    runs: [{ program: "hello.wasm", stdout: "hello 3 hello.c\n" }],
  },
  { name: "link-O0", steps: [{ tool: "cc", args: ["hello.c", "-o", "hello.wasm"] }], outputs: ["hello.wasm"] },
  {
    name: "objects-and-archive",
    steps: [
      { tool: "cc", args: ["-O2", "-c", "util.c", "main.c"] },
      { tool: "ar", args: ["rcs", "libutil3.a", "util.o"] },
      { tool: "cc", args: ["-O2", "main.o", "-L.", "-lutil3", "-o", "archive.wasm"] },
    ],
    outputs: ["util.o", "main.o", "libutil3.a", "archive.wasm"],
    runs: [{ program: "archive.wasm", stdout: "12\n" }],
  },
  { name: "response-file", steps: [{ tool: "cc", args: ["@link.rsp"] }], outputs: ["rsp.wasm"] },
  { name: "pthread", steps: [{ tool: "cc", args: ["-O2", "-pthread", "thread.c", "-o", "thread.wasm"] }], outputs: ["thread.wasm"] },
  { name: "shared-library", steps: [{ tool: "cc", args: ["-O2", "-shared", "-fPIC", "lib.c", "-o", "lib.so"] }], outputs: ["lib.so"] },
  {
    name: "cxx",
    // c++ links the C++ library by default; naming it again changes nothing.
    steps: [
      { tool: "c++", args: ["-O2", "io.cpp", "-o", "io.wasm"] },
      { tool: "c++", args: ["-O2", "io.cpp", "-lc++", "-lc++abi", "-o", "io-explicit.wasm"] },
    ],
    outputs: ["io.wasm", "io-explicit.wasm"],
    runs: [{ program: "io.wasm", stdout: "3 2\n" }],
  },
  {
    name: "fork",
    steps: [{ tool: "cc", args: ["-O2", "fork.c", "-o", "fork.wasm"] }],
    // Linked with its facts and code hash, wasm-opt held back for the fork
    // instrumenter. It cannot run until it is instrumented.
    outputs: ["fork.wasm"],
  },
  {
    name: "self-path",
    steps: [
      { tool: "cc", args: ["-O2", "self.c", "-o", "self.wasm"] },
      { tool: "cc", args: ["-O2", "self.c", "-ldl", "-o", "self-dl.wasm"] },
    ],
    outputs: ["self.wasm", "self-dl.wasm"],
    runs: [
      {
        program: "self.wasm",
        stdout: "/tmp/equivalence/self-path/self.wasm\n/tmp/equivalence/self-path/self.wasm\n",
      },
      {
        program: "self-dl.wasm",
        stdout: "/tmp/equivalence/self-path/self-dl.wasm\n/tmp/equivalence/self-path/self-dl.wasm\n",
      },
    ],
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Extract the zip's wasm32posix/ tree (sysroot, glue, config.site). */
function extractSdkData(zip: Uint8Array, destination: string): void {
  for (const entry of parseZipCentralDirectory(zip)) {
    if (!entry.fileName.startsWith("wasm32posix/")) continue;
    const path = join(destination, entry.fileName);
    if (entry.isDirectory) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    const bytes = extractZipEntry(zip, entry);
    if (entry.isSymlink) symlinkSync(new TextDecoder().decode(bytes), path);
    else writeFileSync(path, bytes);
  }
}

function hostStep(step: Step, cwd: string, env: NodeJS.ProcessEnv): void {
  const program = step.tool === "cc"
    ? hostCc
    : step.tool === "c++"
      ? join(repoRoot, "sdk/bin/wasm32posix-c++")
      : hostAr;
  execFileSync(program, step.args, { cwd, env, stdio: "pipe" });
}

function guestCommand(step: Step): string {
  return [`wasm32posix-${step.tool}`, ...step.args].map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
}

describe.skipIf(!available)("SDK equivalence: inside Kandelo and on the build machine", () => {
  it("builds the same bytes in both places", async () => {
    const [kernel, shell, sdk, ...utilities] = artifacts as Uint8Array[];
    const work = mkdtempSync(join(tmpdir(), "kandelo-sdk-equivalence-"));
    try {
      // --- The build machine ---
      const sdkData = join(work, "sdk");
      extractSdkData(sdk!, sdkData);
      const env = {
        ...process.env,
        WASM_POSIX_SYSROOT: join(sdkData, "wasm32posix/sysroot"),
        WASM_POSIX_GLUE_DIR: join(sdkData, "wasm32posix/glue"),
      };
      const hostOutputs = new Map<string, string>();
      for (const sample of cases) {
        const dir = join(work, "host", sample.name);
        mkdirSync(dir, { recursive: true });
        for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, name), text);
        for (const step of sample.steps) hostStep(step, dir, env);
        for (const output of sample.outputs) {
          hostOutputs.set(`${sample.name}/${output}`, sha256(readFileSync(join(dir, output))));
        }
      }

      // --- Inside Kandelo ---
      let stdout = "";
      let stderr = "";
      const lazyBase = "https://kandelo.invalid/";
      const host = new NodeKernelHost({
        rootfsImage: shell!,
        rootfsLazyUrlBase: lazyBase,
        rootfsLazyAssetDirectory: lazyBase,
        rootfsLazyAssets: [{
          url: `${lazyBase}assets/programs/wasm32/kandelo-sdk.zip`,
          sha256: sha256(sdk!),
          size: sdk!.byteLength,
          bytes: sdk!,
        }, ...utilities.map((bytes, index) => ({
          url: `${lazyBase}assets/programs/wasm32/${utilityNames[index]}.wasm`,
          sha256: sha256(bytes),
          size: bytes.byteLength,
          bytes,
        }))],
        onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
        onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      });
      async function run(command: string) {
        stdout = "";
        stderr = "";
        const { exit } = await host.spawnFromVfs("/usr/bin/bash", ["bash", "-lc", command], {
          env: ["PATH=/usr/bin:/bin", "HOME=/home/maker", "USER=maker", "TMPDIR=/tmp"],
          cwd: "/tmp",
          uid: 1000,
          gid: 1000,
          stdin: new Uint8Array(),
        });
        return { exitCode: await exit, stdout, stderr };
      }

      try {
        await host.init(arrayBuffer(kernel!));
        const mismatches: string[] = [];
        for (const sample of cases) {
          const dir = `/tmp/equivalence/${sample.name}`;
          expect((await run(`mkdir -p ${dir}`)).exitCode).toBe(0);
          for (const [name, text] of Object.entries(sources)) {
            await host.writeFileToVfs(`${dir}/${name}`, new TextEncoder().encode(text));
          }
          for (const step of sample.steps) {
            const result = await run(`set -eu\ncd ${dir}\n${guestCommand(step)}`);
            expect(result.exitCode, `${sample.name}: ${guestCommand(step)}\n${result.stderr}${result.stdout}`).toBe(0);
          }
          for (const output of sample.outputs) {
            const bytes = await host.readFileFromVfs(`${dir}/${output}`);
            expect(bytes, `${sample.name}/${output} missing inside Kandelo`).not.toBeNull();
            const key = `${sample.name}/${output}`;
            if (sha256(bytes!) !== hostOutputs.get(key)) mismatches.push(key);
          }
          for (const expected of sample.runs ?? []) {
            const executed = await run(`cd ${dir} && ./${expected.program}`);
            expect(executed.exitCode, `${sample.name}: ${executed.stderr}`).toBe(0);
            expect(executed.stdout).toBe(expected.stdout);
          }
        }
        expect(mismatches, "outputs that differ between the two SDKs").toEqual([]);
      } finally {
        await host.destroy();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 3_600_000);
});
