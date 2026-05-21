import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageBuild = join(__dirname, "../bin/js.wasm");
const jsWasm =
  tryResolveBinary("programs/js.wasm") ??
  (existsSync(packageBuild) ? packageBuild : null);

const DEFAULT_TIMEOUT = 20_000;

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runJs(
  source: string,
  options: { shellArgs?: string[]; timeout?: number } = {},
) {
  return runCentralizedProgram({
    programPath: jsWasm!,
    argv: ["js", ...(options.shellArgs ?? []), "-e", source],
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
  });
}

function stdoutLines(stdout: string): string[] {
  return stdout.trim().split("\n");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!jsWasm)("SpiderMonkey js shell", () => {
  it("evaluates a simple expression", async () => {
    const result = await runJs("print(1 + 1)");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("supports modern JavaScript syntax that QuickJS compatibility needs", async () => {
    const result = await runJs([
      "print([3, 1, 2].toSorted().join(','))",
      "print(Object.groupBy(['a', 'bb', 'c'], s => s.length)[1].join(','))",
      "print(typeof Promise.withResolvers)",
      "print((2n ** 64n).toString())",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual([
      "1,2,3",
      "a,c",
      "function",
      "18446744073709551616",
    ]);
  });

  it("supports Intl APIs", async () => {
    const result = await runJs([
      "print(typeof Intl)",
      "print(new Intl.NumberFormat('de-DE').format(1234567.89))",
      "print(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(Date.UTC(2020, 0, 2))))",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual([
      "object",
      "1.234.567,89",
      "January",
    ]);
  });

  it("covers broader Intl locale data", async () => {
    const result = await runJs([
      "print(new Intl.PluralRules('en-US').select(1))",
      "print(new Intl.PluralRules('en-US').select(2))",
      "print(new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'))",
      "print(new Intl.Locale('ja-JP-u-ca-japanese').calendar)",
      "print(new Intl.NumberFormat('ar-EG').format(12345) !== '12345')",
      "print(typeof Intl.supportedValuesOf === 'function' && Intl.supportedValuesOf('timeZone').includes('UTC'))",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual([
      "one",
      "other",
      "yesterday",
      "japanese",
      "true",
      "true",
    ]);
  });

  it("supports SharedArrayBuffer, Atomics, and shell workers", async () => {
    const result = await runJs([
      "var sab = new SharedArrayBuffer(16)",
      "var view = new Int32Array(sab)",
      "setSharedObject(sab)",
      "evalInWorker(`var sab = getSharedObject(); var view = new Int32Array(sab); Atomics.store(view, 0, 42); Atomics.notify(view, 0);`)",
      "Atomics.wait(view, 0, 0)",
      "print(Atomics.load(view, 0))",
    ].join(";"), { shellArgs: ["--shared-memory=on"] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  it("supports Atomics wait timeout and not-equal results", async () => {
    const result = await runJs([
      "var sab = new SharedArrayBuffer(4)",
      "var view = new Int32Array(sab)",
      "print(Atomics.wait(view, 0, 0, 1))",
      "Atomics.store(view, 0, 1)",
      "print(Atomics.wait(view, 0, 0, 1))",
    ].join(";"), { shellArgs: ["--shared-memory=on"] });

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual(["timed-out", "not-equal"]);
  });

  it("coordinates multiple shell workers through shared memory", async () => {
    const result = await runJs([
      "var sab = new SharedArrayBuffer(8)",
      "var view = new Int32Array(sab)",
      "setSharedObject(sab)",
      "for (var i = 0; i < 3; i++) evalInWorker(`var view = new Int32Array(getSharedObject()); Atomics.add(view, 0, 1); Atomics.add(view, 1, 1); Atomics.notify(view, 1);`)",
      "while (Atomics.load(view, 1) < 3) Atomics.wait(view, 1, Atomics.load(view, 1), 10000)",
      "print(Atomics.load(view, 0))",
      "print(Atomics.load(view, 1))",
    ].join(";"), { shellArgs: ["--shared-memory=on"] });

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual(["3", "3"]);
  });

  it("tears down workers repeatedly while GC runs", async () => {
    const result = await runJs([
      "for (var i = 0; i < 12; i++) {",
      "  var sab = new SharedArrayBuffer(4)",
      "  var view = new Int32Array(sab)",
      "  setSharedObject(sab)",
      "  evalInWorker(`var view = new Int32Array(getSharedObject()); Atomics.store(view, 0, 1); Atomics.notify(view, 0);`)",
      "  if (Atomics.wait(view, 0, 0, 10000) !== 'ok') throw new Error('worker wait failed')",
      "  if (typeof gc === 'function') gc()",
      "}",
      "print('worker-teardown-ok')",
    ].join("\n"), { shellArgs: ["--shared-memory=on"], timeout: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("worker-teardown-ok");
  });

  it("reports stack overflow as a JavaScript exception", async () => {
    const result = await runJs([
      "function recurse() { return 1 + recurse(); }",
      "try {",
      "  recurse()",
      "} catch (e) {",
      "  print(e.name)",
      "  print(/recursion|stack/i.test(String(e)))",
      "}",
    ].join("\n"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual(["InternalError", "true"]);
  });

  it("loads and reads files through the shell file APIs", async () => {
    const result = await runJs([
      "function asciiBytes(s) {",
      "  var bytes = new Uint8Array(s.length)",
      "  for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)",
      "  return bytes",
      "}",
      "os.file.writeTypedArrayToFile('/tmp/spidermonkey-load.js', asciiBytes(\"var loadedValue = 37; print('loaded:' + loadedValue);\\n\"))",
      "load('/tmp/spidermonkey-load.js')",
      "print(snarf('/tmp/spidermonkey-load.js').includes('loadedValue'))",
    ].join("\n"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual(["loaded:37", "true"]);
  });

  it("executes a mounted script file and exposes scriptArgs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "spidermonkey-script-"));
    const scriptPath = join(tempDir, "args.js");
    writeFileSync(
      scriptPath,
      "print('scriptArgs:' + scriptArgs.join('|'));\n",
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await withTimeout(
        host.spawn(loadWasm(jsWasm!), ["js", "/mnt/args.js", "alpha", "beta"], {}),
        DEFAULT_TIMEOUT,
        "script execution timed out",
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("scriptArgs:alpha|beta");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("round-trips UTF-8 source and stdout", async () => {
    const result = await runJs([
      "print('unicode:' + '\\u2603' + ':' + '\\u00e9' + ':' + '\\u6f22\\u5b57')",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("unicode:\u2603:\u00e9:\u6f22\u5b57");
  });

  it("returns non-zero for syntax errors", async () => {
    const result = await runJs("function {");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SyntaxError");
  });

  it("returns non-zero for uncaught exceptions", async () => {
    const result = await runJs("throw new Error('spidermonkey-boom')");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("spidermonkey-boom");
  });

  it("handles typed arrays, weak refs, and explicit GC pressure", async () => {
    const result = await runJs([
      "var buf = new ArrayBuffer(8)",
      "var dv = new DataView(buf)",
      "dv.setUint32(0, 0x12345678, true)",
      "print(Array.from(new Uint8Array(buf).slice(0, 4)).join(','))",
      "var target = { value: 42 }",
      "var ref = new WeakRef(target)",
      "var registry = new FinalizationRegistry(() => {})",
      "registry.register(target, 'held')",
      "print(ref.deref().value)",
      "var total = 0",
      "for (var round = 0; round < 5; round++) {",
      "  var values = []",
      "  for (var i = 0; i < 10000; i++) values.push({ i, s: 'value-' + i })",
      "  total += values[9999].i",
      "  if (typeof gc === 'function') gc()",
      "}",
      "print(total)",
    ].join("\n"), { timeout: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual([
      "120,86,52,18",
      "42",
      "49995",
    ]);
  });

  it("drains Promise microtasks in the shell job queue", async () => {
    const result = await runJs([
      "var order = []",
      "Promise.resolve().then(() => order.push('promise'))",
      "order.push('sync')",
      "drainJobQueue()",
      "print(order.join(','))",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("sync,promise");
  });

  it("documents that nested WebAssembly is not exposed without a wasm JIT backend", async () => {
    const result = await runJs([
      "print(typeof WebAssembly)",
      "print(typeof wasmIsSupported === 'function' ? wasmIsSupported() : 'missing')",
    ].join(";"));

    expect(result.exitCode).toBe(0);
    expect(stdoutLines(result.stdout)).toEqual(["undefined", "false"]);
  });
});
