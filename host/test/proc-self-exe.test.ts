import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";
import { tryResolveBinary } from "../src/binary-resolver";
import type { CentralizedKernelWorker } from "../src/kernel-worker";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "./centralized-test-helper";

/**
 * `/proc/self/exe` is the open file the running image was executed through
 * (`Process::exe` in the kernel) -- through a real worker and a real
 * fork-instrumented guest.
 *
 * - It used to be `argv[0]`: whatever the caller put there, which named a
 *   different file or none. An exec here passes an `argv[0]` that is not the
 *   path, and the link still names the file.
 * - Linux keeps that file for the life of the image: the exec'd program
 *   unlinks its own file and still opens and reads itself.
 * - A program the host supplied as bytes has no file in the namespace. The
 *   kernel holds a host handle onto the host's bytes -- never a copy -- and the
 *   link says what Linux says of an executable with no names: ` (deleted)`.
 * - A fork child runs the same image, so it inherits the same executable;
 *   every fork below reports it from the child.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const cc = join(repoRoot, "sdk", "bin", "wasm32posix-cc");
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
// Under `<repoRoot>/target`, so the guest reaches the real host file through
// NodePlatformIO rather than an in-kernel tmpfs shadowing `/tmp`.
const buildDir = makeHostScratchTempRoot("kandelo-proc-self-exe-");
const programPath = join(buildDir, "proc-self-exe.wasm");

// Both artifacts come from ordinary provisioning (`scripts/build-musl.sh`,
// `./run.sh setup`); without them the suite has nothing to run against.
const artifactsMissing =
  !existsSync(join(repoRoot, "sysroot", "lib", "libc.a"))
  || tryResolveBinary("kernel.wasm") === null;

const SOURCE = `
  #include <fcntl.h>
  #include <stdio.h>
  #include <string.h>
  #include <sys/wait.h>
  #include <unistd.h>

  static void report(const char *who) {
    char link[512];
    ssize_t n = readlink("/proc/self/exe", link, sizeof link - 1);
    if (n < 0) { printf("%s readlink failed\\n", who); return; }
    link[n] = 0;
    unsigned char magic[4] = {0};
    int fd = open("/proc/self/exe", O_RDONLY);
    ssize_t got = fd >= 0 ? pread(fd, magic, sizeof magic, 0) : -1;
    if (fd >= 0) close(fd);
    printf("%s exe=%s magic=%s\\n", who, link,
           got == 4 && memcmp(magic, "\\0asm", 4) == 0 ? "wasm" : "bad");
  }

  static int fork_and_report(void) {
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) return 4;
    if (pid == 0) { report("fork-child"); fflush(stdout); _exit(0); }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return 5;
    return WEXITSTATUS(status);
  }

  int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "fork") == 0) {
      report("host-launched");
      return fork_and_report();
    }
    if (argc > 2 && strcmp(argv[1], "exec") == 0) {
      report("host-launched");
      int forked = fork_and_report();
      if (forked != 0) return forked;
      fflush(stdout);
      execl(argv[2], "not-the-path", "execd", argv[2], (char *)0);
      return 9;
    }
    if (argc > 2 && strcmp(argv[1], "execd") == 0) {
      if (unlink(argv[2]) != 0) return 10;
      report("execd");
      return fork_and_report();
    }
    return 1;
  }
`;

/** Append a custom section of `size` zero bytes, named outside the fork namespace. */
function padded(bytes: Uint8Array, size: number): Uint8Array {
  const uleb = (value: number): number[] => {
    const out: number[] = [];
    do {
      let byte = value & 0x7f;
      value = Math.floor(value / 128);
      if (value !== 0) byte |= 0x80;
      out.push(byte);
    } while (value !== 0);
    return out;
  };
  const name = new TextEncoder().encode("padding");
  const head = [...uleb(name.length), ...name];
  const header = new Uint8Array([0, ...uleb(head.length + size), ...head]);
  const out = new Uint8Array(bytes.length + header.length + size);
  out.set(bytes, 0);
  out.set(header, bytes.length);
  return out;
}

