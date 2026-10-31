/**
 * Unit tests for the SAB-backed bo store surface added in
 * `host(dri): SAB-backed bo store — closes byte-verify across fork`.
 *
 * These tests exercise `GbmBoRegistry` in isolation, without booting
 * a kernel — they verify the cross-pid sync semantics that the
 * `dumb_roundtrip` end-to-end spec depends on, but at a granularity
 * that pinpoints a regression to one method (bind / unbind / prime
 * / findBindingByAddr / resolver wiring) rather than "the byte-verify
 * failed somewhere in a fork."
 */
import { describe, expect, it, vi } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { mergeChangedByteRuns } from "../src/shared-byte-runs.js";

const BO_SIZE = 4096;
const BO_ADDR = 0;

describe("BO publication copies", () => {
  it.each([0, 1])("does not copy an unchanged mapping at address %i", (addr) => {
    const memory = newMemory();
    const registry = new GbmBoRegistry({ getProcessMemory: () => memory });
    registry.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    registry.bind(100, 1, addr, BO_SIZE);
    registry.primeBindFromSab(100, 1, memory, addr);
    const copy = vi.spyOn(Uint8Array.prototype, "set");
    try {
      registry.syncToSab(1);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
  });

  it("keeps an unchanged stale reader's baseline until it imports a publication", () => {
    const memA = newMemory(), memB = newMemory();
    const reg = new GbmBoRegistry({ getProcessMemory: pid => pid === 100 ? memA : memB });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    new Uint8Array(memA.buffer)[17] = 91;
    reg.syncToSab(1);
    const copy = vi.spyOn(Uint8Array.prototype, "set");
    try {
      reg.syncToSab(1);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
    expect(new Uint8Array(memB.buffer)[17]).toBe(0);
    expect(reg.pixelView(1)![17]).toBe(91);
    reg.syncImportsForPid(200, memB);
    expect(new Uint8Array(memB.buffer)[17]).toBe(91);
    new Uint8Array(memB.buffer)[18] = 73;
    reg.syncImportsForPid(100, memA);
    expect([...new Uint8Array(memA.buffer).slice(17, 19)]).toEqual([91, 73]);
  });

  it("leaves stores beyond a limited publication pending for the next full scan", () => {
    const memory = newMemory();
    const registry = new GbmBoRegistry({ getProcessMemory: () => memory });
    registry.create({ pid: 100, bo_id: 1, size: 32, w: 4, h: 2, stride: 16 });
    registry.bind(100, 1, 1024, 16, 8);
    registry.primeBindFromSab(100, 1, memory, 1024);
    const source = new Uint8Array(memory.buffer, 1024, 16);
    source[2] = 91;
    source[10] = 73;
    registry.syncToSab(1, 16);
    expect(registry.pixelView(1)![10]).toBe(91);
    expect(registry.pixelView(1)![18]).toBe(0);
    const copy = vi.spyOn(Uint8Array.prototype, "set");
    try {
      registry.syncToSab(1, 16);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
    registry.syncToSab(1);
    expect(registry.pixelView(1)![10]).toBe(91);
    expect(registry.pixelView(1)![18]).toBe(73);
  });

  it("still refreshes a reader after writes through a retained canonical view", () => {
    const memory = newMemory();
    const registry = new GbmBoRegistry({ getProcessMemory: () => memory });
    registry.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    const canonical = registry.pixelView(1)!;
    registry.bind(100, 1, 0, BO_SIZE);
    registry.primeBindFromSab(100, 1, memory, 0);
    registry.bind(100, 1, BO_SIZE, BO_SIZE);
    registry.primeBindFromSab(100, 1, memory, BO_SIZE);
    canonical[17] = 91;
    registry.syncImportsForPid(100, memory);
    expect(new Uint8Array(memory.buffer)[17]).toBe(91);
    expect(new Uint8Array(memory.buffer)[BO_SIZE + 17]).toBe(91);
    registry.syncToSab(1);
    expect(canonical[17]).toBe(91);
  });
});

function newMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
}

function fillPattern(mem: WebAssembly.Memory, addr: number, len: number, seed: number): void {
  const view = new Uint8Array(mem.buffer, addr, len);
  for (let i = 0; i < len; i++) view[i] = (seed + i) & 0xff;
}

function readPattern(mem: WebAssembly.Memory, addr: number, len: number): Uint8Array {
  return new Uint8Array(mem.buffer.slice(addr, addr + len));
}

function expectPattern(actual: Uint8Array, seed: number): void {
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== ((seed + i) & 0xff)) {
      throw new Error(`pattern mismatch at byte ${i}: got 0x${actual[i].toString(16)}, want 0x${((seed + i) & 0xff).toString(16)}`);
    }
  }
}

