// K10 probe 4 — the `wasiModuleDefinesMemory` case.
//
// Probes 1-3 all assume the guest IMPORTS its memory, which is what
// `worker-main.ts` requires today. But `host/src/wasi-detect.ts` distinguishes
// two categories, and the second one -- a module that defines and exports its
// own memory, which is what a default wasi-sdk link emits -- owns its address
// space outright. If a co-resident side module cannot serve that category, the
// migration must say so rather than quietly assuming category one.
//
// Two obstacles are separable, so the probe separates them:
//   (1) instantiation order. The side module needs the guest's memory at ITS
//       instantiation; the guest needs the side module's exports at ITS
//       instantiation. That is a cycle.
//   (2) shared-ness. A default wasi-sdk memory is not shared, and the syscall
//       channel needs `memory.atomic.wait32` plus JS `Atomics`, both of which
//       need a shared memory.

const PAGE = 65536;

function g(type, value, mutable = false) {
  return new WebAssembly.Global({ value: type, mutable }, value);
}

export async function runProbe4(load) {
  const out = {};
  const rec = (k, v) => { out[k] = v; };
  const err = (e) => String((e && e.message) || e);

  const shimBytes = await load("p1-shim.wasm");
  const ownBytes = await load("p4-guest-owns.wasm");
  const ownSharedBytes = await load("p4-guest-owns-shared.wasm");
  const unsharedChanBytes = await load("p4-chan-unshared.wasm");

  const shimModule = await WebAssembly.compile(shimBytes);
  const ownModule = await WebAssembly.compile(ownBytes);
  const ownSharedModule = await WebAssembly.compile(ownSharedBytes);

  // What Kandelo's own detector says about each fixture, so the probe is
  // provably testing the category it claims to test.
  rec("P4.own_exports_memory",
    WebAssembly.Module.exports(ownModule).some(
      (e) => e.name === "memory" && e.kind === "memory"));
  rec("P4.own_imports_memory",
    WebAssembly.Module.imports(ownModule).some(
      (i) => i.module === "env" && i.name === "memory"));

  // ---- 4a: the cycle. Can the side module be instantiated at all without a
  // memory to import? It cannot: the guest's memory does not exist until the
  // guest is instantiated, and the guest cannot be instantiated without the
  // side module's exports.
  try {
    new WebAssembly.Instance(shimModule, { env: {} });
    rec("P4a.shim_without_memory", "UNEXPECTEDLY SUCCEEDED");
  } catch (e) {
    rec("P4a.shim_without_memory_throws", err(e));
  }
  try {
    new WebAssembly.Instance(ownModule, {});
    rec("P4a.guest_without_shim", "UNEXPECTEDLY SUCCEEDED");
  } catch (e) {
    rec("P4a.guest_without_shim_throws", err(e));
  }

  // ---- 4b: the cycle can only be broken by a mutable JS indirection: give
  // the guest a JS closure that forwards to the side module, which is
  // instantiated afterwards over the guest's now-existing memory. This WORKS,
  // and that is the point -- it works by reinstating a JS frame on every WASI
  // call, which is exactly the thing the migration removes.
  try {
    let live = null;
    const trampoline = (...args) => {
      if (!live) throw new Error("called before the side module existed");
      return live.fd_write(...args);
    };
    const guest = new WebAssembly.Instance(ownModule, {
      wasi_snapshot_preview1: { fd_write: trampoline },
    });
    const guestMemory = guest.exports.memory;
    rec("P4b.guest_memory_is_memory", guestMemory instanceof WebAssembly.Memory);
    rec("P4b.guest_buffer_is_shared",
      guestMemory.buffer instanceof
        (typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : ArrayBuffer)
      && guestMemory.buffer.constructor.name === "SharedArrayBuffer");

    // The host can only place the side module INSIDE memory the guest already
    // owns and may already be using -- it never chose the layout.
    const base = 6 * PAGE;
    const shim = new WebAssembly.Instance(shimModule, {
      env: {
        memory: guestMemory,
        __memory_base: g("i32", base),
        __stack_pointer: g("i32", base + 2 * PAGE, true),
      },
    });
    live = shim.exports;
    rec("P4b.two_phase_via_js_trampoline", guest.exports._start()); // expect 11
    rec("P4b.requires_js_frame_per_call", true);
  } catch (e) {
    rec("P4b.ERROR", err(e));
  }

  // ---- 4c: shared-ness. Is `memory.atomic.wait32` usable over a NON-shared
  // memory? The module validates (p4-chan-unshared.wasm assembled), so the
  // answer is a runtime one.
  try {
    const mem = new WebAssembly.Memory({ initial: 8, maximum: 256 }); // not shared
    const chan = new WebAssembly.Instance(
      await WebAssembly.compile(unsharedChanBytes), { env: { memory: mem } });
    rec("P4c.unshared_module_instantiated", true);
    try {
      // Expect a trap: waiting on a non-shared memory has no other agent.
      rec("P4c.unshared_bare_wait", chan.exports.bare_wait(0, 0, 1_000_000n));
    } catch (e) {
      rec("P4c.unshared_bare_wait_throws", err(e));
    }
    try {
      rec("P4c.unshared_notify", chan.exports.store_and_notify(0, 5));
    } catch (e) {
      rec("P4c.unshared_notify_throws", err(e));
    }
    // And the JS half of the channel protocol, which the kernel worker drives.
    // `Atomics.notify` is used rather than `Atomics.wait` because notify is
    // permitted on any agent, so a failure here is about shared-ness and not
    // about whether this thread is allowed to block.
    rec("P4c.buffer_kind", mem.buffer.constructor.name);
    try {
      const i32 = new Int32Array(mem.buffer);
      rec("P4c.js_Atomics_notify_on_unshared", Atomics.notify(i32, 0, 1));
    } catch (e) {
      rec("P4c.js_Atomics_notify_on_unshared_throws", err(e));
    }
  } catch (e) {
    rec("P4c.ERROR", err(e));
  }

  // ---- 4d: the friendlier sub-case. If a guest defines its own memory but
  // declares it SHARED, obstacle (2) disappears and only the cycle remains.
  try {
    let live = null;
    const guest = new WebAssembly.Instance(ownSharedModule, {
      wasi_snapshot_preview1: {
        fd_write: (...a) => live.fd_write(...a),
      },
    });
    const guestMemory = guest.exports.memory;
    rec("P4d.shared_self_defined_buffer",
      guestMemory.buffer.constructor.name);
    const base = 6 * PAGE;
    const shim = new WebAssembly.Instance(shimModule, {
      env: {
        memory: guestMemory,
        __memory_base: g("i32", base),
        __stack_pointer: g("i32", base + 2 * PAGE, true),
      },
    });
    live = shim.exports;
    rec("P4d.two_phase_shared", guest.exports._start()); // expect 11
    const i32 = new Int32Array(guestMemory.buffer);
    rec("P4d.js_Atomics_notify_on_self_defined_shared",
      (() => { try { return Atomics.notify(i32, 0, 1); }
               catch (e) { return "THREW: " + err(e); } })());
  } catch (e) {
    rec("P4d.ERROR", err(e));
  }

  return out;
}