describe.skipIf(artifactsMissing)("/proc/self/exe", () => {
  beforeAll(() => {
    mkdirSync(buildDir, { recursive: true });
    const source = join(buildDir, "proc-self-exe.c");
    writeFileSync(source, SOURCE);
    execFileSync(cc, ["-O2", source, "-o", programPath], { stdio: "pipe" });
    const output = `${programPath}.instrumented`;
    execFileSync(instrument, [programPath, "-o", output], { stdio: "pipe" });
    renameSync(output, programPath);
  }, 120_000);

  it("names and opens the executed file, after an argv[0] that is not it and an unlink", async () => {
    // The exec target is a copy, because the exec'd image unlinks it.
    const target = join(buildDir, "proc-self-exe-target.wasm");
    copyFileSync(programPath, target);
    const result = await runCentralizedProgram({
      programPath,
      argv: ["proc-self-exe", "exec", target],
      timeout: 60_000,
      io: new NodePlatformIO(),
    });
    const out = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.exitCode, out).toBe(0);
    // The host supplied these bytes: no name in the namespace.
    expect(result.stdout, out).toContain("host-launched exe=proc-self-exe (deleted) magic=wasm");
    // A fork child runs the same image, so it has the same executable.
    expect(result.stdout, out).toContain("fork-child exe=proc-self-exe (deleted) magic=wasm");
    // The exec'd image names the file it was executed through, not its
    // `argv[0]` ("not-the-path"), and still reads it after unlinking it.
    expect(result.stdout, out).toContain(`execd exe=${target} magic=wasm`);
    expect(existsSync(target), "the exec'd image unlinked its own file").toBe(false);
    // ...and a fork from that image inherits the unlinked file too.
    expect(result.stdout, out).toContain(`fork-child exe=${target} magic=wasm`);
  }, 90_000);

  it("holds a host-supplied program by reference: kernel memory does not grow by its size", async () => {
    // The same program twice, padded by 1 MiB and by 96 MiB of a custom
    // section outside the fork namespace. If the kernel copied the program
    // anywhere -- at attach, or when a fork child inherits it -- its memory,
    // which never shrinks, would grow by at least the padding. What a run grows the kernel by is measured against
    // the small program's run, so the comparison is about the program's size
    // and nothing else.
    const run = async (padding: number) => {
      const path = join(buildDir, `proc-self-exe-${padding}.wasm`);
      writeFileSync(path, padded(new Uint8Array(readFileSync(programPath)), padding));
      let kernel: CentralizedKernelWorker | undefined;
      let pagesAtLaunch = 0;
      const result = await runCentralizedProgram({
        programPath: path,
        argv: ["proc-self-exe-big", "fork"],
        timeout: 60_000,
        io: new NodePlatformIO(),
        onKernelReady: (readyKernel) => {
          kernel = readyKernel;
          pagesAtLaunch = readyKernel.getKernelMemoryPages();
        },
      });
      const out = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.exitCode, out).toBe(0);
      expect(result.stdout, out).toContain("host-launched exe=proc-self-exe-big (deleted) magic=wasm");
      expect(result.stdout, out).toContain("fork-child exe=proc-self-exe-big (deleted) magic=wasm");
      const pages = kernel!.getKernelMemoryPages();
      return { kernelBytes: pages * 65_536, grownBytes: (pages - pagesAtLaunch) * 65_536 };
    };
    const big = 96 * 1024 * 1024;
    const small = await run(1024 * 1024);
    const large = await run(big);
    // The whole kernel is smaller than the program, so no copy of it exists
    // there, and running it and a fork grew the kernel no
    // more than running the small program did, give or take a few pages.
    expect(large.kernelBytes, `kernel memory ${large.kernelBytes} bytes`).toBeLessThan(big);
    expect(
      large.grownBytes - small.grownBytes,
      `the 96 MiB program grew the kernel ${large.grownBytes} bytes, the 1 MiB one ${small.grownBytes}`,
    ).toBeLessThan(1024 * 1024);
  }, 180_000);
});