describe("GbmBoRegistry — SAB-backed bo store", () => {
  it("bind alone does NOT touch the binding's Memory (timing-fix invariant)", () => {
    // Regression guard for the postmortem in the PR commit message:
    // writing SAB → Memory inside bind() gets clobbered by
    // ensureProcessMemoryCovers's anonymous-mmap zero-fill that runs
    // AFTER the syscall returns. The contract is: bind() is metadata
    // only; the SAB → Memory prime is deferred to primeBindFromSab,
    // which the kernel-worker calls post-zero-fill.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x10);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE); // flushes memA → SAB

    // Sentinel value that bind() must NOT overwrite.
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x7e);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x7e);
  });

  it("primeBindFromSab copies the SAB into the bound pid's Memory at [addr, len)", () => {
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x21);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x21);
  });

  it("unbind flushes the unbinding pid's bytes into the SAB", () => {
    // A subsequent prime in a DIFFERENT pid sees the bytes the
    // unbinding pid wrote. This is the only path that gets bytes
    // into the SAB when the writer never overlaps a reader's bind.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x42);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x42);
  });

  it("primeBindFromSab flushes OTHER currently-bound pids before priming", () => {
    // The dumb_roundtrip flow: parent never unbinds before fork.
    // The cross-pid flush inside primeBindFromSab is what sources
    // the SAB from the writer's still-live Memory.
    const memParent = newMemory();
    const memChild = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memParent : pid === 200 ? memChild : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memParent);
    fillPattern(memParent, BO_ADDR, BO_SIZE, 0xa5);

    // Parent has NOT unbound. Child binds + primes.
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memChild);

    expectPattern(readPattern(memChild, BO_ADDR, BO_SIZE), 0xa5);
  });

  it("findBindingByAddr returns the bo_id for a live (pid, addr) and undefined otherwise", () => {
    const reg = new GbmBoRegistry();
    reg.create({ pid: 100, bo_id: 7, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 7, 0x2000, BO_SIZE);

    expect(reg.findBindingByAddr(100, 0x2000)).toBe(7);
    expect(reg.findBindingByAddr(100, 0x1000)).toBeUndefined(); // wrong addr
    expect(reg.findBindingByAddr(999, 0x2000)).toBeUndefined(); // wrong pid

    reg.unbind(100, 7, 0x2000, BO_SIZE);
    expect(reg.findBindingByAddr(100, 0x2000)).toBeUndefined(); // post-unbind
  });

  it("pure-metadata mode (no resolver) records bindings without touching any Memory", () => {
    // The browser main-thread mirror constructs GbmBoRegistry with
    // no resolver. bind/unbind/primeBindFromSab MUST be safe in that
    // mode — they just skip the Memory-side work.
    const memB = newMemory();
    fillPattern(memB, BO_ADDR, BO_SIZE, 0xee); // sentinel

    const reg = new GbmBoRegistry(); // no resolver
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    expect(() => reg.unbind(100, 1, BO_ADDR, BO_SIZE)).not.toThrow();

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    // primeBindFromSab does SAB → memB copy regardless of resolver
    // (resolver only gates the cross-pid flush in the OTHER-pids
    // loop). With no resolver and no prior unbind reaching memB,
    // the SAB is all zeros — primeBindFromSab overwrites memB's
    // sentinel with zeros.
    expect(() => reg.primeBindFromSab(200, 1, memB)).not.toThrow();
    const view = readPattern(memB, BO_ADDR, BO_SIZE);
    for (let i = 0; i < view.length; i++) expect(view[i]).toBe(0);
  });

  it("resolver returning undefined for a pid silently skips that pid's flush", () => {
    // The contract documented on ProcessMemoryResolver: returning
    // undefined for a bound pid signals "process has gone away,
    // skip the sync." The bind-prime path on a peer pid must NOT
    // throw and must continue with whatever the SAB already holds.
    const memChild = newMemory();
    fillPattern(memChild, BO_ADDR, BO_SIZE, 0xcd);
    const reg = new GbmBoRegistry({
      // Pid 100 (the writer) is unreachable — simulate "parent exited
      // before child's bind reached the prime hook." Pid 200 (child)
      // is reachable but only as a self-flush target, which the
      // primeBindFromSab loop excludes.
      getProcessMemory: (_pid) => undefined,
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);

    expect(() => reg.primeBindFromSab(200, 1, memChild)).not.toThrow();
    // SAB is zero (no flush ever succeeded); primeBindFromSab
    // overwrites memChild's 0xcd sentinel with zeros.
    const view = readPattern(memChild, BO_ADDR, BO_SIZE);
    for (let i = 0; i < view.length; i++) expect(view[i]).toBe(0);
  });

  it("setProcessMemoryResolver wires the resolver after construction", () => {
    // CentralizedKernelWorker uses this setter from its constructor
    // (the registry is built before the worker's process map exists).
    // A resolver set this way must drive the same flush path that a
    // constructor-injected resolver does.
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry(); // constructed with no resolver
    reg.setProcessMemoryResolver((pid) =>
      pid === 100 ? memA : pid === 200 ? memB : undefined,
    );

    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x33);
    reg.unbind(100, 1, BO_ADDR, BO_SIZE);

    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x33);
  });

  it("syncFromMemory flushes every bound pid's Memory into the SAB", () => {
    const memA = newMemory();
    const memB = newMemory();
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);

    fillPattern(memA, BO_ADDR, BO_SIZE, 0x42);
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x42); // both writers agree
    reg.syncFromMemory(1);
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x42);

    fillPattern(memA, BO_ADDR, BO_SIZE, 0x91);
    fillPattern(memB, BO_ADDR, BO_SIZE, 0x91);
    reg.syncFromMemory(1);
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x91);
  });

  it("syncFromMemory is a no-op for unknown bo_id", () => {
    const reg = new GbmBoRegistry();
    expect(() => reg.syncFromMemory(999)).not.toThrow();
  });

  it("releases only one process ownership while preserving shared bo bytes", () => {
    const memParent = newMemory();
    const memChild = newMemory();
    const events: string[] = [];
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) =>
        pid === 100 ? memParent : pid === 200 ? memChild : undefined,
    });
    reg.onChange((pid, bo, event) => events.push(`${pid}:${bo}:${event}`));
    reg.create({
      pid: 100,
      bo_id: 1,
      size: BO_SIZE,
      w: 16,
      h: 16,
      stride: 64,
    });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memParent);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memChild);
    fillPattern(memParent, BO_ADDR, BO_SIZE, 0x61);

    reg.releaseProcess(100);

    expect(reg.get(100, 1)).toBeUndefined();
    expect(reg.get(200, 1)?.binding).toEqual({
      addr: BO_ADDR,
      len: BO_SIZE,
    });
    reg.primeBindFromSab(200, 1, memChild);
    expectPattern(readPattern(memChild, BO_ADDR, BO_SIZE), 0x61);
    expect(events).toContain("100:1:unbind");
    expect(events).not.toContain("100:1:destroy");
  });

  it("keeps storage until kernel destruction, even after every observed mapping retires", () => {
    const mem = newMemory();
    const events: string[] = [];
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => pid === 100 ? mem : undefined,
    });
    reg.onChange((pid, bo, event) => events.push(`${pid}:${bo}:${event}`));
    reg.create({
      pid: 100,
      bo_id: 1,
      size: BO_SIZE,
      w: 16,
      h: 16,
      stride: 64,
    });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, mem);

    reg.releaseProcess(100);

    expect(reg.get(100, 1)).toBeUndefined();
    expect(events).not.toContain("100:1:destroy");
    expect(reg.pixelView(1)).toBeDefined();
    reg.destroy(100, 1);
    expect(events.at(-1)).toBe("100:1:destroy");
    expect(reg.pixelView(1)).toBeUndefined();
  });
});

