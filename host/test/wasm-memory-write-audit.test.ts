import { describe, expect, it } from "vitest";
import {
  auditWasmMemoryWrites,
  formatAuditFailures,
  type AuditAllowance,
  type OwnershipSeed,
  virtualAuditOptions,
} from "./support/wasm-memory-write-audit";

const kernelMemorySeed = (
  declaration = "kernel.ts::Kernel.memory",
): OwnershipSeed => ({
  declaration,
  target: "value",
  owner: "kernel",
  form: "memory",
  why: "This field owns the kernel WebAssembly linear memory.",
});

function auditVirtual(
  sources: Readonly<Record<string, string>>,
  seeds: readonly OwnershipSeed[] = [kernelMemorySeed()],
  allowances: readonly AuditAllowance[] = [],
) {
  return auditWasmMemoryWrites(
    virtualAuditOptions(sources, seeds, allowances),
  );
}

describe("WebAssembly memory write audit", () => {
  it("finds direct, bracketed, and destructured kernel-memory aliases", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const km = this.memory;
            const { buffer } = km;
            const first = new Uint8Array(buffer);
            const alias = first;
            alias["set"](data);
            const second = new DataView(km["buffer"]);
            second.setUint32(0, 1, true);
          }
        }
      `,
    });

    expect(result.unresolvedSeeds).toEqual([]);
    expect(result.findings.filter((finding) => finding.kind === "kernel-view"))
      .toHaveLength(2);
    expect(result.findings.filter((finding) => finding.kind === "kernel-write"))
      .toHaveLength(2);
  });

  it("propagates ownership through a helper parameter and return across files", () => {
    const result = auditVirtual({
      "view.ts": `
        export function raw(memory: WebAssembly.Memory): Uint8Array {
          return new Uint8Array(memory.buffer);
        }
      `,
      "kernel.ts": `
        import { raw } from "./view";
        export class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const view = raw(this.memory);
            view.set(data);
          }
        }
      `,
    });

    expect(result.unresolvedSeeds).toEqual([]);
    expect(result.findings.some(
      (finding) =>
        finding.file === "view.ts"
        && finding.kind === "kernel-view-return",
    )).toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.file === "kernel.ts"
        && finding.kind === "kernel-write",
    )).toBe(true);
  });

  it("covers DataView, element, Atomics, Buffer, and subarray writes", () => {
    const result = auditVirtual({
      "buffer.d.ts": `
        interface Buffer extends Uint8Array {
          slice(): Buffer;
        }
        interface BufferConstructor {
          from(buffer: ArrayBufferLike): Buffer;
        }
        declare const Buffer: BufferConstructor;
      `,
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const bytes = new Uint8Array(this.memory.buffer);
            bytes[0] = 1;
            bytes[1]++;
            bytes.subarray(2)["set"](data);
            const words = new Int32Array(this.memory.buffer);
            Atomics.store(words, 0, 1);
            const view = new DataView(this.memory.buffer);
            view.setBigInt64(8, 2n, true);
            Buffer.from(this.memory.buffer).fill(3);
            Buffer.from(this.memory.buffer).slice().fill(4);
          }
        }
      `,
    });

    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes.length).toBeGreaterThanOrEqual(7);
    expect(writes.some((finding) => finding.text.includes("Atomics.store")))
      .toBe(true);
    expect(writes.some((finding) => finding.text.includes("setBigInt64")))
      .toBe(true);
    expect(writes.some((finding) => finding.text.includes("Buffer.from")))
      .toBe(true);
  });

  it("treats slice as detached while subarray retains the kernel backing", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const raw = new Uint8Array(this.memory.buffer);
            const detached = raw.slice();
            detached.set(data);
            const alias = raw.subarray(0);
            alias.set(data);
          }
        }
      `,
    });

    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("alias.set");
  });

  it("finds raw-view returns, persistent stores, and opaque writer escapes", () => {
    const result = auditVirtual({
      "kernel.ts": `
        interface Reader {
          read(destination: Uint8Array): number;
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          retained?: Uint8Array;
          expose(reader: Reader): Uint8Array {
            const destination = new Uint8Array(this.memory.buffer);
            this.retained = destination;
            reader.read(destination);
            return destination;
          }
        }
      `,
    });

    expect(result.findings.some(
      (finding) => finding.kind === "kernel-view-store",
    )).toBe(true);
    expect(result.findings.some(
      (finding) => finding.kind === "kernel-view-escape",
    )).toBe(true);
    expect(result.findings.some(
      (finding) => finding.kind === "kernel-view-return",
    )).toBe(true);
  });

  it("propagates ownership through structured containers and destructuring", () => {
    const result = auditVirtual({
      "kernel.ts": `
        function wrap(memory: WebAssembly.Memory) {
          return {
            nested: { memory },
            buffers: [memory.buffer],
          };
        }
        class Holder {
          constructor(readonly memory: WebAssembly.Memory) {}
          write(data: Uint8Array): void {
            new Uint8Array(this.memory.buffer).set(data);
          }
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const wrapped = wrap(this.memory);
            const {
              nested: { memory },
              buffers: [buffer],
            } = wrapped;
            new Uint8Array(memory.buffer).set(data);
            new Uint8Array(buffer).set(data);
            new Holder(this.memory).write(data);
          }
        }
      `,
    });

    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(3);
    expect(writes.some((finding) => finding.enclosing === "Holder.write"))
      .toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-return"
        && finding.enclosing === "wrap",
    )).toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-buffer-return"
        && finding.enclosing === "wrap",
    )).toBe(true);
  });

  it("tracks callback containers and parameter-property symbol aliases", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class ScratchView {
          saved?: ArrayBufferLike;
          constructor(
            private readonly refresh: () => { buffer: ArrayBufferLike },
          ) {
            const initial = refresh();
            this.saved = initial.buffer;
          }
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          create(): void {
            new ScratchView(() => ({ buffer: this.memory.buffer }));
          }
        }
      `,
    });

    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-buffer-store"
        && finding.text === "this.saved = initial.buffer",
    )).toBe(true);
  });

  it("tracks destructuring assignments and unknown object properties", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare function opaque(value: unknown): void;
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            let alias!: Uint8Array;
            ({ view: alias } = {
              view: new Uint8Array(this.memory.buffer),
            });
            alias.set(data);
            const key = "memory";
            const first = { [key]: this.memory };
            opaque({ ...first });
          }
        }
      `,
    });

    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-write"
        && finding.text === "alias.set(data)",
    )).toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-escape"
        && finding.text === "opaque({ ...first })",
    )).toBe(true);
  });

  it("finds spread-argument escapes and writes in assignment patterns", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare function opaque(...values: unknown[]): void;
        class Kernel {
          memory!: WebAssembly.Memory;
          write(): void {
            const view = new Uint8Array(this.memory.buffer);
            opaque(...[view]);
            [view[0]] = [1];
            ({ value: view[1] } = { value: 2 });
          }
        }
      `,
    });

    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-view-escape"
        && finding.text === "opaque(...[view])",
    )).toBe(true);
    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(2);
    expect(writes.some((finding) => finding.text === "[view[0]] = [1]"))
      .toBe(true);
    expect(writes.some(
      (finding) =>
        finding.text === "{ value: view[1] } = { value: 2 }",
    )).toBe(true);
  });

  it("propagates comma, logical, Array.at, and for-of aliases", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array, condition: boolean): void {
            const view = new Uint8Array(this.memory.buffer);
            (0, view).set(data);
            const fromAt = [view].at(0)!;
            fromAt.set(data);
            for (const item of [view]) item.set(data);
            const fromLogical = condition && view;
            fromLogical?.set(data);
          }
        }
      `,
    });

    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(4);
    expect(writes.some((finding) => finding.text === "(0, view).set(data)"))
      .toBe(true);
    expect(writes.some((finding) => finding.text === "fromAt.set(data)"))
      .toBe(true);
    expect(writes.some((finding) => finding.text === "item.set(data)"))
      .toBe(true);
    expect(writes.some((finding) => finding.text === "fromLogical?.set(data)"))
      .toBe(true);
  });

  it("covers common intrinsic Array element and callback flows", () => {
    const result = auditVirtual({
      "lib.es2023.array.d.ts": `
        interface Array<T> {
          findLast(
            predicate: (value: T, index: number, array: T[]) => unknown,
          ): T | undefined;
        }
      `,
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const view = new Uint8Array(this.memory.buffer);
            [view].forEach(item => item.set(data));
            [view].some(item => { item.set(data); return true; });
            [view].every(item => { item.set(data); return true; });
            const found = [view].find(item => {
              item.set(data);
              return true;
            })!;
            found.set(data);
            const foundLast = [view].findLast(item => {
              item.set(data);
              return true;
            })!;
            foundLast.set(data);
            const mapped = [view].map(item => {
              item.set(data);
              return item;
            });
            mapped[0].set(data);
            const filtered = [view].filter(item => {
              item.set(data);
              return true;
            });
            filtered[0].set(data);
            const popped = [view].pop()!;
            popped.set(data);
            const shifted = [view].shift()!;
            shifted.set(data);
          }
        }
      `,
    });

    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes.filter((finding) => finding.text === "item.set(data)"))
      .toHaveLength(7);
    for (const text of [
      "found.set(data)",
      "foundLast.set(data)",
      "mapped[0].set(data)",
      "filtered[0].set(data)",
      "popped.set(data)",
      "shifted.set(data)",
    ]) {
      expect(writes.some((finding) => finding.text === text)).toBe(true);
    }
  });

  it("keeps memory ownership on constructor and later-assigned wrappers", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare function opaque(value: unknown): void;
        interface Wrapper {
          memory?: WebAssembly.Memory;
        }
        class Holder {
          constructor(readonly memory: WebAssembly.Memory) {}
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          escape(): void {
            opaque(new Holder(this.memory));
            const wrapper: Wrapper = {};
            wrapper.memory = this.memory;
            opaque(wrapper);
          }
        }
      `,
    });

    const escapes = result.findings.filter(
      (finding) => finding.kind === "kernel-memory-escape",
    );
    expect(escapes).toHaveLength(2);
    expect(escapes.some(
      (finding) => finding.text === "opaque(new Holder(this.memory))",
    )).toBe(true);
    expect(escapes.some(
      (finding) => finding.text === "opaque(wrapper)",
    )).toBe(true);
  });

  it("does not let casts hide direct access to private owner slots", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare function opaque(value: unknown): void;
        class Kernel {
          private memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const memory = (this as any).memory;
            new Uint8Array(memory.buffer).set(data);
            const alias: any = this;
            new Uint8Array(alias.memory.buffer).set(data);
            opaque(this);
            opaque({ ...alias });
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) =>
        finding.kind === "kernel-write"
        && finding.text.includes(".set(data)"),
    )).toHaveLength(2);
    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-memory-escape",
    )).toHaveLength(1);
  });

  it("propagates callable returns through implicit arrows and getters", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          get currentMemory(): WebAssembly.Memory {
            return this.memory;
          }
          write(data: Uint8Array): void {
            const currentBuffer = () => this.currentMemory.buffer;
            const bytes = new Uint8Array(currentBuffer());
            bytes.set(data);
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    )).toHaveLength(1);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-return"
        && finding.enclosing === "Kernel.currentMemory",
    )).toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-buffer-return"
        && finding.enclosing.endsWith(".currentBuffer"),
    )).toBe(true);
  });

  it("does not treat custom slice or from methods as detached copies", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          slice(): Uint8Array {
            return new Uint8Array(this.memory.buffer);
          }
          from(): Uint8Array {
            return new Uint8Array(this.memory.buffer);
          }
          write(data: Uint8Array): void {
            this.slice().set(data);
            this.from().set(data);
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    )).toHaveLength(2);
  });

  it("recognizes aliased Uint8Array and DataView constructors", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const Bytes = Uint8Array;
            const Words = DataView;
            new Bytes(this.memory.buffer).set(data);
            new Words(this.memory.buffer).setUint32(0, 1, true);
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-view",
    )).toHaveLength(2);
    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    )).toHaveLength(2);
  });

  it("does not exempt shadowed view constructors or Buffer.from", () => {
    const result = auditVirtual({
      "kernel.ts": `
        export {};
        declare const Uint8Array: new (value: unknown) => unknown;
        declare const Buffer: {
          from(value: unknown): unknown;
        };
        class Kernel {
          memory!: WebAssembly.Memory;
          escape(): void {
            new Uint8Array(this.memory);
            Buffer.from(this.memory);
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-memory-escape",
    )).toHaveLength(2);
  });

  it("finds raw memory and buffer calls, returns, and persistent stores", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare function opaque(value: unknown): void;
        let retained: WebAssembly.Memory;
        class Retainer {
          constructor(readonly memory: WebAssembly.Memory) {}
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          retainedMemory?: WebAssembly.Memory;
          retainedBuffer = this.memory.buffer;
          exposeMemory(): WebAssembly.Memory {
            return this.memory;
          }
          exposeBuffer(): ArrayBufferLike {
            return this.memory.buffer;
          }
          escape(): void {
            const memory = this.memory;
            const buffer = memory.buffer;
            opaque({ memory });
            opaque([buffer]);
            this.retainedMemory = memory;
            retained = memory;
            new Retainer(memory);
          }
        }
      `,
    });

    for (const kind of [
      "kernel-memory-escape",
      "kernel-memory-return",
      "kernel-memory-store",
      "kernel-buffer-escape",
      "kernel-buffer-return",
      "kernel-buffer-store",
    ] as const) {
      expect(
        result.findings.some((finding) => finding.kind === kind),
        `expected ${kind}`,
      ).toBe(true);
    }
    expect(result.findings.filter(
      (finding) => finding.kind === "kernel-memory-store",
    ).length).toBeGreaterThanOrEqual(2);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-store"
        && finding.text === "retained = memory",
    )).toBe(true);
  });

  it("finds module initializers and parameter-property defaults", () => {
    const result = auditVirtual({
      "factory.ts": `
        export function kernelMemory(): WebAssembly.Memory {
          throw new Error("fixture");
        }
      `,
      "kernel.ts": `
        import { kernelMemory } from "./factory";
        const retained = kernelMemory();
        class Holder {
          constructor(readonly memory = kernelMemory()) {}
        }
      `,
    }, [{
      declaration: "factory.ts::kernelMemory",
      target: "return",
      owner: "kernel",
      form: "memory",
      why: "This fixture factory returns only kernel memory.",
    }]);

    expect(result.unresolvedSeeds).toEqual([]);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-store"
        && finding.text === "retained = kernelMemory()",
    )).toBe(true);
    expect(result.findings.some(
      (finding) =>
        finding.kind === "kernel-memory-store"
        && finding.enclosing === "Holder.constructor",
    )).toBe(true);
  });

  it("does not confuse custom set/decode methods with synchronous platform readers", () => {
    const result = auditVirtual({
      "kernel.ts": `
        interface RetainingSink {
          set(value: Uint8Array): void;
          decode(value: Uint8Array): void;
        }
        class Kernel {
          memory!: WebAssembly.Memory;
          expose(sink: RetainingSink): void {
            const bytes = new Uint8Array(this.memory.buffer);
            sink.set(bytes);
            sink.decode(bytes);
          }
          consume(): void {
            const bytes = new Uint8Array(this.memory.buffer);
            new Uint8Array(4).set(bytes);
            new TextDecoder().decode(bytes);
          }
        }
      `,
    });

    const escapes = result.findings.filter(
      (finding) => finding.kind === "kernel-view-escape",
    );
    expect(escapes).toHaveLength(2);
    expect(escapes.some((finding) => finding.text.includes("sink.set")))
      .toBe(true);
    expect(escapes.some((finding) => finding.text.includes("sink.decode")))
      .toBe(true);
    expect(escapes.some((finding) => finding.text.includes("TextDecoder")))
      .toBe(false);
  });

  it("does not exempt shadowed typed-array, decoder, or Atomics readers", () => {
    const result = auditVirtual({
      "kernel.ts": `
        export {};
        declare class Uint8Array {
          set(value: unknown): void;
        }
        declare class TextDecoder {
          decode(value: unknown): string;
        }
        declare const Atomics: {
          load(value: unknown, index: number): number;
        };
        class Kernel {
          memory!: WebAssembly.Memory;
          expose(): void {
            const view = new globalThis.Uint8Array(this.memory.buffer);
            new Uint8Array().set(view);
            new TextDecoder().decode(view);
            Atomics.load(view, 0);
          }
        }
      `,
    });

    const escapes = result.findings.filter(
      (finding) => finding.kind === "kernel-view-escape",
    );
    expect(escapes).toHaveLength(3);
    expect(escapes.some((finding) => finding.text.includes("Uint8Array")))
      .toBe(true);
    expect(escapes.some((finding) => finding.text.includes("TextDecoder")))
      .toBe(true);
    expect(escapes.some((finding) => finding.text.includes("Atomics.load")))
      .toBe(true);
  });

  it("finds direct and multiply-aliased scratch allocator calls", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          allocate(exports: Record<string, unknown>): void {
            const allocator = exports.kernel_alloc_scratch as (n: number) => number;
            const alias = allocator;
            alias(64);
            const begin =
              exports["kernel_spawn_scratch_begin"] as (n: bigint) => bigint;
            const beginAlias = begin;
            beginAlias(128n);
            const pointer =
              exports.kernel_spawn_scratch_pointer as () => bigint;
            pointer();
          }
        }
      `,
    });

    expect(result.findings.filter(
      (finding) => finding.kind === "scratch-allocator-call",
    )).toHaveLength(1);
    expect(result.findings.filter(
      (finding) => finding.kind === "spawn-reservation-call",
    )).toHaveLength(2);
  });

  it("keeps non-scratch ownership roots explicit without treating them as kernel", () => {
    const seeds: OwnershipSeed[] = [
      {
        declaration: "owners.ts::Process.memory",
        target: "value",
        owner: "process-memory",
        form: "memory",
        why: "This field is one user process WebAssembly memory.",
      },
      {
        declaration: "owners.ts::Framebuffer.bytes",
        target: "value",
        owner: "framebuffer",
        form: "view",
        why: "This host-owned view contains framebuffer pixel bytes.",
      },
      {
        declaration: "owners.ts::Shared.bytes",
        target: "value",
        owner: "shared-memory",
        form: "view",
        why: "This host-owned view is an authoritative shared mapping.",
      },
      {
        declaration: "owners.ts::Lent.destination",
        target: "value",
        owner: "rust-lent",
        form: "view",
        why: "Rust lends this checked destination for one synchronous call.",
      },
    ];
    const result = auditVirtual({
      "owners.ts": `
        class Process {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            new Uint8Array(this.memory.buffer).set(data);
          }
        }
        class Framebuffer {
          bytes!: Uint8Array;
          write(data: Uint8Array): void { this.bytes.set(data); }
        }
        class Shared {
          bytes!: Uint8Array;
          write(data: Uint8Array): void { this.bytes.set(data); }
        }
        class Lent {
          destination!: Uint8Array;
          write(data: Uint8Array): void { this.destination.set(data); }
        }
      `,
    }, seeds);

    expect(result.unresolvedSeeds).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("uses an exact multiset and rejects stale allowances", () => {
    const sources = {
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const view = new Uint8Array(this.memory.buffer);
            view.set(data);
          }
        }
      `,
    };
    const initial = auditVirtual(sources);
    const allowances: AuditAllowance[] = initial.findings.map((finding) => ({
      key: finding.key,
      disposition: "scratch-core",
      why: "The focused fixture explicitly admits this one checked site.",
    }));
    const admitted = auditVirtual(sources, [kernelMemorySeed()], allowances);
    expect(formatAuditFailures(admitted)).toEqual([]);

    const duplicate = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            const view = new Uint8Array(this.memory.buffer);
            view.set(data);
            view.set(data);
          }
        }
      `,
    }, [kernelMemorySeed()], allowances);
    expect(duplicate.violations.some(
      (finding) => finding.kind === "kernel-write",
    )).toBe(true);

    const stale = auditVirtual(sources, [kernelMemorySeed()], [
      ...allowances,
      {
        key: "new-file.ts::missing::kernel-write::missing()",
        disposition: "scratch-core",
        why: "This deliberately stale entry must be rejected by the audit.",
      },
    ]);
    expect(stale.unusedAllowances).toHaveLength(1);
  });

  it("audits a newly introduced source path without a filename allowlist", () => {
    const result = auditVirtual({
      "new/subsystem/transfer.ts": `
        export class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            new Uint8Array(this.memory.buffer).set(data);
          }
        }
      `,
    }, [kernelMemorySeed("new/subsystem/transfer.ts::Kernel.memory")]);

    expect(result.sourceFiles).toContain("new/subsystem/transfer.ts");
    expect(result.violations.some(
      (finding) => finding.file === "new/subsystem/transfer.ts",
    )).toBe(true);
  });
});
