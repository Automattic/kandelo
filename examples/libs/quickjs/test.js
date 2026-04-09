// QuickJS-NG test script for wasm-posix-kernel
// Tests core JS features, os module, and std module

import * as std from 'qjs:std';
import * as os from 'qjs:os';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (e) {
        console.log(`  FAIL: ${name}: ${e.message}`);
        failed++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
}

console.log("=== QuickJS-NG Test Suite ===\n");

// --- ES2023 Language Features ---
console.log("Language features:");

test("let/const/arrow functions", () => {
    const add = (a, b) => a + b;
    assert(add(2, 3) === 5);
});

test("template literals", () => {
    const x = 42;
    assert(`value: ${x}` === "value: 42");
});

test("destructuring", () => {
    const {a, ...rest} = {a: 1, b: 2, c: 3};
    assert(a === 1);
    assert(rest.b === 2);
    assert(rest.c === 3);
});

test("Promise", () => {
    let resolved = false;
    Promise.resolve(42).then(v => { resolved = true; });
    // Microtask won't run until event loop, but Promise creation works
    assert(typeof Promise.resolve === "function");
});

test("async/await", () => {
    async function foo() { return 42; }
    const p = foo();
    assert(p instanceof Promise);
});

test("BigInt", () => {
    assert((2n ** 64n).toString() === "18446744073709551616");
});

test("Array.findLast", () => {
    assert([1,2,3,4,5].findLast(x => x < 4) === 3);
});

test("Array.toSorted", () => {
    const arr = [3,1,2];
    const sorted = arr.toSorted();
    assert(sorted.join(",") === "1,2,3");
    assert(arr.join(",") === "3,1,2"); // original unchanged
});

test("Array.toReversed", () => {
    const arr = [1,2,3];
    assert(arr.toReversed().join(",") === "3,2,1");
});

test("Object.groupBy", () => {
    const arr = [{type: "a", v: 1}, {type: "b", v: 2}, {type: "a", v: 3}];
    const grouped = Object.groupBy(arr, x => x.type);
    assert(grouped.a.length === 2);
    assert(grouped.b.length === 1);
});

test("regex named groups", () => {
    const m = /(?<year>\d{4})-(?<month>\d{2})/.exec("2026-04");
    assert(m.groups.year === "2026");
    assert(m.groups.month === "04");
});

test("optional chaining", () => {
    const obj = {a: {b: 42}};
    assert(obj?.a?.b === 42);
    assert(obj?.x?.y === undefined);
});

test("nullish coalescing", () => {
    assert((null ?? "default") === "default");
    assert((0 ?? "default") === 0);
});

test("Map and Set", () => {
    const m = new Map([["a", 1], ["b", 2]]);
    assert(m.get("a") === 1);
    const s = new Set([1, 2, 3, 2, 1]);
    assert(s.size === 3);
});

test("WeakRef and FinalizationRegistry", () => {
    assert(typeof WeakRef === "function");
    assert(typeof FinalizationRegistry === "function");
});

// --- os module (POSIX) ---
console.log("\nos module (POSIX):");

test("os.getcwd", () => {
    const [cwd, err] = os.getcwd();
    assert(err === 0, `getcwd failed: ${err}`);
    assert(cwd.length > 0);
});

test("os.getpid", () => {
    const pid = os.getpid();
    assert(pid > 0);
});

test("os.pipe", () => {
    const fds = os.pipe();
    assert(fds !== null);
    assert(fds.length === 2);
    os.close(fds[0]);
    os.close(fds[1]);
});

test("os.open/write/read/close", () => {
    const path = "/tmp/qjs-test-" + os.getpid() + ".txt";
    const fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644);
    assert(fd >= 0, `open failed: ${fd}`);
    const msg = "hello wasm kernel";
    const buf = new Uint8Array(msg.length);
    for (let i = 0; i < msg.length; i++) buf[i] = msg.charCodeAt(i);
    const written = os.write(fd, buf.buffer, 0, buf.length);
    assert(written === buf.length, `wrote ${written}`);
    os.close(fd);

    const fd2 = os.open(path, os.O_RDONLY);
    assert(fd2 >= 0);
    const readBuf = new ArrayBuffer(64);
    const n = os.read(fd2, readBuf, 0, 64);
    assert(n === msg.length, `read ${n}`);
    os.close(fd2);
    os.remove(path);
});

test("os.stat", () => {
    const [stat, err] = os.stat("/tmp");
    assert(err === 0, `stat failed: ${err}`);
    assert(stat.mode !== undefined);
});

test("os.readdir", () => {
    const [entries, err] = os.readdir("/tmp");
    assert(err === 0, `readdir failed: ${err}`);
    assert(entries.length >= 2); // at least . and ..
});

test("os.mkdir/remove", () => {
    const dir = "/tmp/qjs-test-dir-" + os.getpid();
    os.remove(dir); // cleanup from previous run
    let err = os.mkdir(dir, 0o755);
    assert(err === 0, `mkdir failed: ${err}`);
    err = os.remove(dir);
    assert(err === 0, `remove dir failed: ${err}`);
});

test("os.symlink/readlink", () => {
    const target = "/tmp/qjs-symlink-target-" + os.getpid();
    const link = "/tmp/qjs-symlink-" + os.getpid();
    // Create target file
    const fd = os.open(target, os.O_WRONLY | os.O_CREAT, 0o644);
    os.close(fd);
    const err = os.symlink(target, link);
    assert(err === 0, `symlink failed: ${err}`);
    const [resolved, err2] = os.readlink(link);
    assert(err2 === 0, `readlink failed: ${err2}`);
    assert(resolved === target);
    os.remove(link);
    os.remove(target);
});

test("os.isatty", () => {
    // fd 0 (stdin) might or might not be a tty, but the call should work
    const result = os.isatty(0);
    assert(typeof result === "boolean" || typeof result === "number");
});

test("os.sleep (100ms)", () => {
    const t0 = Date.now();
    os.sleep(100);
    const elapsed = Date.now() - t0;
    assert(elapsed >= 50, `sleep too short: ${elapsed}ms`);
});

// --- std module ---
console.log("\nstd module:");

test("std.open/puts/getline/close", () => {
    const path = "/tmp/qjs-std-test-" + os.getpid() + ".txt";
    const f = std.open(path, "w");
    assert(f !== null);
    f.puts("line one\n");
    f.puts("line two\n");
    f.close();

    const f2 = std.open(path, "r");
    assert(f2 !== null);
    assert(f2.getline() === "line one");
    assert(f2.getline() === "line two");
    f2.close();
    os.remove(path);
});

test("std.getenv", () => {
    // HOME should be set
    const home = std.getenv("HOME");
    // Might be null in our kernel but shouldn't crash
    assert(home === null || typeof home === "string");
});

test("std.printf (to stdout)", () => {
    // Just verify it doesn't crash
    std.printf("  (printf test: %d %s)\n", 42, "ok");
});

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) std.exit(1);