describe("GbmBoRegistry — foreign-texture coherence helpers", () => {
  function twoPidSetup(): { memA: WebAssembly.Memory; memB: WebAssembly.Memory; reg: GbmBoRegistry } {
    const memA = newMemory(); // creator (the wl_shm client, the writer)
    const memB = newMemory(); // importer (the compositor, a reader)
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) => (pid === 100 ? memA : pid === 200 ? memB : undefined),
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    return { memA, memB, reg };
  }

  it("dims() reports geometry without requiring pid membership", () => {
    const { reg } = twoPidSetup();
    // The foreign-texture path holds only a kernel bo id (PRIME import
    // without an mmap), so this must not need a consumer-set pid.
    expect(reg.dims(1)).toEqual({ w: 16, h: 16, stride: 64 });
    expect(reg.dims(2)).toBeUndefined();
  });

  it("syncToSab publishes a writer without flushing an unchanged stale reader", () => {
    const { memA, memB, reg } = twoPidSetup();
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x11);
    reg.primeBindFromSab(200, 1, memB);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x30); // newer writer frame; B stays unchanged
    reg.syncToSab(1);
    // An importer flush after the creator's would clobber fresh bytes
    // with 0x99 — the texture bind must see the producer's pixels.
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x30);
  });

  it("hasStaleableImports tracks concurrent mappings without assuming a writer", () => {
    const { reg, memA, memB } = twoPidSetup();
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    expect(reg.hasStaleableImports(100)).toBe(false); // only one mapping
    expect(reg.hasStaleableImports(200)).toBe(false); // not bound yet
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expect(reg.hasStaleableImports(200)).toBe(true);
    reg.unbind(100, 1);
    expect(reg.hasStaleableImports(200)).toBe(false); // nothing left to go stale from
  });

  it.each(["unmap", "exit", "exec"])("refreshes a survivor after the last writer retires through %s", retirement => {
    const { memA, memB, reg } = twoPidSetup();
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x73);
    if (retirement === "exit") reg.releaseProcess(100);
    else if (retirement === "exec") reg.releaseProcessMappings(100);
    else reg.unbind(100, 1);
    // Retirement publishes the writer's final bytes. The remaining reader
    // still needs a readiness refresh even though it is now the only mapping.
    expect(reg.hasStaleableImports(200)).toBe(true);
    reg.syncImportsForPid(200, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x73);
    expect(reg.hasStaleableImports(200)).toBe(false);
  });

  it("syncImportsForPid delivers the creator's latest bytes into the importer's mapping", () => {
    const { memA, memB, reg } = twoPidSetup();
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    // The creator paints AFTER both binds — without the coherence pass
    // the importer only ever sees its bind-time snapshot.
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x42);
    reg.syncImportsForPid(200, memB);
    expectPattern(readPattern(memB, BO_ADDR, BO_SIZE), 0x42);
  });

  it("hasStaleableImports tracks bindings through bind, unbind, release and destroy", () => {
    const { reg, memA, memB } = twoPidSetup();
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    expect(reg.hasStaleableImports(300)).toBe(false); // maps nothing
    expect(reg.hasStaleableImports(200)).toBe(true);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);               // re-bind: not double-counted
    reg.unbind(200, 1);
    expect(reg.hasStaleableImports(200)).toBe(false);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    reg.destroy(100, 1);                              // the bo goes away entirely
    expect(reg.hasStaleableImports(200)).toBe(false);
    reg.create({ pid: 100, bo_id: 2, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 2, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 2, memA);
    reg.bind(200, 2, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 2, memB);
    reg.releaseProcess(200);
    expect(reg.hasStaleableImports(200)).toBe(false);
  });

  it("a process reusing an exited creator's pid is an importer, not the writer", () => {
    // The creator (100) exits while the compositor (200) still holds the
    // bo. The kernel then recycles pid 100 for an unrelated process that
    // imports and maps the same bo. Treating it as the creator would flush
    // its stale mapping over the last frame and skip refreshing it.
    const memA = newMemory();
    const memB = newMemory();
    const memReused = newMemory();
    let creatorAlive = true;
    const reg = new GbmBoRegistry({
      getProcessMemory: (pid) =>
        pid === 100 ? (creatorAlive ? memA : memReused) : pid === 200 ? memB : undefined,
    });
    reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
    reg.bind(100, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(100, 1, memA);
    reg.bind(200, 1, BO_ADDR, BO_SIZE);
    reg.primeBindFromSab(200, 1, memB);
    fillPattern(memA, BO_ADDR, BO_SIZE, 0x51);   // the creator's final frame
    reg.releaseProcess(100);
    creatorAlive = false;

    reg.bind(100, 1, BO_ADDR, BO_SIZE);          // the reused pid imports
    reg.primeBindFromSab(100, 1, memReused);
    reg.syncToSab(1);
    expectPattern(reg.pixelView(1)!.slice(0, BO_SIZE), 0x51);
    expect(reg.hasStaleableImports(100)).toBe(true);
    reg.syncImportsForPid(100, memReused);
    expectPattern(readPattern(memReused, BO_ADDR, BO_SIZE), 0x51);
  });
});


