/**
 * Tests for GNU coreutils running on the kandelo.
 *
 * The single-binary coreutils uses argv[0] to determine which utility to run.
 * We pass the utility name as argv[0] (e.g., ["echo", "hello"]).
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const coreutilsBinary = tryResolveBinary("programs/coreutils.wasm");

const hasCoreutils = !!coreutilsBinary;

describe.skipIf(!hasCoreutils)("GNU coreutils", () => {
  it("echo prints text", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["echo", "hello", "world"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("true returns 0", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["true"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
  });

  it("false returns 1", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["false"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(1);
  });

  it("printf formats output", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["printf", "%s %d\\n", "count", "42"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("count 42");
  });

  it("basename extracts filename", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["basename", "/usr/local/bin/test"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("test");
  });

  it("dirname extracts directory", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["dirname", "/usr/local/bin/test"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/usr/local/bin");
  });

  it("wc counts bytes from stdin", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["wc", "-c"],
      stdin: "hello",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("5");
  });

  it("cat echoes stdin", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["cat"],
      stdin: "hello from cat",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from cat");
  });

  it("tr translates characters", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["tr", "a-z", "A-Z"],
      stdin: "hello world",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("HELLO WORLD");
  });

  it("sort sorts lines", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["sort"],
      stdin: "cherry\napple\nbanana\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("apple\nbanana\ncherry");
  });

  it("uniq removes duplicates", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["uniq"],
      stdin: "aaa\naaa\nbbb\nccc\nccc\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("aaa\nbbb\nccc");
  });

  it("head shows first lines", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["head", "-n", "2"],
      stdin: "line1\nline2\nline3\nline4\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("line1\nline2");
  });

  it("tail shows last lines", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["tail", "-n", "2"],
      stdin: "line1\nline2\nline3\nline4\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("line3\nline4");
  });

  it("seq generates sequence", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["seq", "1", "5"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1\n2\n3\n4\n5");
  }, 20_000);

  it("env prints environment", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["env"],
      env: ["FOO=bar", "BAZ=qux"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("BAZ=qux");
  });

  it("test evaluates expressions", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["test", "5", "-gt", "3"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
  });

  it("expr evaluates arithmetic", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["expr", "3", "+", "4"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("7");
  });

  // `expr STRING : REGEX` uses GNU's regex API (re_compile_pattern,
  // re_search), which musl lacks; gnulib must build its own. Before honest
  // links a false configure seed skipped it and this trapped on
  // "Unimplemented import: env.re_compile_pattern".
  it("expr matches a regular expression", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["expr", "abcdef", ":", "a.*d"],
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("4");
  });

  // The kernel fields come from uname(2). `-o` is fixed when coreutils is
  // configured: gnulib derives it from the host tuple, which would say
  // "GNU/Linux" for wasm32-unknown-linux-musl, so sdk/config.site names the
  // operating system instead.
  it("uname reports the kernel's fields and Kandelo as the OS", async () => {
    const uname = async (...args: string[]) => {
      const result = await runCentralizedProgram({
        programPath: coreutilsBinary!,
        argv: ["uname", ...args],
        timeout: 10_000,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    expect(await uname("-s")).toBe("wasm-posix");
    expect(await uname("-o")).toBe("Kandelo");
    // sysname nodename release version machine, then the OS; -a omits
    // the processor and hardware platform because both are "unknown".
    expect(await uname("-a")).toBe(
      "wasm-posix localhost 1.0.0 kandelo wasm32 Kandelo",
    );
  }, 60_000);

  it("cut extracts fields", async () => {
    const result = await runCentralizedProgram({
      programPath: coreutilsBinary!,
      argv: ["cut", "-d:", "-f1"],
      stdin: "root:x:0:0\nnobody:x:65534:65534\n",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("root\nnobody");
  });

  it("yes outputs repeated string (limited)", async () => {
    try {
      const result = await runCentralizedProgram({
        programPath: coreutilsBinary!,
        argv: ["yes", "ok"],
        // yes writes infinitely — it'll timeout since there's no pipe reader
        timeout: 1_000,
      });
      // If it exits, it should have produced output
      expect(result.stdout).toContain("ok");
    } catch (e: unknown) {
      // Timeout is expected for an infinite writer
      expect((e as Error).message).toContain("timed out");
    }
  });
});
