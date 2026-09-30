import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";

// Host-supplied stdin is a kernel pipe (kernel_install_host_stdin_pipe):
// fd 0 is an ordinary open file description, so a child that inherits it
// reads the same stream. Before ABI 47 the bytes lived in host buffers keyed
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

  // Host input can race a process's lifetime: a keypress lands after the
  // program exited or closed fd 0, or is addressed to a forked child that
  // owns the display. None of these may take the kernel down (a throw inside
  // a kernel entry latches the entry gate as fatal); the bytes either reach
  // a reader or are discarded like a write to a pipe with no reader.
  describe("input that races the reader", () => {
    const dashBytes = () => {
      const b = readFileSync(dash);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    };

    it("survives input after the reader closed fd 0 and after it exited", async () => {
      let out = "";
      const host = new NodeKernelHost({
        maxWorkers: 4,
        rootfsImage: "default",
        onStdout: (_p, d) => { out += new TextDecoder().decode(d); },
      });
      await host.init();
      try {
        let pid = 0;
        const exit = host.spawn(dashBytes(), ["sh", "-c", "exec 0<&-; sleep 1; echo closed-ok"], {
          onStarted: (p) => { pid = p; },
        });
        await new Promise((r) => setTimeout(r, 400)); // fd 0 closed by now
        host.appendStdinData(pid, enc("after close\n"));
        host.appendStdinData(pid, enc("again\n"));
        expect(await exit).toBe(0);
        host.appendStdinData(pid, enc("after exit\n"));
        host.setStdinData(pid, enc("after exit, closing\n"));
        // The kernel still runs programs.
        expect(await host.spawn(dashBytes(), ["sh", "-c", "echo alive"], {})).toBe(0);
        expect(out).toBe("closed-ok\nalive\n");
      } finally {
        await host.destroy();
      }
    }, 120_000);

    it("delivers input addressed to a forked child through its inherited stdin", async () => {
      let out = "";
      const host = new NodeKernelHost({
        maxWorkers: 4,
        rootfsImage: "default",
        onStdout: (_p, d) => { out += new TextDecoder().decode(d); },
      });
      await host.init();
      try {
        // The child prints its pid, then becomes `head -c 5` reading the
        // fd 0 it inherited from the spawned shell.
        const exit = host.spawn(
          dashBytes(),
          ["sh", "-c", "sh -c 'echo \"child=$$\"; exec head -c 5'; echo; echo done"],
          { onStarted: () => {} },
        );
        const deadline = Date.now() + 30_000;
        let child = 0;
        while (child === 0 && Date.now() < deadline) {
          const m = /child=(\d+)/.exec(out);
          if (m) child = Number(m[1]);
          else await new Promise((r) => setTimeout(r, 50));
        }
        expect(child).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 300)); // head blocks in read(0)
        host.appendStdinData(child, enc("hello"));
        expect(await exit).toBe(0);
        expect(out).toContain("hello\ndone\n");
      } finally {
        await host.destroy();
      }
    }, 120_000);
  });
});