it("exec flushes the old mapping and permits the retained GEM handle to bind new memory", () => {
  let active = newMemory();
  const old = active;
  const reg = new GbmBoRegistry({ getProcessMemory: () => active });
  reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
  reg.bind(100, 1, BO_ADDR, BO_SIZE);
  reg.primeBindFromSab(100, 1, old);
  fillPattern(old, BO_ADDR, BO_SIZE, 0x61);
  reg.releaseProcessMappings(100);
  expect(reg.get(100, 1)).toBeDefined();
  expect(reg.get(100, 1)?.binding).toBeNull();
  expectPattern(reg.pixelView(1)!, 0x61);
  // Retired memory must never overwrite the preserved backing.
  fillPattern(old, BO_ADDR, BO_SIZE, 0xa5);
  active = newMemory();
  reg.bind(100, 1, BO_ADDR, BO_SIZE);
  reg.primeBindFromSab(100, 1, active);
  expectPattern(readPattern(active, BO_ADDR, BO_SIZE), 0x61);
  fillPattern(active, BO_ADDR, BO_SIZE, 0x72);
  reg.syncToSab(1);
  expectPattern(reg.pixelView(1)!, 0x72);
  reg.releaseProcess(100);
  expect(reg.get(100, 1)).toBeUndefined();
});

