// Drives the REAL `wasi_module32.wasm` through the REAL channel protocol.
//
//   scripts/dev-shell.sh bash -c \
//     'node crates/wasi-module/tests/wasm-integration.mjs'
//
// The host-target tests in `entry_points.rs` prove the logic. They cannot
// prove the things that only exist once the module is actually wasm:
//
//   * that a host-chosen `__memory_base` really places the module's statics
//     clear of the guest, and that its own writes land there;
//   * that `memory.atomic.wait32` inside the module blocks and is woken by an
//     `Atomics.notify` from another thread, which is how every syscall
//     completes;
//   * that the module's exports work as another instance's imports, with the
//     guest calling them as wasm->wasm calls.
//
// A worker thread plays the kernel: it waits on the channel status word,
// services the request, and notifies back -- the same protocol
// `host/src/kernel-worker.ts` implements.
//
// This is deliberately a bare-Node harness rather than a Vitest case: the
// module's channel wait BLOCKS the calling agent, and the calling agent here
// is the main thread.

import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const PAGE = 65536;
// Mirrors the real process layout: the guest's declared minimum, then a
// host-owned band holding the syscall channel and the module's region.
const GUEST_MIN_PAGES = 4;
const CHANNEL_PAGE = 4;
const CHANNEL_BASE = CHANNEL_PAGE * PAGE;
// The channel header plus its 64 KiB data area.
const CHANNEL_PAGES = 2;
const MODULE_BASE = (CHANNEL_PAGE + CHANNEL_PAGES) * PAGE;
const MODULE_REGION_BYTES = 4 * PAGE;
const INITIAL_PAGES = CHANNEL_PAGE + CHANNEL_PAGES + MODULE_REGION_BYTES / PAGE;

// From host/src/generated/abi.ts.
const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARG_SIZE = 8;
const CH_RETURN = 56;
const CH_ERRNO = 64;
const CH_DATA = 72;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_COMPLETE = 2;

const SYS_OPENAT = 69;
const SYS_WRITEV = 81;
const SYS_SEEK = 5;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error && error.message) });
  }
}

const bytes = new Uint8Array(
  await readFile(join(repoRoot, "local-binaries", "wasi_module32.wasm")),
);
const module = await WebAssembly.compile(bytes);

const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 256,
  shared: true,
});
const i32 = new Int32Array(memory.buffer);
const view = new DataView(memory.buffer);

const g = (type, value, mutable = false) =>
  new WebAssembly.Global({ value: type, mutable }, value);

const instance = new WebAssembly.Instance(module, {
  env: {
    memory,
    __indirect_function_table: new WebAssembly.Table({
      element: "anyfunc",
      initial: 0,
    }),
    __memory_base: g("i32", MODULE_BASE),
    __table_base: g("i32", 0),
    __stack_pointer: g("i32", MODULE_BASE + MODULE_REGION_BYTES, true),
  },
});
const wasi = instance.exports;

// ---- the fake kernel -------------------------------------------------------
// A worker thread servicing the channel, exactly as the kernel worker does.
const kernel = new Worker(
  new URL("./wasm-integration-kernel.mjs", import.meta.url),
  { workerData: { memory, channelBase: CHANNEL_BASE } },
);
const kernelReady = new Promise((resolve) => kernel.once("message", resolve));
await kernelReady;

/** Every syscall the kernel observed, in order. */
async function drainCalls() {
  kernel.postMessage({ type: "calls" });
  return await new Promise((resolve) => kernel.once("message", resolve));
}

// ---- exercise it -----------------------------------------------------------

// Stage argv/env the way the host would: NUL-separated blobs in guest memory.
const ARGV_AT = 1024;
const argvBlob = new TextEncoder().encode("prog\0-v\0");
new Uint8Array(memory.buffer, ARGV_AT, argvBlob.length).set(argvBlob);

assert.equal(
  wasi.wasi_module_init(CHANNEL_BASE, ARGV_AT, 2, argvBlob.length, ARGV_AT, 2, argvBlob.length),
  0,
  "wasi_module_init",
);

