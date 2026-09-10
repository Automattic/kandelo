// K10 probes 1 and 3. Neither blocks, so both run on any thread (Node main,
// browser main, browser worker). Probe 2 needs a blocking agent and lives in
// chan-core.js.
//
// `load(name)` returns a Uint8Array of the named .wasm.

const PAGE = 65536;

// Mirrors the real WASI-process shape closely enough for the questions asked:
// the host owns the memory, the guest imports it, and there is host-owned
// space above the guest's declared minimum (in the product that space holds
// the syscall channel -- host/src/process-memory.ts computeProcessMemoryLayout).
const GUEST_MIN_PAGES = 4;
const INITIAL_PAGES = 8; // guest min + host-owned band (channel/thread arena)
const MAX_PAGES = 256;
const REGION_BYTES = 8 * PAGE; // 512 KiB, the order fork-module reserves

function newMemory() {
  return new WebAssembly.Memory({
    initial: INITIAL_PAGES,
    maximum: MAX_PAGES,
    shared: true,
  });
}

function g(type, value, mutable = false) {
  return new WebAssembly.Global({ value: type, mutable }, value);
}

export async function runProbes(load) {
  const out = {};
  const rec = (k, v) => { out[k] = v; };
  const shimBytes = await load("p1-shim.wasm");
  const guestBytes = await load("p1-guest.wasm");

  // ---------------------------------------------------------------- probe 1
  // Can a side module's EXPORTED function be used directly as another
  // instance's import, called by the guest as a wasm->wasm call, with i64
  // parameters surviving intact?
  try {
    const memory = newMemory();
    const base = 6 * PAGE; // inside the host-owned band, below the memory top
    const shim = new WebAssembly.Instance(await WebAssembly.compile(shimBytes), {
      env: {
        memory,
        __memory_base: g("i32", base),
        __stack_pointer: g("i32", base + REGION_BYTES, true),
      },
    });

    // THE QUESTION: hand the shim's exports straight through as the guest's
    // wasi_snapshot_preview1 imports. No JS wrapper anywhere.
    rec("P1.exports_are_functions",
      typeof shim.exports.fd_write === "function"
      && typeof shim.exports.fd_seek === "function");
    rec("P1.export_is_WebAssembly_Function",
      typeof WebAssembly.Function === "function"
        ? shim.exports.fd_write instanceof WebAssembly.Function
        : "WebAssembly.Function undefined on this engine");

    const guest = new WebAssembly.Instance(
      await WebAssembly.compile(guestBytes),
      {
        env: { memory },
        wasi_snapshot_preview1: {
          fd_write: shim.exports.fd_write,
          fd_seek: shim.exports.fd_seek,
        },
      },
    );

    rec("P1.guest_instantiated", true);
    rec("P1.start_returned", guest.exports._start()); // expect 11
    rec("P1.shim_region_tag", shim.exports.region_tag()); // expect 0x5157
    rec("P1.shim_region_fd", shim.exports.region_fd()); // expect 1

    // i64 fidelity across the wasm->wasm import boundary. 0x0123456789ABCDEF
    // is not exactly representable as a JS Number, so any hidden trip through
    // a JS frame corrupts it.
    const off = 0x0123456789abcdefn;
    const got = guest.exports.seek_roundtrip(off);
    rec("P1.i64_in", off.toString(16));
    rec("P1.i64_out", (typeof got === "bigint" ? got : BigInt(got)).toString(16));
    rec("P1.i64_exact", (typeof got === "bigint" ? got : BigInt(got)) === off + 1n);

    // Negative / sign-extension case, which wasi-shim.ts:202 tests explicitly.
    const neg = -1n;
    const negOut = guest.exports.seek_roundtrip(neg);
    rec("P1.i64_negative_exact",
      (typeof negOut === "bigint" ? negOut : BigInt(negOut)) === 0n);
  } catch (e) {
    rec("P1.ERROR", String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- probe 3
  // Region placement for a guest that grows its OWN memory (a WASI guest is
  // not SDK-linked, so it does not route address-space growth through the
  // kernel).
  //
  // 3a: can the host reserve by growing the shared memory ONCE, before guest
  //     instantiation, and hand the pre-growth top in as __memory_base?
  // 3b: does the guest's own memory.grow then hand it a base ABOVE that
  //     region, leaving the reservation intact?
  // 3c: does growing a SHARED memory detach the host's cached views?
  try {
    const memory = newMemory();
    const i32Before = new Int32Array(memory.buffer);
    const bytesBefore = memory.buffer.byteLength;

    // --- 3a: reserve by growing once, before the guest exists.
    const regionPages = REGION_BYTES / PAGE;
    const oldPages = memory.grow(regionPages);
    const base = oldPages * PAGE;
    rec("P3a.grow_returned_old_pages", oldPages === INITIAL_PAGES);
    rec("P3a.base", base);
    rec("P3a.byteLength_after_grow", memory.buffer.byteLength);
    rec("P3a.region_fits",
      base + REGION_BYTES <= memory.buffer.byteLength);

    const shim = new WebAssembly.Instance(await WebAssembly.compile(shimBytes), {
      env: {
        memory,
        __memory_base: g("i32", base),
        __stack_pointer: g("i32", base + REGION_BYTES, true),
      },
    });
    // Touch both ends of the reservation. A placement that is not really
    // backed traps here instead of corrupting something quietly later.
    rec("P3a.region_end_readback", shim.exports.probe_region(REGION_BYTES));
    rec("P3a.memory_base_seen", shim.exports.memory_base() === base);

    // --- 3b: now the guest grows its own memory, wasi-libc style.
    const guest = new WebAssembly.Instance(
      await WebAssembly.compile(guestBytes),
      {
        env: { memory },
        wasi_snapshot_preview1: {
          fd_write: shim.exports.fd_write,
          fd_seek: shim.exports.fd_seek,
        },
      },
    );
    const sizeBeforeGuestGrow = guest.exports.guest_memory_size();
    const guestHeapBasePages = guest.exports.guest_grow(4);
    rec("P3b.guest_sees_size", sizeBeforeGuestGrow);
    rec("P3b.guest_grow_returned", guestHeapBasePages);
    // The decisive fact: what wasi-libc's sbrk uses as its new break is the
    // PREVIOUS page count, so the guest heap starts above everything already
    // placed -- including the host's region.
    rec("P3b.guest_heap_base_is_above_region",
      guestHeapBasePages * PAGE >= base + REGION_BYTES);
    // The reservation must still be intact after the guest grew.
    rec("P3b.region_intact_after_guest_grow",
      shim.exports.region_tag() === 0x5157);
    rec("P3b.region_end_intact_after_guest_grow",
      shim.exports.probe_region(REGION_BYTES) === 0x454e44);

    // --- 3c: does growing a shared memory detach cached host views?
    rec("P3c.old_view_still_readable", (() => {
      try { i32Before[0] = 7; return i32Before[0] === 7; }
      catch (e) { return "THREW: " + String(e && e.message || e); }
    })());
    rec("P3c.old_view_length_bytes_stale",
      i32Before.length * 4 === bytesBefore
      && memory.buffer.byteLength > bytesBefore);
    rec("P3c.buffer_identity_changed",
      new Int32Array(memory.buffer).length * 4 === memory.buffer.byteLength);
  } catch (e) {
    rec("P3.ERROR", String((e && e.stack) || e));
  }

  // 3d: the alternative placement -- can the host place the region INSIDE the
  // already-committed memory without growing at all, in the host-owned band
  // ABOVE the guest's declared memory minimum? That band is not hypothetical:
  // it is where computeProcessMemoryLayout already puts the syscall channel
  // and the thread arena (host/src/process-memory.ts). If this works, a kernel
  // SYS_MMAP is unnecessary rather than merely risky.
  try {
    const memory = newMemory();
    const base = GUEST_MIN_PAGES * PAGE; // first byte above the guest's minimum
    const bandBytes = (INITIAL_PAGES - GUEST_MIN_PAGES) * PAGE;
    const shim = new WebAssembly.Instance(await WebAssembly.compile(shimBytes), {
      env: {
        memory,
        __memory_base: g("i32", base),
        __stack_pointer: g("i32", base + bandBytes, true),
      },
    });
    rec("P3d.in_place_base", base);
    rec("P3d.band_bytes", bandBytes);
    rec("P3d.base_is_above_guest_minimum", base >= GUEST_MIN_PAGES * PAGE);
    rec("P3d.band_within_committed_memory",
      base + bandBytes <= memory.buffer.byteLength);
    rec("P3d.in_place_region_end_readback",
      shim.exports.probe_region(bandBytes)); // expect 0x454e44 = 4542020
  } catch (e) {
    rec("P3d.ERROR", String((e && e.stack) || e));
  }

  return out;
}