it("merges importer writes and disjoint changes in one page while preserving stale readers", () => {
  const a = newMemory(), b = newMemory();
  const reg = new GbmBoRegistry({ getProcessMemory: pid => pid === 100 ? a : b });
  reg.create({ pid: 100, bo_id: 1, size: BO_SIZE, w: 16, h: 16, stride: 64 });
  reg.bind(100, 1, 0, BO_SIZE);
  reg.primeBindFromSab(100, 1, a);
  reg.bind(200, 1, 0, BO_SIZE);
  reg.primeBindFromSab(200, 1, b);
  const av = new Uint8Array(a.buffer), bv = new Uint8Array(b.buffer);
  av[4] = 10; bv[8] = 20;
  reg.syncToSab(1);
  expect(Array.from(reg.pixelView(1)!.slice(4, 9))).toEqual([10, 0, 0, 0, 20]);
  // The active importer changes again; an unchanged allocator must not erase it.
  bv[8] = 30;
  reg.syncToSab(1);
  expect(reg.pixelView(1)![4]).toBe(10);
  expect(reg.pixelView(1)![8]).toBe(30);
  reg.unbind(100, 1);
  expect(reg.pixelView(1)![8]).toBe(30);
  reg.releaseProcess(200);
  expect(reg.pixelView(1)![8]).toBe(30);
  reg.destroy(200, 1);
  expect(reg.pixelView(1)).toBeUndefined();
});

describe("device writes into mapped CPU storage", () => {
  it("refreshes every mapped reader and its publication snapshot", () => {
    const memories = new Map([[100, newMemory()], [200, newMemory()]]);
    const reg = new GbmBoRegistry({getProcessMemory: pid => memories.get(pid)});
    reg.create({pid:100,bo_id:1,size:16,w:2,h:2,stride:8});
    reg.bind(100,1,8,16); reg.primeBindFromSab(100,1,memories.get(100)!);
    reg.bind(200,1,32,16); reg.primeBindFromSab(200,1,memories.get(200)!);
    fillPattern(memories.get(100)!,8,16,90);
    const pixels = Uint8Array.from({length:16}, (_, index) => index + 1);
    expect(reg.publishDevicePixels(1,pixels)).toBe(true);
    expect(readPattern(memories.get(100)!,8,16)).toEqual(pixels);
    expect(readPattern(memories.get(200)!,32,16)).toEqual(pixels);
    reg.syncToSab(1);
    expect(reg.pixelView(1)).toEqual(pixels);
    pixels.fill(0);
    expect(reg.pixelView(1)).toEqual(Uint8Array.from({length:16},(_,index)=>index+1));
  });
  it("rejects short input and any stale mapping before changing canonical or peer bytes", () => {
    const a = newMemory(), b = new WebAssembly.Memory({initial:2,maximum:2,shared:true});
    const memories = new Map([[100,a],[200,b]]);
    const reg = new GbmBoRegistry({getProcessMemory: pid => memories.get(pid)});
    reg.create({pid:100,bo_id:1,size:16,w:2,h:2,stride:8});
    reg.bind(100,1,8,16); reg.primeBindFromSab(100,1,memories.get(100)!);
    reg.bind(200,1,65536,16); reg.primeBindFromSab(200,1,memories.get(200)!);
    expect(reg.publishDevicePixels(1,new Uint8Array(15))).toBe(false);
    expect(reg.publishDevicePixels(99,new Uint8Array(16))).toBe(false);
    memories.set(200,newMemory());
    expect(reg.publishDevicePixels(1,new Uint8Array(16).fill(9))).toBe(false);
    expect(reg.pixelView(1)).toEqual(new Uint8Array(16));
    expect(readPattern(a,8,16)).toEqual(new Uint8Array(16));
    expect(readPattern(b,65536,16)).toEqual(new Uint8Array(16));
  });
});

it("does not publish device pixels into a mapping awaiting mmap zero-fill",()=>{
  const a=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
  const b=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
  const reg=new GbmBoRegistry({getProcessMemory:pid=>pid===1?a:b});
  reg.create({pid:1,bo_id:1,size:16,w:2,h:2,stride:8});
  reg.bind(1,1,0,16);reg.primeBindFromSab(1,1,a);
  reg.bind(2,1,0,16); // Worker has not completed mmap's zero-fill/prime fence.
  const frame=new Uint8Array(16).fill(7);
  expect(reg.publishDevicePixels(1,frame)).toBe(true);
  new Uint8Array(b.buffer,0,16).fill(0); // Normal pending mmap zero-fill.
  reg.syncToSab(1); // A device/readiness tick must not publish that zero-fill.
  expect(reg.pixelView(1)).toEqual(frame);
  reg.primeBindFromSab(2,1,b);
  expect(new Uint8Array(b.buffer,0,16)).toEqual(frame);
});

it("keeps both mappings of one BO in the same process authoritative",()=>{
  const memory=new WebAssembly.Memory({initial:1,maximum:1});
  const registry=new GbmBoRegistry({getProcessMemory:()=>memory});
  registry.create({pid:7,bo_id:41,size:16,w:2,h:2,stride:8});
  registry.bind(7,41,1024,16);registry.primeBindFromSab(7,41,memory);
  registry.bind(7,41,2048,16);registry.primeBindFromSab(7,41,memory);
  const first=new Uint8Array(memory.buffer,1024,16),second=new Uint8Array(memory.buffer,2048,16);
  first[0]=71;registry.syncToSab(41);
  expect(registry.pixelView(41)![0]).toBe(71);
  second[1]=81;registry.syncToSab(41);
  expect([...registry.pixelView(41)!].slice(0,2)).toEqual([71,81]);
  registry.syncImportsForPid(7,memory);
  expect([...first].slice(0,2)).toEqual([71,81]);expect([...second].slice(0,2)).toEqual([71,81]);
});