check("args_sizes_get runs with no syscall at all", () => {
  const out = 2048;
  assert.equal(wasi.args_sizes_get(out, out + 4), 0);
  assert.equal(view.getUint32(out, true), 2, "argc");
  assert.equal(view.getUint32(out + 4, true), argvBlob.length, "argv bytes");
});

check("args_get publishes pointers into the guest buffer", () => {
  const ptrs = 2100;
  const buf = 2200;
  assert.equal(wasi.args_get(ptrs, buf), 0);
  assert.equal(view.getUint32(ptrs, true), buf);
  assert.equal(view.getUint32(ptrs + 4, true), buf + 5);
});

// The load-bearing one: this BLOCKS on memory.atomic.wait32 until the kernel
// worker completes the request.
check("wasi_module_start opens / through the real channel", () => {
  const rc = wasi.wasi_module_start();
  assert.equal(rc, 0, `wasi_module_start returned ${rc}`);
});

check("the module placed its statics in the host-chosen region", () => {
  // The module's region must be inside the band the host reserved, and the
  // guest's low memory must be untouched by it.
  const low = new Uint8Array(memory.buffer, 0, GUEST_MIN_PAGES * PAGE);
  // Only the argv/env we wrote ourselves should be non-zero down there.
  let unexpected = 0;
  for (let i = 0; i < low.length; i++) {
    if (i >= ARGV_AT && i < 2400) continue;
    if (low[i] !== 0) unexpected++;
  }
  assert.equal(unexpected, 0, `${unexpected} bytes of guest memory were clobbered`);
});

check("fd_prestat_get reports the preopen the channel call created", () => {
  const out = 3000;
  assert.equal(wasi.fd_prestat_get(3, out), 0);
  assert.equal(view.getUint8(out), 0, "PREOPENTYPE_DIR");
  assert.equal(view.getUint32(out + 4, true), 1, 'the name "/" is one byte');
  // A non-preopen fd must be EBADF (8), not a trap.
  assert.equal(wasi.fd_prestat_get(9, out), 8);
});

check("fd_write reaches the kernel as writev with the guest's iovec", () => {
  const iov = 3100;
  const data = 3200;
  new Uint8Array(memory.buffer, data, 5).set(new TextEncoder().encode("hello"));
  view.setUint32(iov, data, true);
  view.setUint32(iov + 4, 5, true);
  const out = 3300;
  assert.equal(wasi.fd_write(1, iov, 1, out), 0);
  assert.equal(view.getUint32(out, true), 5, "nwritten");
});

check("fd_seek carries a full i64 offset through the real channel", () => {
  const out = 3400;
  // 0x0123456789ABCDEF is not representable exactly as a JS number.
  assert.equal(wasi.fd_seek(4, 0x0123456789abcdefn, 0, out), 0);
  assert.equal(
    view.getBigUint64(out, true),
    0x0123456789abcdefn,
    "the kernel echoed the offset back unchanged",
  );
});

check("an undefined whence is rejected without a syscall", () => {
  assert.equal(wasi.fd_seek(4, 0n, 7, 3400), 28, "WASI EINVAL");
});

check("fd_fdstat_set_flags refuses O_SYNC (defect 3)", () => {
  assert.equal(wasi.fd_fdstat_set_flags(3, 16), 58, "WASI ENOTSUP");
});

check("sock_accept refuses honestly", () => {
  assert.equal(wasi.sock_accept(3, 0, 3400), 52, "WASI ENOSYS");
});

const calls = await drainCalls();
check("the kernel saw the expected syscalls, in order", () => {
  const nrs = calls.map((c) => c.nr);
  assert.deepEqual(
    nrs,
    [SYS_OPENAT, SYS_WRITEV, SYS_SEEK],
    `saw ${JSON.stringify(nrs)}`,
  );
  // The seek must have arrived as low/high words, not as a truncated double.
  const seek = calls[2];
  assert.equal(seek.args[1], String(0x89abcdefn), "low word");
  assert.equal(seek.args[2], String(0x01234567n), "high word");
});

check("no syscall was issued for the rejected calls", () => {
  // Three syscalls total: the invalid whence, the ENOTSUP flags, and
  // sock_accept must all have been refused before reaching the kernel.
  assert.equal(calls.length, 3);
});

kernel.postMessage({ type: "stop" });
await kernel.terminate();

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : " -- " + r.error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
