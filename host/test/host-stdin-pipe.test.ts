import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";

// Host-supplied stdin is a kernel pipe (kernel_install_host_stdin_pipe):
// fd 0 is an ordinary open file description, so a child that inherits it
// reads the same stream. Before ABI 44 the bytes lived in host buffers keyed
// by pid and an inheriting child blocked forever.
const dash = tryResolveBinary("programs/dash.wasm");
if (!dash) throw new Error("programs/dash.wasm is missing; build the dash package");

const enc = (s: string) => new TextEncoder().encode(s);

describe("host-supplied stdin", () => {
  it("a child reads stdin inherited from the shell", async () => {
    const r = await runCentralizedProgram({
      // `; true` keeps dash from exec'ing cat in place, so cat is a forked
      // child reading the shell's inherited fd 0.
      programPath: dash, argv: ["sh", "-c", "cat; true"],
      stdinBytes: enc("hello from the host\n"), timeout: 30_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe("hello from the host\n");
  }, 60_000);

  it("parent and child share one stdin offset", async () => {
    const r = await runCentralizedProgram({
      programPath: dash, argv: ["sh", "-c", "head -c 3; printf '|'; cat"],
      stdinBytes: enc("abcdef"), timeout: 30_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe("abc|def");
  }, 60_000);

  it("delivers input larger than the pipe in order", async () => {
    const big = new Uint8Array(24 * 1024 * 1024).map((_, i) => i % 251);
    const r = await runCentralizedProgram({
      programPath: dash, argv: ["sh", "-c", "cat | wc -c"],
      stdinBytes: big, timeout: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(String(big.byteLength));
  }, 180_000);

  it("large input arrives byte-for-byte", async () => {
    const big = new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * 7) % 256);
    const r = await runCentralizedProgram({
      programPath: dash, argv: ["sh", "-c", "sha256sum"],
      stdinBytes: big, timeout: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.split(" ")[0]).toBe(createHash("sha256").update(big).digest("hex"));
  }, 180_000);

  // Through NodeKernelHost with the test rootfs (runCentralizedProgram's
  // onStarted hook), so `head` resolves inside Kandelo. A bare NodeKernelHost
  // with no rootfs exposes the host filesystem, where PATH finds the
  // macOS binary instead.
  it("appendStdinData wakes a reader blocked on empty stdin", async () => {
    let appendedAt = 0;
    const r = await runCentralizedProgram({
      programPath: dash,
      argv: ["sh", "-c", "head -c 5"],
      timeout: 30_000,
      onStarted: async (stdin, pid) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // head blocks in read(0)
        appendedAt = Date.now();
        stdin.appendStdinData(pid, enc("hello"));
      },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(Date.now() - appendedAt).toBeLessThan(5_000);
  }, 60_000);
});