it("retires exactly one mapping and primes the requested address after zero-fill",()=>{
  const memory=new WebAssembly.Memory({initial:1,maximum:1});
  const registry=new GbmBoRegistry({getProcessMemory:()=>memory});
  registry.create({pid:7,bo_id:41,size:16,w:2,h:2,stride:8});
  registry.pixelView(41)!.fill(42);
  registry.bind(7,41,1024,16);registry.bind(7,41,2048,16);
  registry.primeBindFromSab(7,41,memory,1024);
  expect([...new Uint8Array(memory.buffer,1024,16)]).toEqual(Array(16).fill(42));
  expect([...new Uint8Array(memory.buffer,2048,16)]).toEqual(Array(16).fill(0));
  registry.syncToSab(41);expect([...registry.pixelView(41)!]).toEqual(Array(16).fill(42));
  registry.primeBindFromSab(7,41,memory,2048);
  registry.unbind(7,41,1024);
  expect(registry.findBindingByAddr(7,1024)).toBeUndefined();
  expect(registry.findBindingByAddr(7,2048)).toBe(41);
  new Uint8Array(memory.buffer,2048,16)[0]=91;registry.syncToSab(41);
  expect(registry.pixelView(41)![0]).toBe(91);
  registry.releaseProcessMappings(7);expect(registry.findBindingByAddr(7,2048)).toBeUndefined();
});

it("primes inherited aliases only after clone bytes are ready and rejects an invalid sibling atomically",()=>{
  const parent=new WebAssembly.Memory({initial:1,maximum:1});
  const child=new WebAssembly.Memory({initial:1,maximum:1});
  const registry=new GbmBoRegistry({getProcessMemory:pid=>pid===7?parent:child});
  registry.create({pid:7,bo_id:41,size:16,w:2,h:2,stride:8});
  registry.bind(7,41,1024,16);registry.primeBindFromSab(7,41,parent,1024);
  new Uint8Array(parent.buffer,1024,16).fill(71);
  registry.bind(8,41,1024,16);registry.bind(8,41,65530,16);
  new Uint8Array(child.buffer,1024,16).fill(123);
  expect(registry.primeProcessMappings(8,child)).toBe(false);
  expect([...new Uint8Array(child.buffer,1024,16)]).toEqual(Array(16).fill(123));
  registry.syncToSab(41);expect([...registry.pixelView(41)!]).toEqual(Array(16).fill(71));
  registry.unbind(8,41,65530);expect(registry.primeProcessMappings(8,child)).toBe(true);
  expect([...new Uint8Array(child.buffer,1024,16)]).toEqual(Array(16).fill(71));
  new Uint8Array(child.buffer,1024,16)[1]=81;registry.syncImportsForPid(7,parent);
  expect([...new Uint8Array(parent.buffer,1024,2)]).toEqual([71,81]);
});

it("retains canonical offsets and coherence in both partial-unmap fragments", () => {
  const page = 65536;
  const memory = new WebAssembly.Memory({initial: 4, maximum: 4, shared: true});
  const bytes = new Uint8Array(memory.buffer);
  const registry = new GbmBoRegistry({getProcessMemory: pid => pid === 100 ? memory : undefined});
  registry.create({pid: 100, bo_id: 901, size: 3*page, w: 256, h: 192, stride: 1024});
  registry.pixelView(901)![0] = 17;
  registry.pixelView(901)![page] = 29;
  registry.pixelView(901)![2*page] = 59;
  expect(registry.bind(100,901,page,3*page)).toBe(0);
  registry.primeBindFromSab(100,901,memory,page);
  registry.unbind(100,901,2*page,page);
  expect(registry.get(100,901)?.binding).toEqual({addr:3*page,len:page,boOffset:2*page});
  bytes[2*page] = 88; // This removed page no longer owns any device bytes.
  bytes[3*page] = 99;
  registry.syncToSab(901);
  expect(registry.pixelView(901)![page]).toBe(29);
  expect(registry.pixelView(901)![2*page]).toBe(99);
  const device = registry.pixelView(901)!.slice(); device[0]=41; device[2*page]=61;
  expect(registry.publishDevicePixels(901,device)).toBe(true);
  expect(bytes[page]).toBe(41);
  expect(bytes[2*page]).toBe(88);
  expect(bytes[3*page]).toBe(61);
  const child = new WebAssembly.Memory({initial:2,maximum:2,shared:true});
  expect(registry.bind(101,901,page,page,2*page)).toBe(0);
  expect(registry.primeProcessMappings(101,child)).toBe(true);
  expect(new Uint8Array(child.buffer)[page]).toBe(61);
});

it("preserves a pending reader created while retiring another alias", () => {
  const page = 65536;
  const memory = new WebAssembly.Memory({initial: 5, maximum: 5});
  const bytes = new Uint8Array(memory.buffer);
  const registry = new GbmBoRegistry({getProcessMemory: () => memory});
  registry.create({pid: 100, bo_id: 902, size: 2*page, w: 256, h: 128, stride: 1024});
  registry.pixelView(902)![page] = 17;
  for (const addr of [page, 3*page]) {
    registry.bind(100,902,addr,2*page);
    registry.primeBindFromSab(100,902,memory,addr);
  }
  bytes[2*page] = 59;
  registry.unbind(100,902,page,3*page);
  expect(bytes[4*page]).toBe(17);
  expect(registry.hasStaleableImports(100)).toBe(true);
  registry.syncImportsForPid(100,memory);
  expect(bytes[4*page]).toBe(59);
});

it("retires replaced VMA bytes before a different BO can overwrite them", () => {
  const page=65536, memory=new WebAssembly.Memory({initial:6,maximum:6});
  const bytes=new Uint8Array(memory.buffer);
  const registry=new GbmBoRegistry({getProcessMemory:()=>memory});
  registry.create({pid:100,bo_id:910,size:3*page,w:256,h:192,stride:1024});
  registry.create({pid:100,bo_id:911,size:page,w:256,h:64,stride:1024});
  registry.bind(100,910,page,3*page);
  registry.primeBindFromSab(100,910,memory,page);
  bytes[page]=41;bytes[2*page]=55;bytes[3*page]=61;
  registry.pixelView(911)![0]=99;
  expect(registry.bind(100,911,2*page,page,0,page)).toBe(0);
  bytes.fill(0,2*page,3*page); // Normal mmap population happens after bind admission.
  registry.primeBindFromSab(100,911,memory,2*page);
  registry.syncToSab(910);
  expect(registry.pixelView(910)![page]).toBe(55);
  expect(registry.get(100,910)?.binding).toEqual({addr:3*page,len:page,boOffset:2*page});
  bytes[2*page]=101;registry.syncToSab(911);
  const device=registry.pixelView(910)!.slice();
  device[0]=31;device[page]=77;device[2*page]=93;
  expect(registry.publishDevicePixels(910,device)).toBe(true);
  expect([bytes[page],bytes[2*page],bytes[3*page]]).toEqual([31,101,93]);
  expect(registry.pixelView(911)![0]).toBe(101);
  registry.destroy(100,910);
  expect(registry.get(100,911)?.binding).toEqual({addr:2*page,len:page});
});

it("flushes overlapping aliases before the same BO is remapped and zero-filled", () => {
  const page=65536, memory=new WebAssembly.Memory({initial:6,maximum:6});
  const bytes=new Uint8Array(memory.buffer);
  const registry=new GbmBoRegistry({getProcessMemory:()=>memory});
  registry.create({pid:100,bo_id:912,size:3*page,w:256,h:192,stride:1024});
  registry.bind(100,912,page,3*page);
  registry.primeBindFromSab(100,912,memory,page);
  bytes[page]=41;bytes[2*page]=55;bytes[3*page]=61;
  expect(registry.bind(100,912,2*page,3*page,0,3*page)).toBe(0);
  bytes.fill(0,2*page,5*page);
  registry.primeBindFromSab(100,912,memory,2*page);
  expect([bytes[2*page],bytes[3*page],bytes[4*page]]).toEqual([41,55,61]);
  bytes[2*page]=88;registry.syncImportsForPid(100,memory);
  expect(bytes[page]).toBe(88);
  expect(registry.get(100,912)?.binding).toEqual({addr:2*page,len:3*page});
});

it("preserves all prior VMA metadata when a replacement observer rejects admission", () => {
  const page=65536, memory=new WebAssembly.Memory({initial:6,maximum:6});
  const registry=new GbmBoRegistry({getProcessMemory:()=>memory});
  registry.create({pid:100,bo_id:913,size:3*page,w:256,h:192,stride:1024});
  registry.create({pid:100,bo_id:914,size:page,w:256,h:64,stride:1024});
  registry.bind(100,913,page,3*page);registry.primeBindFromSab(100,913,memory,page);
  const remove=registry.onChange(()=>{throw new Error("rejected observer");});
  let result=-1;
  try {result=registry.bind(100,914,2*page,page,0,page);} catch {}
  remove();
  expect(result).toBeLessThan(0);
  expect(registry.get(100,913)?.binding).toEqual({addr:page,len:3*page});
  expect(registry.get(100,914)?.binding).toBeNull();
});


describe("shared-byte changed-run scan", () => {
  class RecordedDestination extends Uint8Array {
    writes: [number, number][] = [];
    override set(values: ArrayLike<number>, offset = 0): void {
      this.writes.push([offset, values.length]);
      super.set(values, offset);
    }
  }

  // Independent per-byte oracle: it decides publications before invoking the
  // implementation and never groups/copies data to derive expected contents.
  function checkMerge(source: Uint8Array, sourceOffset: number, snapshot: Uint8Array,
    snapshotOffset: number, len: number, destinationOffset: number): void {
    const destination = new RecordedDestination(len + destinationOffset + 9);
    destination.fill(0xc7); // Newer canonical bytes must survive unchanged readers.
    const expected = Uint8Array.from(destination);
    const writes: [number, number][] = [];
    const sourceBefore = Uint8Array.from(source), snapshotBefore = Uint8Array.from(snapshot);
    let changed = false;
    for (let i = 0; i < len; i++) {
      if (source[sourceOffset + i] !== snapshot[snapshotOffset + i]) {
        expected[destinationOffset + i] = source[sourceOffset + i];
        changed = true;
        const last = writes.at(-1);
        if (last && last[0] + last[1] === destinationOffset + i) last[1]++;
        else writes.push([destinationOffset + i, 1]);
      }
    }
    expect(mergeChangedByteRuns(source, sourceOffset, snapshot, snapshotOffset,
      destination, destinationOffset, len)).toBe(changed);
    expect(Uint8Array.from(destination)).toEqual(expected);
    expect(destination.writes).toEqual(writes);
    expect(source).toEqual(sourceBefore);
    expect(snapshot).toEqual(snapshotBefore);
  }

  it("matches a byte oracle at word, prefix, tail and view boundaries", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 63, 64, 65, 66, 67, 68, 127, 128, 129, 255, 256, 257, 258, 259, 260, 4093, 4096, 4099]) {
      for (let sourceAlignment = 0; sourceAlignment < 4; sourceAlignment++) {
        for (let snapshotAlignment = 0; snapshotAlignment < 4; snapshotAlignment++) {
          const source = new Uint8Array(new SharedArrayBuffer(len + 24), sourceAlignment, len + 16);
          const snapshot = new Uint8Array(new ArrayBuffer(len + 24), snapshotAlignment, len + 16);
          source.fill(0x31); snapshot.fill(0x31);
          checkMerge(source, 3, snapshot, 5, len, 7);
          // Differences on both sides of the range must not be published.
          source[2] = 0xaa; source[3 + len] = 0xbb;
          for (const relative of [0, 1, 2, 3, 4, 31, 32, 62, 63, 64, len - 3, len - 2, len - 1]) {
            if (relative >= 0 && relative < len) source[3 + relative] ^= 0x5a;
          }
          checkMerge(source, 3, snapshot, 5, len, 7);
        }
      }
    }
  });

  it("matches an independent scalar oracle on deterministic sparse/dense random ranges", () => {
    let seed = 0x1ac29f03;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let trial = 0; trial < 1500; trial++) {
      const len = next() % 513, a = next() % 8, b = next() % 8;
      const sourceOffset = next() % 8, snapshotOffset = next() % 8;
      const source = new Uint8Array(trial % 2 ? new SharedArrayBuffer(len + 32) : new ArrayBuffer(len + 32), a, len + 20);
      const snapshot = new Uint8Array(new ArrayBuffer(len + 32), b, len + 20);
      source.fill(0x4e); snapshot.fill(0x91);
      for (let i = 0; i < len; i++) {
        source[sourceOffset + i] = snapshot[snapshotOffset + i] = next() & 255;
        if (next() % (trial % 2 ? 3 : 37) === 0) source[sourceOffset + i] ^= 0x8b;
      }
      checkMerge(source, sourceOffset, snapshot, snapshotOffset, len, next() % 8);
    }
  });

  it("reads current shared Wasm buffers after growth without retaining a previous view", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
    const before = new Uint8Array(memory.buffer, 3, 513);
    const snapshot = new Uint8Array(new ArrayBuffer(516), 3, 513);
    before.fill(0x19); snapshot.fill(0x19);
    checkMerge(before, 0, snapshot, 0, 513, 1);
    memory.grow(1);
    const after = new Uint8Array(memory.buffer, 65536 + 3, 513);
    after.fill(0x19); after[0] = 0x5a; after[512] = 0x6b;
    checkMerge(after, 0, snapshot, 0, 513, 2);
    before[259] = 0x7c;
    checkMerge(before, 0, snapshot, 0, 513, 3);
  });

  it("does not retain detached unshared Wasm views across growth", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const old = new Uint8Array(memory.buffer, 1, 512), snapshot = new Uint8Array(new ArrayBuffer(513), 1, 512);
    checkMerge(old, 0, snapshot, 0, 512, 0);
    memory.grow(1);
    expect(old.length).toBe(0);
    const current = new Uint8Array(memory.buffer, 65536 + 1, 512);
    current[255] = 0x42; current[511] = 0x53;
    checkMerge(current, 0, snapshot, 0, 512, 0);
  });
});
