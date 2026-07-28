import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditWasmMemoryWrites,
  formatAuditFailures,
  repositoryRuntimeSourceFiles,
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

const scratchRegionSeed = (
  declaration = "caller.ts::region",
): OwnershipSeed => ({
  declaration,
  target: "value",
  owner: "kernel",
  form: "scratch-region",
  why: "This fixture value is a region returned by the kernel-owned factory.",
});

function auditVirtual(
  sources: Readonly<Record<string, string>>,
  seeds: readonly OwnershipSeed[] = [kernelMemorySeed()],
  allowances: readonly AuditAllowance[] = [],
) {
  return auditWasmMemoryWrites(virtualAuditOptions(sources, seeds, allowances));
}

describe("WebAssembly memory write audit", () => {
  it("requires exact owner classifications and seeds the classified origin", () => {
    const sources = {
      "kernel.ts": `
        const memory = new WebAssembly.Memory({ initial: 1 });
        export function write(bytes: Uint8Array): void {
          new Uint8Array(memory.buffer).set(bytes);
        }
      `,
    };
    const unclassified = auditWasmMemoryWrites({
      ...virtualAuditOptions(sources, []),
      auditWasmAuthorityOrigins: true,
    });
    const origin = unclassified.violations.find(
      (finding) => finding.kind === "wasm-memory-authority",
    );
    expect(origin).toBeDefined();
    expect(
      unclassified.violations.some(
        (finding) => finding.kind === "kernel-write",
      ),
    ).toBe(false);

    const kernelClassification: AuditAllowance = {
      key: origin!.key,
      disposition: "kernel-control",
      authorityOwner: "kernel",
      why: "This exact constructor creates the kernel linear memory.",
    };
    const classifiedKernel = auditWasmMemoryWrites({
      ...virtualAuditOptions(sources, [], [kernelClassification]),
      auditWasmAuthorityOrigins: true,
    });
    expect(
      classifiedKernel.violations.some(
        (finding) => finding.kind === "wasm-memory-authority",
      ),
    ).toBe(false);
    expect(
      classifiedKernel.violations.some(
        (finding) => finding.kind === "kernel-write",
      ),
    ).toBe(true);

    const classifiedProcess = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        sources,
        [],
        [
          {
            ...kernelClassification,
            disposition: "non-kernel",
            authorityOwner: "process-memory",
          },
        ],
      ),
      auditWasmAuthorityOrigins: true,
    });
    expect(classifiedProcess.violations).toEqual([]);
    expect(classifiedProcess.unusedAllowances).toEqual([]);

    expect(() =>
      auditWasmMemoryWrites({
        ...virtualAuditOptions(
          sources,
          [],
          [kernelClassification, kernelClassification],
        ),
        auditWasmAuthorityOrigins: true,
      }),
    ).toThrow(/duplicate audit allowance/);
    expect(() =>
      auditWasmMemoryWrites({
        ...virtualAuditOptions(
          sources,
          [],
          [
            {
              key: origin!.key,
              disposition: "kernel-control",
              why: "This deliberately omits the required authority owner.",
            },
          ],
        ),
        auditWasmAuthorityOrigins: true,
      }),
    ).toThrow(/must classify its owner/);
  });

  it("finds aliased, destructured, bound, and reflected Wasm authorities", () => {
    const result = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "authority.ts": `
          declare const module: WebAssembly.Module;
          const Wasm = WebAssembly;
          const directAliasMemory =
            new Wasm.Memory({ initial: 1 });
          const { Memory: DestructuredMemory } = Wasm;
          const BracketMemory = WebAssembly["Memory"];
          const BoundMemory = BracketMemory.bind(null);
          const capturedConstruct = Reflect.construct;
          const first = new DestructuredMemory({ initial: 1 });
          const second = new BoundMemory({ initial: 1 });
          const third = capturedConstruct(
            DestructuredMemory,
            [{ initial: 1 }],
          ) as WebAssembly.Memory;

          const { Instance: DestructuredInstance } = WebAssembly;
          const instance = capturedConstruct(
            DestructuredInstance,
            [module, {}],
          ) as WebAssembly.Instance;

          const { instantiate: destructuredInstantiate } = WebAssembly;
          const boundInstantiate =
            WebAssembly.instantiate.bind(WebAssembly);
          void Wasm.instantiate(module, {});
          void WebAssembly.instantiate.call(
            WebAssembly,
            module,
            {},
          );
          void WebAssembly.instantiate.apply(
            WebAssembly,
            [module, {}] as any,
          );
          void destructuredInstantiate(module, {});
          void boundInstantiate(module, {});
          void directAliasMemory;
          void first;
          void second;
          void third;
          void instance;
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });

    expect(
      result.violations.filter(
        (finding) => finding.kind === "wasm-memory-authority",
      ),
    ).toHaveLength(4);
    expect(
      result.violations.filter(
        (finding) => finding.kind === "wasm-instance-authority",
      ),
    ).toHaveLength(6);
  });

  it("finds immutable container and intrinsic dispatcher authority wrappers", () => {
    const result = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "authority.ts": `
          declare const module: WebAssembly.Module;

          const namespaceBox = { Wasm: WebAssembly };
          const constructorBox = { make: WebAssembly.Memory };
          const constructorList = [WebAssembly.Memory] as const;
          void new namespaceBox.Wasm.Memory({ initial: 1 });
          void new constructorBox.make({ initial: 1 });
          void new (constructorList[0])({ initial: 1 });

          const instantiateBox = {
            make: WebAssembly.instantiate,
          };
          void instantiateBox.make(module, {});
          void Function.prototype.call.bind(
            WebAssembly.instantiate,
          )(WebAssembly, module, {});
          void Function.prototype.apply.bind(
            WebAssembly.instantiate,
          )(WebAssembly, [module, {}]);
          void Reflect.apply(
            Function.prototype.call,
            WebAssembly.instantiate,
            [WebAssembly, module, {}],
          );
          void Reflect.apply(
            Function.prototype.apply,
            WebAssembly.instantiate,
            [WebAssembly, [module, {}]],
          );

          const { Wasm } = { Wasm: WebAssembly };
          const { Memory } = { Memory: WebAssembly.Memory };
          const [ArrayMemory] = [WebAssembly.Memory];
          void new Wasm.Memory({ initial: 1 });
          void new Memory({ initial: 1 });
          void new ArrayMemory({ initial: 1 });
          const { make } = {
            make: WebAssembly.instantiate,
          };
          const [arrayInstantiate] = [
            WebAssembly.instantiate,
          ];
          void make(module, {});
          void arrayInstantiate(module, {});

          void Reflect.construct.call(
            Reflect,
            WebAssembly.Memory,
            [{ initial: 1 }],
          );
          void Reflect.construct.apply(
            Reflect,
            [WebAssembly.Memory, [{ initial: 1 }]],
          );
          void Reflect.apply(
            Reflect.construct,
            Reflect,
            [WebAssembly.Memory, [{ initial: 1 }]],
          );
          void Reflect.construct.bind(
            Reflect,
            WebAssembly.Memory,
          )([{ initial: 1 }]);
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });

    expect(
      result.violations.filter(
        (finding) => finding.kind === "wasm-memory-authority",
      ),
    ).toHaveLength(10);
    expect(
      result.violations.filter(
        (finding) => finding.kind === "wasm-instance-authority",
      ),
    ).toHaveLength(7);
  });

  it("fails closed on mutable, higher-order, and expression authority flows", () => {
    const mutable = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "mutable.ts": `
          declare const module: WebAssembly.Module;
          const Fake: any = class {};
          let Memory = WebAssembly.Memory;
          void new Memory({ initial: 1 });
          let AssignedMemory: any = Fake;
          AssignedMemory = WebAssembly.Memory;
          void new AssignedMemory({ initial: 1 });
          const box = { make: Fake };
          box.make = WebAssembly.Memory;
          void new box.make({ initial: 1 });

          let instantiate = WebAssembly.instantiate;
          void instantiate(module, {});
          const instanceBox = { make: Fake };
          instanceBox.make = WebAssembly.instantiate;
          void instanceBox.make(module, {});
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });
    expect(
      mutable.violations.filter(
        (finding) => finding.kind === "wasm-memory-authority",
      ),
    ).toHaveLength(3);
    expect(
      mutable.violations.filter(
        (finding) => finding.kind === "wasm-instance-authority",
      ),
    ).toHaveLength(2);
    expect(
      mutable.violations.filter(
        (finding) => finding.kind === "wasm-authority-escape",
      ).length,
    ).toBeGreaterThanOrEqual(5);

    const expressions = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "expressions.ts": `
          declare const module: WebAssembly.Module;
          declare const flag: boolean;
          declare const key: string;
          const Fake: any = class {};
          void new (
            flag ? WebAssembly.Memory : Fake
          )({ initial: 1 });
          void new (
            flag && WebAssembly.Memory as any
          )({ initial: 1 });
          void new (
            0, WebAssembly.Memory
          )({ initial: 1 });
          void new (WebAssembly as any)[key]({ initial: 1 });
          void (WebAssembly as any)[key](module, {});
          void new globalThis.WebAssembly.Memory({ initial: 1 });
          void globalThis.WebAssembly.instantiate(module, {});
          const BoundMemory = Function.prototype.bind.call(
            WebAssembly.Memory,
            null,
          );
          void new BoundMemory({ initial: 1 });
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });
    expect(
      expressions.violations.filter(
        (finding) => finding.kind === "wasm-memory-authority",
      ),
    ).toHaveLength(6);
    expect(
      expressions.violations.filter(
        (finding) => finding.kind === "wasm-instance-authority",
      ),
    ).toHaveLength(3);

    const helpers = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "helpers.ts": `
          declare const module: WebAssembly.Module;
          function construct(
            Constructor: any,
            args: any[],
          ): unknown {
            return new Constructor(...args);
          }
          function call(
            operation: any,
            ...args: any[]
          ): unknown {
            return operation(...args);
          }
          void construct(
            WebAssembly.Memory,
            [{ initial: 1 }],
          );
          void call(WebAssembly.instantiate, module, {});
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });
    expect(
      helpers.violations.filter(
        (finding) => finding.kind === "wasm-authority-escape",
      ),
    ).toHaveLength(2);

    const dynamicCode = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "dynamic.ts": `
          declare function retain(value: unknown): void;
          eval("void 0");
          const DynamicFunction = Function;
          void new DynamicFunction("return 1");
          retain(eval);
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });
    expect(
      dynamicCode.violations.filter(
        (finding) => finding.kind === "dynamic-code-contract",
      ),
    ).toHaveLength(3);
  });

  it("fails closed on the finite WebAssembly authority escape policy", () => {
    const result = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "authority-escape.ts": `
          declare const module: WebAssembly.Module;
          declare const response: Response;
          declare const source: any;
          declare function retain(value: unknown): void;

          const root: any = globalThis;
          void new root.WebAssembly.Memory({ initial: 1 });
          void root.WebAssembly.instantiate(module, {});
          void new globalThis["Web" + "Assembly"].Memory({
            initial: 1,
          });
          void globalThis["Web" + "Assembly"].instantiate(
            module,
            {},
          );

          void self.eval("void 0");
          void self.Function("return 1")();
          void WebAssembly.Memory.constructor("return 1")();

          void WebAssembly.instantiateStreaming(response, {});
          const stream = WebAssembly.instantiateStreaming;
          void stream(response, {});

          class MemorySubclass extends WebAssembly.Memory {}
          class InstanceSubclass extends WebAssembly.Instance {}
          void MemorySubclass;
          void InstanceSubclass;
          void new (
            WebAssembly.Memory.prototype.constructor as any
          )({ initial: 1 });
          void new (
            WebAssembly.Instance.prototype.constructor as any
          )(module, {});

          const memoryFactory = () => WebAssembly.Memory;
          void memoryFactory;
          function* capabilities() {
            yield WebAssembly.Memory;
            yield WebAssembly.instantiate;
          }
          void capabilities;

          const box = { WebAssembly };
          retain(box);
          const {
            MemoryCtor = WebAssembly.Memory,
            instantiate = WebAssembly.instantiate,
          } = source;
          void new (MemoryCtor as any)({ initial: 1 });
          void instantiate(module, {});
        `,
          "authority-export.ts": `
          export default WebAssembly;
        `,
        },
        [],
      ),
      auditWasmAuthorityOrigins: true,
    });

    const findings = result.violations.map(
      (finding) => `${finding.kind}:${finding.text}`,
    );
    for (const expected of [
      "wasm-memory-authority:new root.WebAssembly.Memory",
      "wasm-instance-authority:root.WebAssembly.instantiate",
      'wasm-memory-authority:new globalThis["Web" + "Assembly"].Memory',
      'wasm-instance-authority:globalThis["Web" + "Assembly"].instantiate',
      "wasm-instance-authority:WebAssembly.instantiateStreaming",
      "wasm-instance-authority:stream(response",
      "wasm-memory-authority:new ( WebAssembly.Memory.prototype.constructor",
      "wasm-instance-authority:new ( WebAssembly.Instance.prototype.constructor",
      "wasm-memory-authority:new (MemoryCtor as any)",
      "wasm-instance-authority:instantiate(module",
      "dynamic-code-contract:self.eval",
      "dynamic-code-contract:self.Function",
      "dynamic-code-contract:WebAssembly.Memory.constructor",
      "wasm-authority-escape:WebAssembly.Memory",
      "wasm-authority-escape:WebAssembly.instantiate",
      "wasm-authority-escape:WebAssembly",
    ]) {
      expect(
        findings.some((finding) => finding.includes(expected)),
        `missing authority-policy finding ${expected}\n${findings.join("\n")}`,
      ).toBe(true);
    }
    expect(result.contractErrors).toEqual([]);
  });

  it("proves destination-factory capacity provenance beyond call text", () => {
    const source = (capacitySetup: string) => ({
      "caller.ts": `
        class Kernel {
          #destination(
            pointer: number,
            capacity: number,
            label: string,
          ): object {
            return { pointer, capacity, label };
          }
          readonly imports = {
            host_write: (pointer: number): void => {
              ${capacitySetup}
              this.#destination(pointer, capacity, "test destination");
            },
          };
        }
      `,
    });
    const destinationFactoryDeclarations = ["caller.ts::Kernel.#destination"];
    const safe = auditWasmMemoryWrites({
      ...virtualAuditOptions(source("const capacity = 8;"), []),
      kernelDestinationFactoryDeclarations: destinationFactoryDeclarations,
    });
    expect(
      safe.violations.filter(
        (finding) => finding.kind === "kernel-destination-factory-call",
      ),
    ).toHaveLength(1);
    expect(
      safe.violations.some(
        (finding) => finding.kind === "kernel-destination-factory-unsafe",
      ),
    ).toBe(false);
    const reviewedCall: AuditAllowance = {
      key: safe.violations.find(
        (finding) => finding.kind === "kernel-destination-factory-call",
      )!.key,
      disposition: "rust-lent",
      why: "The pointer is the exact import formal and capacity is fixed.",
    };

    const reassigned = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        source("let capacity = 8; capacity = 65536;"),
        [],
        [reviewedCall],
      ),
      kernelDestinationFactoryDeclarations: destinationFactoryDeclarations,
    });
    expect(reassigned.unusedAllowances).toEqual([]);
    expect(
      reassigned.violations.some(
        (finding) => finding.kind === "kernel-destination-factory-unsafe",
      ),
    ).toBe(true);

    const extracted = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "caller.ts": `
          class Kernel {
            #destination(
              pointer: number,
              capacity: number,
              label: string,
            ): object {
              return { pointer, capacity, label };
            }
            write(pointer: number, capacity: number): void {
              const factory = this.#destination;
              factory(pointer, capacity, "test destination");
            }
          }
        `,
        },
        [],
      ),
      kernelDestinationFactoryDeclarations: destinationFactoryDeclarations,
    });
    expect(
      extracted.violations.some(
        (finding) => finding.kind === "kernel-destination-factory-unsafe",
      ),
    ).toBe(true);

    const forwarded = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "caller.ts": `
          class Kernel {
            #destination(
              pointer: number,
              capacity: number,
              label: string,
            ): object {
              return { pointer, capacity, label };
            }
            #publish(pointer: number, capacity: number): void {
              this.#destination(
                pointer,
                capacity,
                "forwarded destination",
              );
            }
            readonly imports = {
              host_write: (
                pointer: number,
                capacity: number,
              ): void => {
                capacity = 65536;
                this.#publish(pointer, capacity);
              },
            };
          }
        `,
        },
        [],
      ),
      kernelDestinationFactoryDeclarations: destinationFactoryDeclarations,
    });
    expect(
      forwarded.violations.some(
        (finding) => finding.kind === "kernel-destination-factory-call",
      ),
    ).toBe(true);
    expect(
      forwarded.violations.some(
        (finding) => finding.kind === "kernel-destination-factory-unsafe",
      ),
    ).toBe(true);
  });

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
    expect(
      result.findings.filter((finding) => finding.kind === "kernel-view"),
    ).toHaveLength(2);
    expect(
      result.findings.filter((finding) => finding.kind === "kernel-write"),
    ).toHaveLength(2);
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
    expect(
      result.findings.some(
        (finding) =>
          finding.file === "view.ts" && finding.kind === "kernel-view-return",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.file === "kernel.ts" && finding.kind === "kernel-write",
      ),
    ).toBe(true);
  });

  it("tracks captured WebAssembly buffer and exports getters", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
          "kernel_recv",
        ] as const);
      `,
        "kernel.ts": `
        const intrinsicApply = Reflect.apply;
        const intrinsicMemoryBuffer = Object.getOwnPropertyDescriptor(
          WebAssembly.Memory.prototype,
          "buffer",
        )!.get!;
        const intrinsicInstanceExports = Object.getOwnPropertyDescriptor(
          WebAssembly.Instance.prototype,
          "exports",
        )!.get!;

        function memoryBuffer(
          memory: WebAssembly.Memory,
        ): ArrayBufferLike {
          return intrinsicApply(intrinsicMemoryBuffer, memory, []);
        }

        function instanceExports(
          instance: WebAssembly.Instance,
        ): WebAssembly.Exports {
          return intrinsicApply(intrinsicInstanceExports, instance, []);
        }

        class Kernel {
          memory!: WebAssembly.Memory;
          processMemory!: WebAssembly.Memory;
          instance!: WebAssembly.Instance;

          write(bytes: Uint8Array): void {
            new Uint8Array(memoryBuffer(this.memory)).set(bytes);
          }

          writeProcess(bytes: Uint8Array): void {
            new Uint8Array(memoryBuffer(this.processMemory)).set(bytes);
          }

          invoke(): void {
            const recv = instanceExports(this.instance).kernel_recv as (
              fd: number,
              pointer: number,
              capacity: number,
            ) => number;
            recv(1, 4096, 8);
          }
        }
      `,
      },
      [
        kernelMemorySeed(),
        {
          declaration: "kernel.ts::Kernel.instance",
          target: "value",
          owner: "kernel",
          form: "instance",
          why: "This fixture field is the exact instantiated kernel module.",
        },
        {
          declaration: "kernel.ts::Kernel.processMemory",
          target: "value",
          owner: "process-memory",
          form: "memory",
          why: "This fixture field is caller process memory, not kernel memory.",
        },
      ],
    );

    expect(result.unresolvedSeeds).toEqual([]);
    expect(
      result.findings.filter(
        (finding) =>
          finding.kind === "kernel-write" &&
          finding.text.includes(".set(bytes)"),
      ),
    ).toHaveLength(1);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-pointer-export-bypass" &&
          finding.text === "recv(1, 4096, 8)",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-escape" &&
          finding.text.includes("intrinsicApply"),
      ),
    ).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-buffer-return" &&
          finding.enclosing === "memoryBuffer",
      ),
    ).toBe(false);
  });

  it("does not trust same-spelled custom getter helpers", () => {
    const result = auditVirtual({
      "kernel.ts": `
        declare const intrinsicApply: (
          getter: unknown,
          receiver: unknown,
          args: readonly unknown[],
        ) => ArrayBuffer;
        const intrinsicMemoryBuffer = () => new ArrayBuffer(16);

        class Kernel {
          memory!: WebAssembly.Memory;
          write(bytes: Uint8Array): void {
            const buffer = intrinsicApply(
              intrinsicMemoryBuffer,
              this.memory,
              [],
            );
            new Uint8Array(buffer).set(bytes);
          }
        }
      `,
    });

    expect(
      result.findings.some((finding) => finding.kind === "kernel-write"),
    ).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-escape" &&
          finding.text.includes("intrinsicApply"),
      ),
    ).toBe(true);
  });

  it("keeps captured export provenance through a checked helper", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
          "kernel_recv",
        ] as const);
      `,
        "kernel.ts": `
        const intrinsicApply = Reflect.apply;
        const intrinsicReflectGet = Reflect.get;
        const intrinsicInstanceExports = Object.getOwnPropertyDescriptor(
          WebAssembly.Instance.prototype,
          "exports",
        )!.get!;

        function instanceExports(
          instance: WebAssembly.Instance,
        ): WebAssembly.Exports {
          try {
            return intrinsicApply(intrinsicInstanceExports, instance, []);
          } catch {
            return intrinsicReflectGet(
              instance,
              "exports",
            ) as WebAssembly.Exports;
          }
        }

        function requiredExport(
          instance: WebAssembly.Instance,
          name: string,
        ): (...args: number[]) => number {
          const value = instanceExports(instance)[name];
          if (typeof value !== "function") throw new Error("missing");
          return value as (...args: number[]) => number;
        }

        class Kernel {
          instance!: WebAssembly.Instance;
          invoke(): void {
            const recv = requiredExport(this.instance, "kernel_recv");
            recv(1, 4096, 8);
          }
        }
      `,
      },
      [
        {
          declaration: "kernel.ts::Kernel.instance",
          target: "value",
          owner: "kernel",
          form: "instance",
          why: "This fixture field is the exact instantiated kernel module.",
        },
      ],
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-pointer-export-bypass" &&
          finding.text === "recv(1, 4096, 8)",
      ),
      result.findings.map(({ key }) => key).join("\n"),
    ).toBe(true);
  });

  it("models exact captured reads, detached slice, and Uint8Array set", () => {
    const result = auditVirtual({
      "kernel.ts": `
        const intrinsicApply = Reflect.apply;
        const intrinsicArrayBufferByteLength =
          Object.getOwnPropertyDescriptor(
            ArrayBuffer.prototype,
            "byteLength",
          )!.get!;
        const intrinsicSharedArrayBufferByteLength =
          Object.getOwnPropertyDescriptor(
            SharedArrayBuffer.prototype,
            "byteLength",
          )!.get!;
        const intrinsicDataViewGetUint16 = DataView.prototype.getUint16;
        const intrinsicDataViewGetUint32 = DataView.prototype.getUint32;
        const intrinsicUint8ArraySet = Uint8Array.prototype.set;
        const intrinsicUint8ArraySlice = Uint8Array.prototype.slice;
        const intrinsicAtomicsWait = Atomics.wait;
        const intrinsicAtomicsNotify = Atomics.notify;

        class Kernel {
          memory!: WebAssembly.Memory;
          inspect(bytes: Uint8Array): void {
            const buffer = this.memory.buffer;
            const view = new Uint8Array(buffer);
            const data = new DataView(buffer);
            const words = new Int32Array(buffer);
            intrinsicApply(
              intrinsicArrayBufferByteLength,
              buffer,
              [],
            );
            intrinsicApply(
              intrinsicSharedArrayBufferByteLength,
              buffer,
              [],
            );
            intrinsicApply(
              intrinsicDataViewGetUint16,
              data,
              [0, true],
            );
            intrinsicApply(
              intrinsicDataViewGetUint32,
              data,
              [0, true],
            );
            const detached = intrinsicApply(
              intrinsicUint8ArraySlice,
              view,
              [0, 1],
            );
            detached.set(bytes);
            intrinsicApply(
              intrinsicAtomicsWait,
              Atomics,
              [words, 0, 0, 0],
            );
            intrinsicApply(
              intrinsicAtomicsNotify,
              Atomics,
              [words, 0, 1],
            );
            intrinsicApply(
              intrinsicUint8ArraySet,
              view,
              [bytes, 0],
            );
          }
        }
      `,
    });

    const intrinsicEscapes = result.findings.filter(
      (finding) =>
        finding.kind.endsWith("-escape") &&
        finding.text.includes("intrinsicApply"),
    );
    expect(intrinsicEscapes).toEqual([]);
    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("intrinsicUint8ArraySet");
  });

  it("does not admit a same-spelled captured mutator", () => {
    const result = auditVirtual({
      "kernel.ts": `
        const intrinsicApply = Reflect.apply;
        declare const intrinsicUint8ArraySet: (
          bytes: Uint8Array,
          offset: number,
        ) => void;
        class Kernel {
          memory!: WebAssembly.Memory;
          write(bytes: Uint8Array): void {
            const view = new Uint8Array(this.memory.buffer);
            intrinsicApply(
              intrinsicUint8ArraySet,
              view,
              [bytes, 0],
            );
          }
        }
      `,
    });

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-view-escape" &&
          finding.text.includes("intrinsicApply"),
      ),
    ).toBe(true);
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
    expect(
      writes.some((finding) => finding.text.includes("Atomics.store")),
    ).toBe(true);
    expect(writes.some((finding) => finding.text.includes("setBigInt64"))).toBe(
      true,
    );
    expect(writes.some((finding) => finding.text.includes("Buffer.from"))).toBe(
      true,
    );
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

  it("rejects computed calls on kernel views while admitting exact read-only intrinsics", () => {
    const result = auditVirtual({
      "kernel.ts": `
        class Kernel {
          memory!: WebAssembly.Memory;
          inspect(
            data: Uint8Array,
            computedSet: keyof Uint8Array,
            computedCallable: keyof Uint8Array,
          ): number {
            const raw = new Uint8Array(this.memory.buffer);
            (raw[computedSet] as (data: Uint8Array) => void)(data);
            (raw[computedCallable] as Function)(data);
            const detached = raw.slice();
            return detached.byteLength;
          }
        }
      `,
    });

    const escapes = result.findings.filter(
      (finding) => finding.kind === "kernel-view-escape",
    );
    expect(escapes).toHaveLength(2);
    expect(
      escapes.some((finding) => finding.text.includes("raw[computedSet]")),
    ).toBe(true);
    expect(
      escapes.some((finding) => finding.text.includes("raw[computedCallable]")),
    ).toBe(true);
    expect(
      escapes.some((finding) => finding.text.includes("raw.slice()")),
    ).toBe(false);
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

    expect(
      result.findings.some((finding) => finding.kind === "kernel-view-store"),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.kind === "kernel-view-escape"),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.kind === "kernel-view-return"),
    ).toBe(true);
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
    expect(writes.some((finding) => finding.enclosing === "Holder.write")).toBe(
      true,
    );
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-return" &&
          finding.enclosing === "wrap",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-buffer-return" &&
          finding.enclosing === "wrap",
      ),
    ).toBe(true);
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

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-buffer-store" &&
          finding.text === "this.saved = initial.buffer",
      ),
    ).toBe(true);
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

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-write" && finding.text === "alias.set(data)",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-escape" &&
          finding.text === "opaque({ ...first })",
      ),
    ).toBe(true);
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

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-view-escape" &&
          finding.text === "opaque(...[view])",
      ),
    ).toBe(true);
    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(writes).toHaveLength(2);
    expect(writes.some((finding) => finding.text === "[view[0]] = [1]")).toBe(
      true,
    );
    expect(
      writes.some(
        (finding) => finding.text === "{ value: view[1] } = { value: 2 }",
      ),
    ).toBe(true);
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
    expect(
      writes.some((finding) => finding.text === "(0, view).set(data)"),
    ).toBe(true);
    expect(writes.some((finding) => finding.text === "fromAt.set(data)")).toBe(
      true,
    );
    expect(writes.some((finding) => finding.text === "item.set(data)")).toBe(
      true,
    );
    expect(
      writes.some((finding) => finding.text === "fromLogical?.set(data)"),
    ).toBe(true);
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
    expect(
      writes.filter((finding) => finding.text === "item.set(data)"),
    ).toHaveLength(7);
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
    expect(
      escapes.some(
        (finding) => finding.text === "opaque(new Holder(this.memory))",
      ),
    ).toBe(true);
    expect(escapes.some((finding) => finding.text === "opaque(wrapper)")).toBe(
      true,
    );
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

    expect(
      result.findings.filter(
        (finding) =>
          finding.kind === "kernel-write" &&
          finding.text.includes(".set(data)"),
      ),
    ).toHaveLength(2);
    expect(
      result.findings.filter(
        (finding) => finding.kind === "kernel-memory-escape",
      ),
    ).toHaveLength(1);
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

    expect(
      result.findings.filter((finding) => finding.kind === "kernel-write"),
    ).toHaveLength(1);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-return" &&
          finding.enclosing === "Kernel.currentMemory",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-buffer-return" &&
          finding.enclosing.endsWith(".currentBuffer"),
      ),
    ).toBe(true);
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

    expect(
      result.findings.filter((finding) => finding.kind === "kernel-write"),
    ).toHaveLength(2);
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

    expect(
      result.findings.filter((finding) => finding.kind === "kernel-view"),
    ).toHaveLength(2);
    expect(
      result.findings.filter((finding) => finding.kind === "kernel-write"),
    ).toHaveLength(2);
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

    expect(
      result.findings.filter(
        (finding) => finding.kind === "kernel-memory-escape",
      ),
    ).toHaveLength(2);
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
    expect(
      result.findings.filter(
        (finding) => finding.kind === "kernel-memory-store",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-store" &&
          finding.text === "retained = memory",
      ),
    ).toBe(true);
  });

  it("finds module initializers and parameter-property defaults", () => {
    const result = auditVirtual(
      {
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
      },
      [
        {
          declaration: "factory.ts::kernelMemory",
          target: "return",
          owner: "kernel",
          form: "memory",
          why: "This fixture factory returns only kernel memory.",
        },
      ],
    );

    expect(result.unresolvedSeeds).toEqual([]);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-store" &&
          finding.text === "retained = kernelMemory()",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-memory-store" &&
          finding.enclosing === "Holder.constructor",
      ),
    ).toBe(true);
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
    expect(escapes.some((finding) => finding.text.includes("sink.set"))).toBe(
      true,
    );
    expect(
      escapes.some((finding) => finding.text.includes("sink.decode")),
    ).toBe(true);
    expect(
      escapes.some((finding) => finding.text.includes("TextDecoder")),
    ).toBe(false);
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
    expect(escapes.some((finding) => finding.text.includes("Uint8Array"))).toBe(
      true,
    );
    expect(
      escapes.some((finding) => finding.text.includes("TextDecoder")),
    ).toBe(true);
    expect(
      escapes.some((finding) => finding.text.includes("Atomics.load")),
    ).toBe(true);
  });

  it("finds aliased and reflected scratch allocation/reservation calls", () => {
    const sources = {
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
            const transferBegin =
              exports.kernel_transfer_scratch_begin as
                (n: bigint) => bigint;
            transferBegin.call(undefined, 256n);
            const transferPointer =
              exports["kernel_transfer_scratch_pointer"] as
                (token: bigint) => bigint;
            transferPointer.apply(undefined, [1n]);
            const {
              kernel_transfer_scratch_capacity: rawTransferCapacity,
            } = exports;
            const transferCapacity = rawTransferCapacity as
              (token: bigint) => bigint;
            transferCapacity(1n);
            const transferCancel =
              exports.kernel_transfer_scratch_cancel as
                (token: bigint) => number;
            const cancelAlias = transferCancel;
            cancelAlias(1n);
            cancelAlias(1n);
          }
        }
      `,
    };
    const result = auditVirtual(sources);

    expect(
      result.findings.filter(
        (finding) => finding.kind === "scratch-allocator-call",
      ),
    ).toHaveLength(1);
    const reservationFindings = result.findings.filter(
      (finding) => finding.kind === "scratch-reservation-call",
    );
    expect(reservationFindings.map((finding) => finding.text)).toEqual([
      "beginAlias(128n)",
      "cancelAlias(1n)",
      "cancelAlias(1n)",
      "pointer()",
      "transferBegin.call(undefined, 256n)",
      "transferCapacity(1n)",
      "transferPointer.apply(undefined, [1n])",
    ]);

    const duplicateKey = reservationFindings.find(
      (finding) => finding.text === "cancelAlias(1n)",
    )!.key;
    const allowedOnce = auditVirtual(
      sources,
      [kernelMemorySeed()],
      [
        {
          key: duplicateKey,
          disposition: "scratch-core",
          count: 1,
          why: "The fixture deliberately admits only one exact cancellation.",
        },
      ],
    );
    expect(
      allowedOnce.violations.filter(
        (finding) =>
          finding.kind === "scratch-reservation-call" &&
          finding.key === duplicateKey,
      ),
    ).toHaveLength(1);
    expect(allowedOnce.unusedAllowances).toEqual([]);
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
    const result = auditVirtual(
      {
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
      },
      seeds,
    );

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

    const duplicate = auditVirtual(
      {
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
      },
      [kernelMemorySeed()],
      allowances,
    );
    expect(
      duplicate.violations.some((finding) => finding.kind === "kernel-write"),
    ).toBe(true);

    const stale = auditVirtual(
      sources,
      [kernelMemorySeed()],
      [
        ...allowances,
        {
          key: "new-file.ts::missing::kernel-write::missing()",
          disposition: "scratch-core",
          why: "This deliberately stale entry must be rejected by the audit.",
        },
      ],
    );
    expect(stale.unusedAllowances).toHaveLength(1);

    const literalQuestionMarks = auditVirtual(
      sources,
      [kernelMemorySeed()],
      [
        ...allowances,
        {
          key: "new-file.ts::missing::scratch-address-contract::value ?? null",
          disposition: "scratch-core",
          why: "Question marks are literal source text under exact key matching.",
        },
      ],
    );
    expect(literalQuestionMarks.unusedAllowances.map(({ key }) => key)).toEqual(
      ["new-file.ts::missing::scratch-address-contract::value ?? null"],
    );
  });

  it("audits a newly introduced source path without a filename allowlist", () => {
    const result = auditVirtual(
      {
        "new/subsystem/transfer.ts": `
        export class Kernel {
          memory!: WebAssembly.Memory;
          write(data: Uint8Array): void {
            new Uint8Array(this.memory.buffer).set(data);
          }
        }
      `,
      },
      [kernelMemorySeed("new/subsystem/transfer.ts::Kernel.memory")],
    );

    expect(result.sourceFiles).toContain("new/subsystem/transfer.ts");
    expect(
      result.violations.some(
        (finding) => finding.file === "new/subsystem/transfer.ts",
      ),
    ).toBe(true);
  });

  it.each(["js", "jsx", "mjs", "cjs"])(
    "audits a raw write introduced in a .%s runtime source",
    (extension) => {
      const file = `new/subsystem/transfer.${extension}`;
      const result = auditVirtual(
        {
          [file]: `
          export class Kernel {
            memory;
            write(data) {
              new Uint8Array(this.memory.buffer).set(data);
            }
          }
        `,
        },
        [kernelMemorySeed(`${file}::Kernel.memory`)],
      );

      expect(result.unresolvedSeeds).toEqual([]);
      expect(
        result.violations.some(
          (finding) => finding.file === file && finding.kind === "kernel-write",
        ),
      ).toBe(true);
    },
  );

  it("catches a TypeScript kernel owner written through an untyped JavaScript parameter", () => {
    const result = auditVirtual({
      "kernel.ts": `
        export class Kernel {
          memory!: WebAssembly.Memory;
          getMemory(): WebAssembly.Memory { return this.memory; }
        }
      `,
      "transfer.mjs": `
        export function write(kernel, data) {
          new Uint8Array(kernel.getMemory().buffer).set(data);
        }
      `,
    });

    expect(result.unresolvedSeeds).toEqual([]);
    expect(
      result.violations.some(
        (finding) =>
          finding.file === "transfer.mjs" && finding.kind === "kernel-write",
      ),
    ).toBe(true);
  });

  it("tracks JavaScript raw-memory and view aliases", () => {
    const result = auditVirtual(
      {
        "transfer.mjs": `
        export function write(kernel, data) {
          const memory = kernel.getMemory();
          const buffer = memory.buffer;
          const bytes = new Uint8Array(buffer);
          bytes.set(data);
        }
      `,
      },
      [],
    );

    expect(
      result.violations.some(
        (finding) =>
          finding.file === "transfer.mjs" && finding.kind === "kernel-write",
      ),
    ).toBe(true);
  });

  it("propagates a JavaScript raw-memory argument into a helper parameter", () => {
    const result = auditVirtual(
      {
        "transfer.mjs": `
        function publish(memory, data) {
          const view = new DataView(memory.buffer);
          view.setUint32(0, data.byteLength, true);
        }
        export function write(kernel, data) {
          publish(kernel.getMemory(), data);
        }
      `,
      },
      [],
    );

    expect(
      result.violations.some(
        (finding) =>
          finding.file === "transfer.mjs" && finding.kind === "kernel-write",
      ),
    ).toBe(true);
  });

  it("does not turn JavaScript reads or ordinary buffer writes into kernel writes", () => {
    const result = auditVirtual(
      {
        "transfer.mjs": `
        export function inspect(kernel, ordinary, data) {
          const byteLength = kernel.getMemory().buffer.byteLength;
          const raw = new DataView(kernel.getMemory().buffer);
          const value = raw.getUint32(0, true);
          new Uint8Array(ordinary).set(data);
          return { byteLength, value };
        }
      `,
      },
      [],
    );

    expect(
      result.findings.some((finding) => finding.kind === "kernel-view"),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.kind === "kernel-write"),
    ).toBe(false);
  });

  it("requires exact allowances for an unrelated JavaScript getMemory API", () => {
    const sources = {
      "cache.mjs": `
        export function update(cache, data) {
          new Uint8Array(cache.getMemory().buffer).set(data);
        }
      `,
    };
    const initial = auditVirtual(sources, []);
    const allowances: AuditAllowance[] = initial.findings.map((finding) => ({
      key: finding.key,
      disposition: "non-kernel",
      why: "This fixture's unrelated cache API deliberately shares the reviewed getMemory spelling.",
    }));

    expect(
      initial.violations.some((finding) => finding.kind === "kernel-write"),
    ).toBe(true);
    expect(formatAuditFailures(auditVirtual(sources, [], allowances))).toEqual(
      [],
    );
  });

  it("flags direct, aliased, and JavaScript scratch-region factories", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export function allocateKernelScratchRegion(..._args: unknown[]): object {
          return {};
        }
        export function reserveKernelScratchRegion(..._args: unknown[]): object {
          return {};
        }
      `,
        "caller.ts": `
        import {
          allocateKernelScratchRegion,
          reserveKernelScratchRegion as reserve,
        } from "./host/src/kernel-scratch";
        allocateKernelScratchRegion({}, () => 4096, 32, 4, "forged");
        const alias = reserve;
        alias({}, () => ({ pointer: 4096, capacity: 32 }), 32, 4, "forged");
      `,
        "caller.js": `
        import { allocateKernelScratchRegion as make } from "./host/src/kernel-scratch";
        make({}, () => 4096, 32, 4, "forged-js");
      `,
      },
      [],
    );

    const factoryFindings = result.findings.filter(
      (finding) => finding.kind === "scratch-region-factory-call",
    );
    expect(factoryFindings).toHaveLength(3);
    expect(new Set(factoryFindings.map((finding) => finding.file))).toEqual(
      new Set(["caller.ts", "caller.js"]),
    );
  });

  it("tracks kernel instance export memory through TypeScript and JavaScript", () => {
    const result = auditVirtual(
      {
        "kernel.ts": `
        export class Kernel {
          instance!: WebAssembly.Instance;
          getInstance(): WebAssembly.Instance { return this.instance; }
          direct(data: Uint8Array): void {
            const memory = this.getInstance().exports.memory as WebAssembly.Memory;
            new Uint8Array(memory.buffer).set(data);
          }
          aliased(data: Uint8Array): void {
            const instance = this.getInstance();
            const { exports } = instance;
            const { memory } = exports as { memory: WebAssembly.Memory };
            new Uint8Array(memory.buffer).set(data);
          }
        }
      `,
        "diagnostic.js": `
        export function overwrite(kernel, data) {
          const instance = kernel.getInstance();
          const { exports } = instance;
          new Uint8Array(exports.memory.buffer).set(data);
        }
      `,
      },
      [
        {
          declaration: "kernel.ts::Kernel.instance",
          target: "value",
          owner: "kernel",
          form: "instance",
          why: "This fixture field is the instantiated kernel module.",
        },
      ],
    );

    expect(result.unresolvedSeeds).toEqual([]);
    const writes = result.findings.filter(
      (finding) => finding.kind === "kernel-write",
    );
    expect(
      writes.filter((finding) => finding.file === "kernel.ts"),
    ).toHaveLength(2);
    expect(
      writes.filter((finding) => finding.file === "diagnostic.js"),
    ).toHaveLength(1);
  });

  it("rejects every raw pointer-bearing kernel-export invocation shape", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
          "kernel_ioctl",
          "kernel_recv",
        ] as const);
      `,
        "caller.ts": `
        declare function opaque(value: unknown): void;
        class Kernel {
          instance!: WebAssembly.Instance;
          invoke(): void {
            const exports = this.instance.exports;
            exports.kernel_recv(1, 4096, 8, 0);
            exports["kernel_recv"](1, 4096, 8, 0);
            const alias = exports.kernel_recv as (...args: number[]) => number;
            alias(1, 4096, 8, 0);
            const { kernel_recv: destructured } = exports;
            (destructured as (...args: number[]) => number)(1, 4096, 8, 0);
            const dynamicName = "kernel_recv";
            (exports[dynamicName] as (...args: number[]) => number)(
              1,
              4096,
              8,
              0,
            );
            alias.call(undefined, 1, 4096, 8, 0);
            alias.apply(undefined, [1, 4096, 8, 0]);
            const bound = alias.bind(undefined, 1, 4096, 8, 0);
            bound();
            Reflect.apply(alias, undefined, [1, 4096, 8, 0]);
            opaque(alias);
            opaque({ fn: alias });
            opaque([alias]);
            const frozen = Object.freeze({ fn: alias });
            frozen.fn(1, 4096, 8, 0);
          }
        }
      `,
      },
      [
        {
          declaration: "caller.ts::Kernel.instance",
          target: "value",
          owner: "kernel",
          form: "instance",
          why: "This fixture field is the exact instantiated kernel module.",
        },
      ],
    );

    expect(result.contractErrors).toEqual([]);
    const bypasses = result.findings.filter(
      (finding) => finding.kind === "kernel-pointer-export-bypass",
    );
    for (const snippet of [
      "exports.kernel_recv(",
      'exports["kernel_recv"](',
      "alias(",
      "destructured as",
      "exports[dynamicName]",
      "alias.call(",
      "alias.apply(",
      "alias.bind(",
      "bound()",
      "Reflect.apply(",
      "opaque(alias)",
      "opaque({ fn: alias })",
      "opaque([alias])",
      "frozen.fn(",
    ]) {
      expect(
        bypasses.some((finding) => finding.text.includes(snippet)),
        bypasses.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
  });

  it("defaults generated kernel exports to denied even when the scratch list omits them", () => {
    const result = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "host/src/kernel-scratch.ts": `
          const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
            "kernel_recv",
          ] as const);
        `,
          "caller.ts": `
          declare function retainExportNamespace(
            strings: TemplateStringsArray,
            namespace: WebAssembly.Exports,
          ): unknown;
          class Kernel {
            instance!: WebAssembly.Instance;
            leaked: unknown;
            setSocketOption(value: number): number {
              const set = this.instance.exports.kernel_setsockopt as (
                fd: number,
                level: number,
                name: number,
                pointer: number,
                length: number,
              ) => number;
              return set(7, 1, 2, value);
            }
            leakSocketOption(): unknown {
              this.leaked = this.instance.exports.kernel_setsockopt;
              return this.instance.exports.kernel_setsockopt;
            }
            reflectSocketOption(value: number): number {
              const set = Reflect.get(
                this.instance.exports,
                "kernel_setsockopt",
              ) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectNamedSocketOption(value: number): number {
              const name = "kernel_setsockopt";
              const set = Reflect.get(
                this.instance.exports,
                name,
              ) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectDynamicSocketOption(
              name: string,
              value: number,
            ): number {
              const set = Reflect.get(
                this.instance.exports,
                name,
              ) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            describeSocketOption(value: number): number {
              const set = Object.getOwnPropertyDescriptor(
                this.instance.exports,
                "kernel_setsockopt",
              )!.value as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectDescribeSocketOption(value: number): number {
              const descriptor = Reflect.getOwnPropertyDescriptor(
                this.instance.exports,
                "kernel_setsockopt",
              )!;
              const set = descriptor.value as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            describeAllSocketOptions(value: number): number {
              const set = Object.getOwnPropertyDescriptors(
                this.instance.exports,
              ).kernel_setsockopt.value as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            valuesSocketOption(value: number): number {
              const set = Object.values(
                this.instance.exports,
              )[0] as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            entriesSocketOption(value: number): number {
              const set = Object.entries(
                this.instance.exports,
              )[0]![1] as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            assignedSocketOption(value: number): number {
              const set = Object.assign(
                {},
                this.instance.exports,
              ).kernel_setsockopt as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            spreadSocketOption(value: number): number {
              const set = {
                ...this.instance.exports,
              }.kernel_setsockopt as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            restSocketOption(value: number): number {
              const {
                ...copied
              } = this.instance.exports;
              const set = copied.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            restAssignmentSocketOption(value: number): number {
              let copied: WebAssembly.Exports;
              ({
                ...copied
              } = this.instance.exports);
              const set = copied.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            inheritedSocketOption(value: number): number {
              const derived = Object.create(this.instance.exports) as
                WebAssembly.Exports;
              const set = derived.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            setPrototypeSocketOption(value: number): number {
              const derived = Object.setPrototypeOf(
                {},
                this.instance.exports,
              ) as WebAssembly.Exports;
              const set = derived.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectSetPrototypeSocketOption(value: number): number {
              const derived: WebAssembly.Exports = {};
              Reflect.setPrototypeOf(derived, this.instance.exports);
              const set = derived.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            protoLiteralSocketOption(value: number): number {
              const derived = {
                __proto__: this.instance.exports,
              } as WebAssembly.Exports;
              const set = derived.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            proxySocketOption(value: number): number {
              const derived = new Proxy(this.instance.exports, {});
              const set = derived.kernel_setsockopt as
                (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectCallSocketOption(value: number): number {
              const set = Reflect.get.call(
                Reflect,
                this.instance.exports,
                "kernel_setsockopt",
              ) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            reflectApplySocketOption(value: number): number {
              const set = Reflect.get.apply(Reflect, [
                this.instance.exports,
                "kernel_setsockopt",
              ]) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            intrinsicApplySocketOption(value: number): number {
              const set = Reflect.apply(Reflect.get, Reflect, [
                this.instance.exports,
                "kernel_setsockopt",
              ]) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            descriptorCallSocketOption(value: number): number {
              const descriptor = Object.getOwnPropertyDescriptor.call(
                Object,
                this.instance.exports,
                "kernel_setsockopt",
              )!;
              const set = descriptor.value as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            descriptorApplySocketOption(value: number): number {
              const descriptor = Reflect.apply(
                Reflect.getOwnPropertyDescriptor,
                Reflect,
                [this.instance.exports, "kernel_setsockopt"],
              )!;
              const set = descriptor.value as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            spreadDispatchSocketOption(value: number): number {
              const args: [WebAssembly.Exports, string] = [
                this.instance.exports,
                "kernel_setsockopt",
              ];
              const set = Reflect.get(
                ...args
              ) as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            taggedSocketOption(value: number): number {
              const set = retainExportNamespace\`\${this.instance.exports}\`
                as (...args: number[]) => number;
              return set(7, 1, 2, value);
            }
            listExportNames(): string[] {
              return Object.keys(this.instance.exports);
            }
            listExportKeys(): (string | symbol)[] {
              return Reflect.ownKeys(this.instance.exports);
            }
          }
        `,
        },
        [
          {
            declaration: "caller.ts::Kernel.instance",
            target: "value",
            owner: "kernel",
            form: "instance",
            why: "This fixture field is the exact instantiated kernel module.",
          },
        ],
      ),
      kernelExportNames: ["kernel_recv", "kernel_setsockopt"],
    });

    expect(result.contractErrors).toEqual([]);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.text === "set(7, 1, 2, value)",
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.text.includes(
            "this.leaked = this.instance.exports.kernel_setsockopt",
          ),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.text.includes(
            "return this.instance.exports.kernel_setsockopt",
          ),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.enclosing.endsWith(".reflectSocketOption"),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.enclosing.endsWith(".reflectNamedSocketOption"),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-pointer-export-bypass" &&
          finding.enclosing.endsWith(".reflectDynamicSocketOption"),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.enclosing.endsWith(".describeSocketOption"),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.enclosing.endsWith(".reflectDescribeSocketOption"),
      ),
    ).toBe(true);
    const unmodeledExtractionMethods = [
      "describeAllSocketOptions",
      "valuesSocketOption",
      "entriesSocketOption",
      "assignedSocketOption",
      "spreadSocketOption",
      "restSocketOption",
      "restAssignmentSocketOption",
      "inheritedSocketOption",
      "setPrototypeSocketOption",
      "reflectSetPrototypeSocketOption",
      "protoLiteralSocketOption",
      "proxySocketOption",
      "reflectCallSocketOption",
      "reflectApplySocketOption",
      "intrinsicApplySocketOption",
      "descriptorCallSocketOption",
      "descriptorApplySocketOption",
      "spreadDispatchSocketOption",
      "taggedSocketOption",
      "listExportNames",
      "listExportKeys",
    ].filter(
      (method) =>
        !result.findings.some(
          (finding) =>
            (finding.kind === "kernel-export-direct-use" ||
              finding.kind === "kernel-pointer-export-bypass") &&
            finding.enclosing.endsWith(`.${method}`),
        ),
    );
    expect(unmodeledExtractionMethods).toEqual([]);
  });

  it("requires every runtime scratch export to exist in the generated export set", () => {
    const result = auditWasmMemoryWrites({
      ...virtualAuditOptions(
        {
          "host/src/kernel-scratch.ts": `
          const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
            "kernel_recv",
          ] as const);
        `,
        },
        [],
      ),
      kernelExportNames: ["kernel_setsockopt"],
    });

    expect(result.contractErrors).toContain(
      "kernel scratch export kernel_recv is absent from the generated kernel export set",
    );
  });

  it("keeps raw-call allowances exact and does not broadly exclude token-only exports", () => {
    const sources = {
      "host/src/kernel-scratch.ts": `
        const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
          "kernel_ioctl",
        ] as const);
      `,
      "caller.ts": `
        class Kernel {
          instance!: WebAssembly.Instance;
          invoke(): void {
            const exports = this.instance.exports;
            const ioctl = exports.kernel_ioctl as (...args: number[]) => number;
            ioctl(1, 2, 3, 0, 4);
            const reserved = exports.kernel_spawn_reserved_process as (
              parentPid: number,
              callerTid: number,
              token: bigint,
              length: number,
            ) => number;
            reserved(1, 2, 3n, 4);
          }
        }
      `,
    };
    const seeds: OwnershipSeed[] = [
      {
        declaration: "caller.ts::Kernel.instance",
        target: "value",
        owner: "kernel",
        form: "instance",
        why: "This fixture field is the exact instantiated kernel module.",
      },
    ];
    const initial = auditVirtual(sources, seeds);
    const ioctlFinding = initial.findings.find(
      (finding) =>
        finding.kind === "kernel-pointer-export-bypass" &&
        finding.text === "ioctl(1, 2, 3, 0, 4)",
    );
    expect(ioctlFinding).toBeDefined();
    expect(
      initial.findings.some(
        (finding) =>
          finding.kind === "kernel-pointer-export-bypass" &&
          finding.text.includes("reserved("),
      ),
    ).toBe(false);
    const generated = auditWasmMemoryWrites({
      ...virtualAuditOptions(sources, seeds),
      kernelExportNames: ["kernel_ioctl", "kernel_spawn_reserved_process"],
    });
    expect(
      generated.findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.text === "reserved(1, 2, 3n, 4)",
      ),
    ).toBe(true);

    const allowance: AuditAllowance = {
      key: ioctlFinding!.key,
      disposition: "kernel-control",
      why: "This exact fixture models a reviewed scalar-only ioctl call.",
    };
    expect(
      formatAuditFailures(auditVirtual(sources, seeds, [allowance])),
    ).toEqual([]);

    const duplicated = auditVirtual(
      {
        ...sources,
        "caller.ts": sources["caller.ts"].replace(
          "ioctl(1, 2, 3, 0, 4);",
          "ioctl(1, 2, 3, 0, 4); ioctl(1, 2, 3, 0, 4);",
        ),
      },
      seeds,
      [allowance],
    );
    expect(
      duplicated.violations.some(
        (finding) => finding.kind === "kernel-pointer-export-bypass",
      ),
    ).toBe(true);
  });

  it("fails closed when the authoritative pointer-export contract disappears", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": "export {};",
      },
      [],
    );
    expect(result.contractErrors).toHaveLength(1);
    expect(formatAuditFailures(result)[0]).toContain(
      "KERNEL_SCRATCH_EXPORT_NAMES",
    );
  });

  it("flags typed-array callbacks and iterators that retain a kernel view", () => {
    const result = auditVirtual(
      {
        "kernel.ts": `
        class Kernel {
          raw!: Uint8Array;
          use(): void {
            this.raw.forEach((_value, _index, whole) => {
              whole[0] = 1;
            });
            const values = this.raw.values();
            const entries = this.raw.entries();
            opaque(values, entries);
          }
        }
        declare function opaque(...values: unknown[]): void;
      `,
      },
      [
        {
          declaration: "kernel.ts::Kernel.raw",
          target: "value",
          owner: "kernel",
          form: "view",
          why: "This fixture view aliases the kernel linear memory.",
        },
      ],
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "kernel-write" &&
          finding.text.includes("whole[0] = 1"),
      ),
    ).toBe(true);
    expect(
      result.findings.filter(
        (finding) =>
          finding.kind === "kernel-view-escape" &&
          (finding.text.includes(".values()") ||
            finding.text.includes(".entries()")),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("accepts exact lease operations from a genuine exact region", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchDataView {
          setBigInt64(offset: number, value: bigint, littleEndian?: boolean): void;
        }
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          assertRange(offset: number, length: number): void;
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
          dataView(offset: number, length: number): KernelScratchDataView;
          writeAddress(
            destinationOffset: number,
            sourceOffset: number,
            sourceLength: number,
            encoding: "u64-le",
          ): void;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class Kernel {
          consume(region: KernelScratchRegion): void {
            const exactRegion: KernelScratchRegion = region;
            exactRegion.withLease((lease) => {
              const exactLease: KernelScratchLease = lease;
              const pointer = exactLease.exportPointer(0, 8);
              exactLease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 8, 0],
              );
              exactLease.assertRange(0, 16);
              exactLease.dataView(0, 16).setBigInt64(0, 0n, true);
              exactLease.writeAddress(8, 8, 8, "u64-le");
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.consume.$param:region")],
    );

    expect(
      result.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);
  });

  it("accepts allocator-only fields and exact projected helper returns", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
          revoke(): void;
        }
        export function allocateKernelScratchRegion(): KernelScratchRegion {
          throw new Error("fixture");
        }
        export function reserveKernelScratchRegion(): KernelScratchRegion {
          throw new Error("fixture");
        }
      `,
        "caller.ts": `
        import {
          allocateKernelScratchRegion,
          reserveKernelScratchRegion,
          type KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface Reservation {
          region: KernelScratchRegion;
        }
        class Kernel {
          private region: KernelScratchRegion | null = null;
          init(): void {
            this.region = allocateKernelScratchRegion();
          }
          private requireRegion(): KernelScratchRegion {
            if (!this.region) throw new Error("not initialized");
            return this.region;
          }
          private reserve(enabled: boolean): {
            reservation: Reservation | null;
          } {
            if (!enabled) return { reservation: null };
            const region = reserveKernelScratchRegion();
            return { reservation: { region } };
          }
          run(enabled: boolean): void {
            this.requireRegion().withLease((lease) => {
              const pointer = lease.exportPointer(0, 8);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 8, 0],
              );
            });
            const begun = this.reserve(enabled);
            const reservation = begun.reservation;
            if (reservation?.region) {
              const activeRegion = reservation.region;
              activeRegion.withLease((lease) => {
                const pointer = lease.exportPointer(8, 8);
                lease.invokeKernelExport(
                  "kernel_recv",
                  [1, pointer, 8, 0],
                );
              });
              reservation.region.revoke();
            }
          }
        }
        const kernel = new Kernel();
        kernel.init();
        const internals = kernel as unknown as {
          region: KernelScratchRegion;
        };
        const castRegion = internals.region;
        castRegion.withLease((lease) => {
          const pointer = lease.exportPointer(16, 8);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 8, 0],
          );
        });
      `,
      },
      [],
    );

    expect(
      result.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);
  });

  it("accepts only the exact WeakMap-validated scratch region projection", () => {
    const scratchModule = `
      export interface KernelScratchExportPointer {
        readonly opaque: unique symbol;
      }
      export interface KernelScratchLease {
        exportPointer(
          offset: number,
          length: number,
        ): KernelScratchExportPointer;
        invokeKernelExport(
          name: string,
          args: readonly unknown[],
        ): number;
      }
      export interface KernelScratchRegion {
        withLease<T>(operation: (lease: KernelScratchLease) => T): T;
      }
      export function validateKernelScratchRegionOwnership(
        _candidate: KernelScratchRegion,
      ): { readonly region: KernelScratchRegion } {
        throw new Error("fixture private WeakMap validation");
      }
    `;
    const good = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "caller.ts": `
        import {
          validateKernelScratchRegionOwnership,
          type KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class Kernel {
          private region: KernelScratchRegion | null = null;
          initialize(candidate: KernelScratchRegion): void {
            const owner =
              validateKernelScratchRegionOwnership(candidate);
            this.region = owner.region;
          }
          run(): void {
            if (!this.region) throw new Error("not initialized");
            this.region.withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.region")],
    );
    expect(
      good.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);

    const unsafe = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "caller.ts": `
        import type {
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        function validateKernelScratchRegionOwnership(
          candidate: KernelScratchRegion,
        ): { readonly region: KernelScratchRegion } {
          return { region: candidate };
        }
        class Kernel {
          private region: KernelScratchRegion | null = null;
          initialize(candidate: KernelScratchRegion): void {
            const fakeOwner =
              validateKernelScratchRegionOwnership(candidate);
            this.region = fakeOwner.region;
          }
          run(): void {
            if (!this.region) throw new Error("not initialized");
            this.region.withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.region")],
    );
    expect(
      unsafe.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text.includes("this.region.withLease"),
      ),
      unsafe.findings.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("canonicalizes #private roots only within their exact class owner", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
        export function allocateKernelScratchRegion(): KernelScratchRegion {
          throw new Error("fixture");
        }
      `,
        "caller.ts": `
        import {
          allocateKernelScratchRegion,
          type KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class ExactOwner {
          #region: KernelScratchRegion | null = null;
          init(): void {
            this.#region = allocateKernelScratchRegion();
          }
          #requireRegion(): KernelScratchRegion {
            if (!this.#region) throw new Error("not initialized");
            return this.#region;
          }
          #sameOwnerAlias(): KernelScratchRegion {
            return this.#requireRegion();
          }
          run(): void {
            this.#sameOwnerAlias().withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
        class SameSpellingButUntrusted {
          #region: KernelScratchRegion;
          constructor(region: KernelScratchRegion) {
            this.#region = region;
          }
          #requireRegion(): KernelScratchRegion {
            return this.#region;
          }
          #sameOwnerAlias(): KernelScratchRegion {
            return this.#requireRegion();
          }
          run(): void {
            this.#sameOwnerAlias().withLease((lease) => {
              const pointer = lease.exportPointer(1, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) => finding.enclosing.includes("ExactOwner")),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(false);
    expect(
      violations.some(
        (finding) =>
          finding.enclosing.includes("SameSpellingButUntrusted") &&
          finding.text.includes("#sameOwnerAlias().withLease"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("rejects returned and persistently stored scratch-address aliases", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchLease {
          address(offset: number, length: number): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type { KernelScratchRegion } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        let retained = 0;

        region.withLease((lease) => {
          const address = lease.address.bind(lease);
          const pointer = address(0, 8);
          const alias = pointer + 0;
          retained = alias;
          return alias;
        });
      `,
      },
      [scratchRegionSeed()],
    );

    expect(
      result.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text.includes("lease.address"),
      ),
    ).toBe(true);
  });

  it("rejects a lease retained by a deferred callback", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          copyFrom(source: Uint8Array, destinationOffset?: number): void;
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type { KernelScratchRegion } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        let deferred: () => void = () => {};

        region.withLease((lease) => {
          const pointer = lease.exportPointer(0, 8);
          deferred = () => {
            lease.copyFrom(new Uint8Array([1]), 0);
            lease.invokeKernelExport(
              "kernel_recv",
              [1, pointer, 8, 0],
            );
          };
        });
        deferred();
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) => finding.text.includes("lease.copyFrom")),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("lease.invokeKernelExport"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("admits only the exact private worker entry scratch invoker", () => {
    const scratchModule = `
      const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
        "kernel_recv",
      ] as const);
      export interface KernelScratchExportPointer {
        readonly opaque: unique symbol;
      }
      export interface KernelScratchLease {
        invokeKernelExport(
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number;
        invokeKernelExportScoped(
          scope: unknown,
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number;
      }
      export interface KernelScratchRegion {
        withLease<T>(operation: (lease: KernelScratchLease) => T): T;
      }
    `;
    const exactWorker = (extraStatement = "") => `
      import type {
        KernelScratchExportPointer,
        KernelScratchLease,
        KernelScratchRegion,
      } from "./kernel-scratch";
      interface Entry {
        readonly scope: unknown;
      }
      class CentralizedKernelWorker {
        #invokeEntryScratchExport(
          entry: Entry | undefined,
          lease: KernelScratchLease,
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number {
          ${extraStatement}
          return entry === undefined
            ? lease.invokeKernelExport(name, args)
            : lease.invokeKernelExportScoped(entry.scope, name, args);
        }
        run(region: KernelScratchRegion): void {
          region.withLease((lease) => {
            this.#invokeEntryScratchExport(
              undefined,
              lease,
              "kernel_recv",
              [],
            );
          });
        }
      }
    `;
    const seed = scratchRegionSeed(
      "host/src/kernel-worker.ts::CentralizedKernelWorker.run.$param:region",
    );

    const exact = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": exactWorker(),
      },
      [seed],
    );
    expect(
      exact.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);

    const bodyChanged = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": exactWorker("void lease;"),
      },
      [seed],
    );
    expect(
      bodyChanged.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text === "lease",
      ),
    ).toBe(true);

    const wrongFile = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/not-kernel-worker.ts": exactWorker(),
      },
      [
        scratchRegionSeed(
          "host/src/not-kernel-worker.ts::CentralizedKernelWorker.run.$param:region",
        ),
      ],
    );
    expect(
      wrongFile.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text === "lease",
      ),
    ).toBe(true);
  });

  it("proves the capacity dispatcher is one synchronous two-phase lease", () => {
    const scratchModule = `
      export interface KernelScratchExportPointer {
        readonly opaque: unique symbol;
      }
      export interface KernelScratchLease {
        copyFrom(source: Uint8Array, offset: number): void;
        copyOut(offset: number, length: number): Uint8Array;
        invokeKernelExport(
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number;
        invokeKernelExportScoped(
          scope: unknown,
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number;
      }
      export interface KernelScratchRegion {
        withLease<T>(operation: (lease: KernelScratchLease) => T): T;
      }
    `;
    const worker = (
      runBody: string,
      {
        conditionalReservedStage = false,
        conditionalReservedExport = false,
        conditionalCapacityStage = false,
        conditionalCapacityExport = false,
      }: {
        conditionalReservedStage?: boolean;
        conditionalReservedExport?: boolean;
        conditionalCapacityStage?: boolean;
        conditionalCapacityExport?: boolean;
      } = {},
    ) => `
      import type {
        KernelScratchExportPointer,
        KernelScratchLease,
        KernelScratchRegion,
      } from "./kernel-scratch";
      interface KernelWorkerEntryContext {
        readonly scope: unknown;
      }
      interface ChannelInfo {
        readonly pid: number;
      }
      class CentralizedKernelWorker {
        region!: KernelScratchRegion;
        #invokeEntryScratchExport(
          entry: KernelWorkerEntryContext | undefined,
          lease: KernelScratchLease,
          name: string,
          args: readonly (
            | number
            | bigint
            | KernelScratchExportPointer
          )[],
        ): number {
          return entry === undefined
            ? lease.invokeKernelExport(name, args)
            : lease.invokeKernelExportScoped(entry.scope, name, args);
        }
        #executeReservedChannelDispatch<T>(
          channel: ChannelInfo,
          totalCapacity: number,
          entry: KernelWorkerEntryContext,
          stage: (lease: KernelScratchLease) => void,
          finish: (lease: KernelScratchLease) => T,
          retryToken = 0n,
        ): { value: T | null; errno: number } {
          void channel;
          void totalCapacity;
          const value = this.region.withLease((lease) => {
            ${conditionalReservedStage ? "if (totalCapacity > 0) {" : ""}
            stage(lease);
            ${conditionalReservedStage ? "}" : ""}
            ${conditionalReservedExport ? "if (totalCapacity > 0) {" : ""}
            this.#invokeEntryScratchExport(
              entry,
              lease,
              "kernel_transfer_channel_execute",
              [retryToken],
            );
            ${conditionalReservedExport ? "}" : ""}
            return finish(lease);
          });
          return { value, errno: 0 };
        }
        #executeCapacityOwnedChannel<T>(
          channel: ChannelInfo,
          totalCapacity: number,
          entry: KernelWorkerEntryContext,
          stage: (lease: KernelScratchLease) => void,
          finish: (lease: KernelScratchLease) => T,
          retryToken = 0n,
        ): { value: T | null; errno: number } {
          if (totalCapacity > 64) {
            return this.#executeReservedChannelDispatch(
              channel,
              totalCapacity,
              entry,
              stage,
              finish,
              retryToken,
            );
          }
          const value = this.region.withLease((lease) => {
            ${conditionalCapacityStage ? "if (totalCapacity > 0) {" : ""}
            stage(lease);
            ${conditionalCapacityStage ? "}" : ""}
            ${conditionalCapacityExport ? "if (totalCapacity > 0) {" : ""}
            this.#invokeEntryScratchExport(
              entry,
              lease,
              "kernel_handle_channel",
              [retryToken],
            );
            ${conditionalCapacityExport ? "}" : ""}
            return finish(lease);
          });
          return { value, errno: 0 };
        }
        run(
          entry: KernelWorkerEntryContext,
          bytes: Uint8Array,
        ): void {
          const channel = { pid: 1 };
          ${runBody}
        }
      }
    `;
    const seed = scratchRegionSeed(
      "host/src/kernel-worker.ts::CentralizedKernelWorker.region",
    );
    const safe = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(`
        this.#executeCapacityOwnedChannel(
          channel,
          64,
          entry,
          (lease) => {
            lease.copyFrom(bytes, 0);
          },
          (lease) => lease.copyOut(0, bytes.length).byteLength,
          0n,
        );
      `),
      },
      [seed],
    );
    expect(
      safe.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);

    const safeRunBody = `
      this.#executeCapacityOwnedChannel(
        channel,
        64,
        entry,
        (lease) => {
          lease.copyFrom(bytes, 0);
        },
        (lease) => lease.copyOut(0, bytes.length).byteLength,
        0n,
      );
    `;
    for (const alteredWorker of [
      worker(safeRunBody, { conditionalReservedStage: true }),
      worker(safeRunBody, { conditionalReservedExport: true }),
      worker(safeRunBody, { conditionalCapacityStage: true }),
      worker(safeRunBody, { conditionalCapacityExport: true }),
    ]) {
      const conditional = auditVirtual(
        {
          "host/src/kernel-scratch.ts": scratchModule,
          "host/src/kernel-worker.ts": alteredWorker,
        },
        [seed],
      );
      expect(
        conditional.findings.some(
          (finding) => finding.kind === "scratch-address-contract",
        ),
      ).toBe(true);
    }

    const asyncStage = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(`
        this.#executeCapacityOwnedChannel(
          channel,
          64,
          entry,
          async (lease) => {
            lease.copyFrom(bytes, 0);
          },
          (lease) => lease.copyOut(0, 1).byteLength,
          0n,
        );
      `),
      },
      [seed],
    );
    expect(
      asyncStage.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text.includes("#executeCapacityOwnedChannel"),
      ),
    ).toBe(true);

    const omittedRetryToken = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(`
        this.#executeCapacityOwnedChannel(
          channel,
          64,
          entry,
          (lease) => {
            lease.copyFrom(bytes, 0);
          },
          (lease) => lease.copyOut(0, 1).byteLength,
        );
      `),
      },
      [seed],
    );
    expect(
      omittedRetryToken.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text.includes("#executeCapacityOwnedChannel"),
      ),
    ).toBe(true);

    const thenableCapture = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(`
        this.#executeCapacityOwnedChannel(
          channel,
          64,
          entry,
          (lease) => {
            lease.copyFrom(bytes, 0);
          },
          (lease) => Promise.resolve().then(
            () => lease.copyOut(0, 1).byteLength,
          ),
          0n,
        );
      `),
      },
      [seed],
    );
    expect(
      thenableCapture.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text.includes("lease.copyOut"),
      ),
    ).toBe(true);

    const retained = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(`
        let retainedLease: KernelScratchLease | undefined;
        this.#executeCapacityOwnedChannel(
          channel,
          64,
          entry,
          (lease) => {
            retainedLease = lease;
          },
          (lease) => lease.copyOut(0, 1).byteLength,
          0n,
        );
        void retainedLease;
      `),
      },
      [seed],
    );
    expect(
      retained.findings.some(
        (finding) =>
          finding.kind === "scratch-address-contract" &&
          finding.text === "lease",
      ),
    ).toBe(true);
  });

  it("proves reserved spawn keeps one token paired with one staged region", () => {
    const scratchModule = `
      const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
        "kernel_spawn_process",
      ] as const);
      export interface KernelScratchLease {
        copyFrom(
          source: Uint8Array,
          destinationOffset: number,
          sourceOffset: number,
          length: number,
        ): void;
      }
      export interface KernelScratchRegion {
        withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        revoke(): void;
      }
    `;
    const worker = ({
      token = "reservation.token",
      beforeLease = "",
      spawnBeforeCopy = false,
      conditionalCopy = false,
      conditionalCleanup = false,
    }: {
      token?: string;
      beforeLease?: string;
      spawnBeforeCopy?: boolean;
      conditionalCopy?: boolean;
      conditionalCleanup?: boolean;
    } = {}) => `
      import type {
        KernelScratchLease,
        KernelScratchRegion,
      } from "./kernel-scratch";
      declare function opaque(...values: unknown[]): void;
      interface KernelWorkerEntryContext {}
      interface ReservedSpawnScratch {
        readonly region: KernelScratchRegion | null;
        readonly token: bigint;
      }
      class CentralizedKernelWorker {
        instance!: WebAssembly.Instance;
        otherReservation!: ReservedSpawnScratch;
        #beginLargeSpawnScratch(
          _blobLen: number,
          _entry: KernelWorkerEntryContext,
        ): {
          reservation: ReservedSpawnScratch | null;
          errno: number;
        } {
          throw new Error("fixture");
        }
        #cancelLargeSpawnScratch(
          _token: bigint,
          _entry: KernelWorkerEntryContext,
        ): void {}
        #handleSpawnAfterResolve(
          parentPid: number,
          callerTid: number,
          blobBytes: Uint8Array,
          blobLen: number,
          entry: KernelWorkerEntryContext,
        ): number {
          const reservedSpawn = this.instance.exports
            .kernel_spawn_reserved_process as (
              parentPid: number,
              callerTid: number,
              token: bigint,
              length: number,
            ) => number;
          let reservation: ReservedSpawnScratch | null = null;
          let result = -1;
          try {
            const begun = this.#beginLargeSpawnScratch(blobLen, entry);
            reservation = begun.reservation;
            if (reservation?.region) {
              const activeRegion = reservation.region;
              const activeToken = ${token};
              ${beforeLease}
              result = activeRegion.withLease((scratch) => {
                ${
                  spawnBeforeCopy
                    ? `
                  const spawnResult = reservedSpawn(
                    parentPid,
                    callerTid,
                    activeToken,
                    blobLen,
                  );
                  scratch.copyFrom(blobBytes, 0, 0, blobLen);
                `
                    : `
                  ${conditionalCopy ? "if (blobLen > 1) {" : ""}
                  scratch.copyFrom(blobBytes, 0, 0, blobLen);
                  ${conditionalCopy ? "}" : ""}
                  const spawnResult = reservedSpawn(
                    parentPid,
                    callerTid,
                    activeToken,
                    blobLen,
                  );
                `
                }
                return spawnResult;
              });
            }
          } finally {
            if (reservation) {
              ${conditionalCleanup ? "if (blobLen > 1) {" : ""}
              reservation.region?.revoke();
              this.#cancelLargeSpawnScratch(reservation.token, entry);
              ${conditionalCleanup ? "}" : ""}
            }
          }
          return result;
        }
      }
    `;
    const audit = (workerSource: string) =>
      auditWasmMemoryWrites({
        ...virtualAuditOptions(
          {
            "host/src/kernel-scratch.ts": scratchModule,
            "host/src/kernel-worker.ts": workerSource,
          },
          [
            {
              declaration:
                "host/src/kernel-worker.ts::CentralizedKernelWorker.instance",
              target: "value",
              owner: "kernel",
              form: "instance",
              why: "This fixture field is the exact instantiated kernel module.",
            },
          ],
        ),
        kernelExportNames: [
          "kernel_spawn_process",
          "kernel_spawn_reserved_process",
        ],
      });
    const hasReservedSpawnBypass = (workerSource: string): boolean =>
      audit(workerSource).findings.some(
        (finding) =>
          finding.kind === "kernel-export-direct-use" &&
          finding.text.includes("reservedSpawn("),
      );

    expect(hasReservedSpawnBypass(worker())).toBe(false);
    expect(
      hasReservedSpawnBypass(
        worker({
          token: "this.otherReservation.token",
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          spawnBeforeCopy: true,
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          beforeLease: "opaque(activeRegion, activeToken);",
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          conditionalCopy: true,
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          conditionalCleanup: true,
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          beforeLease: "reservation = this.otherReservation;",
        }),
      ),
    ).toBe(true);
    expect(
      hasReservedSpawnBypass(
        worker({
          beforeLease: "opaque(reservation);",
        }),
      ),
    ).toBe(true);
  });

  it("proves the two private flattened-copy helpers retain no lease", () => {
    const scratchModule = `
      const KERNEL_SCRATCH_EXPORT_NAMES = Object.freeze([
        "kernel_recv",
      ] as const);
      export interface KernelScratchLease {
        invokeKernelExport(name: string, args: readonly unknown[]): number;
        copyFrom(
          source: Uint8Array,
          destinationOffset: number,
          sourceOffset: number,
          length: number,
        ): void;
        copyTo(
          destination: Uint8Array,
          sourceOffset: number,
          destinationOffset: number,
          length: number,
        ): void;
      }
      export interface KernelScratchRegion {
        withLease<T>(operation: (lease: KernelScratchLease) => T): T;
      }
    `;
    const worker = (extraInputStatement = "") => `
      import type {
        KernelScratchLease,
        KernelScratchRegion,
      } from "./kernel-scratch";
      class CentralizedKernelWorker {
        #copyFlattenedTransferInput(
          lease: KernelScratchLease,
          bytes: Uint8Array,
          count: number,
          offset: number,
        ): void {
          ${extraInputStatement}
          for (let index = 0; index < count; index++) {
            lease.copyFrom(bytes, offset + index, index, 1);
          }
        }
        #copyFlattenedTransferOutput(
          lease: KernelScratchLease,
          bytes: Uint8Array,
          count: number,
          offset: number,
          length: number,
        ): void {
          for (let index = 0; index < count && index < length; index++) {
            lease.copyTo(bytes, offset + index, index, 1);
          }
        }
        run(region: KernelScratchRegion, bytes: Uint8Array): void {
          region.withLease((lease) => {
            this.#copyFlattenedTransferInput(lease, bytes, 2, 0);
            this.#copyFlattenedTransferOutput(lease, bytes, 2, 0, 2);
          });
        }
      }
    `;
    const seed = scratchRegionSeed(
      "host/src/kernel-worker.ts::CentralizedKernelWorker.run.$param:region",
    );

    const exact = auditVirtual(
      {
        "host/src/kernel-scratch.ts": scratchModule,
        "host/src/kernel-worker.ts": worker(),
      },
      [seed],
    );
    expect(
      exact.findings.filter(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toEqual([]);

    for (const hiddenUse of [
      "void lease;",
      'eval("lease");',
      "void arguments[0];",
    ]) {
      const changed = auditVirtual(
        {
          "host/src/kernel-scratch.ts": scratchModule,
          "host/src/kernel-worker.ts": worker(hiddenUse),
        },
        [seed],
      );
      expect(
        changed.findings.some(
          (finding) =>
            finding.kind === "scratch-address-contract" &&
            finding.text === "lease",
        ),
        `${hiddenUse}\n${changed.findings.map(({ text }) => text).join("\n")}`,
      ).toBe(true);
    }
  });

  it("rejects a lease before it can cross an opaque helper boundary", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;

        function invokeLater(lease: KernelScratchLease): void {
          const pointer = lease.exportPointer(0, 8);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 8, 0],
          );
        }

        region.withLease((lease) => {
          invokeLater(lease);
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.some((finding) => finding.text === "lease")).toBe(true);
  });

  it("rejects an exact-typed lease without a genuine region origin", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
      `,
        "caller.ts": `
        import type { KernelScratchLease } from "./host/src/kernel-scratch";
        declare const forged: KernelScratchLease;
        const pointer = forged.exportPointer(0, 8);
        forged.invokeKernelExport(
          "kernel_recv",
          [1, pointer, 8, 0],
        );
      `,
      },
      [],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) =>
        finding.text.includes("forged.exportPointer"),
      ),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("forged.invokeKernelExport"),
      ),
    ).toBe(true);
  });

  it("rejects region and lease method extraction, reflection, and helpers", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        declare const key: keyof KernelScratchLease;
        declare function opaque(value: unknown): void;

        const boundLease = region.withLease.bind(region);
        const { withLease } = region;
        const reflectedRegion = Reflect.get(region, "withLease");
        void boundLease;
        void withLease;
        void reflectedRegion;

        region.withLease((lease) => {
          const method = lease.exportPointer;
          const { invokeKernelExport } = lease;
          const bound = lease.invokeKernelExport.bind(lease);
          const reflected = Reflect.get(lease, "exportPointer");
          void method;
          void invokeKernelExport;
          void bound;
          void reflected;
          lease[key];
          opaque(lease);
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    for (const snippet of [
      "region.withLease",
      "withLease",
      "lease.exportPointer",
      "invokeKernelExport",
      "lease[key]",
      "lease",
    ]) {
      expect(violations.some((finding) => finding.text.includes(snippet))).toBe(
        true,
      );
    }
  });

  it("rejects stored, returned, non-inline, and async leases", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        let retained: KernelScratchLease | undefined;
        const callback = (lease: KernelScratchLease): void => {
          retained = lease;
        };

        region.withLease(callback);
        region.withLease(async (lease) => {
          lease.exportPointer(0, 1);
        });
        region.withLease((lease) => {
          retained = lease;
          return lease;
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    for (const snippet of [
      "region.withLease(callback)",
      "region.withLease(async",
      "lease",
    ]) {
      expect(
        violations.some((finding) => finding.text.includes(snippet)),
        violations.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
  });

  it("rejects structurally erased and forged scratch leases", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly (
              | number
              | bigint
              | KernelScratchExportPointer
            )[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface ErasedLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        declare const region: KernelScratchRegion;

        region.withLease((lease) => {
          const erased: ErasedLease = lease;
          const pointer = erased.exportPointer(0, 8);
          erased.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 8, 0],
          );
        });

        const fake = {
          exportPointer: () => ({} as KernelScratchExportPointer),
          invokeKernelExport: () => 0,
        } as KernelScratchLease;
        const args = [
          "kernel_recv",
          [1, fake.exportPointer(0, 8), 8, 0],
        ] as const;
        fake.invokeKernelExport(...args);
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.some((finding) => finding.text === "lease")).toBe(true);
    expect(
      violations.some((finding) => finding.text.includes("fake.exportPointer")),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("fake.invokeKernelExport"),
      ),
    ).toBe(true);
  });

  it("rejects reintroducing or using a numeric scratch address member", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchLease {
          address(offset: number, length: number): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type { KernelScratchRegion } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        region.withLease((lease) => {
          lease.address(70, 1);
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) => finding.text.includes("address(offset")),
    ).toBe(true);
    expect(
      violations.some((finding) => finding.text.includes("lease.address")),
    ).toBe(true);
  });

  it("rejects replacement of a seeded scratch region with a structural fake", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          readonly capacity: number;
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
          revoke(): void;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class Kernel {
          scratchRegion!: KernelScratchRegion;
          run(fakeRegion: KernelScratchRegion): void {
            this.scratchRegion = fakeRegion;
            this.scratchRegion.withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.scratchRegion")],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) =>
        finding.text.includes("this.scratchRegion.withLease"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("rejects interposed and structurally forged seeded-field receivers", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class Kernel {
          region!: KernelScratchRegion;
          requireRegion(): KernelScratchRegion {
            return this.region;
          }
          run(fake: KernelScratchRegion): void {
            const proxy = new Proxy(this, {
              get(target, property, receiver) {
                if (property === "region") return fake;
                return Reflect.get(target, property, receiver);
              },
            });
            proxy.region.withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const holder: Kernel = { region: fake };
            holder.region.withLease((lease) => {
              const pointer = lease.exportPointer(1, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const castHolder = { region: fake } as Kernel;
            castHolder.region.withLease((lease) => {
              const pointer = lease.exportPointer(2, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const inherited = Object.create(this, {
              region: { value: fake },
            }) as Kernel;
            inherited.region.withLease((lease) => {
              const pointer = lease.exportPointer(3, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const cloned = structuredClone({ region: fake }) as Kernel;
            cloned.region.withLease((lease) => {
              const pointer = lease.exportPointer(4, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const proxyMethod = new Proxy(this, {
              get(target, property, receiver) {
                if (property === "requireRegion") return () => fake;
                return Reflect.get(target, property, receiver);
              },
            });
            proxyMethod.requireRegion().withLease((lease) => {
              const pointer = lease.exportPointer(5, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });

            const methodHolder = {
              region: fake,
              requireRegion: this.requireRegion,
            } as Kernel;
            methodHolder.requireRegion().withLease((lease) => {
              const pointer = lease.exportPointer(6, 1);
              lease.invokeKernelExport("kernel_recv", [1, pointer, 1, 0]);
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.region")],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    for (const receiver of [
      "proxy",
      "holder",
      "castHolder",
      "inherited",
      "cloned",
    ]) {
      expect(
        violations.some((finding) =>
          finding.text.includes(`${receiver}.region.withLease`),
        ),
        violations.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
    for (const receiver of ["proxyMethod", "methodHolder"]) {
      expect(
        violations.some((finding) =>
          finding.text.includes(`${receiver}.requireRegion().withLease`),
        ),
        violations.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
  });

  it("rejects immutable and reassigned structural erasure of a scratch lease", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface ErasedLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        declare const region: KernelScratchRegion;

        region.withLease((lease) => {
          const immutable: ErasedLease = lease;
          const first = immutable.exportPointer(1, 1);
          immutable.invokeKernelExport("kernel_recv", [1, first, 1, 0]);

          let reassigned: ErasedLease = lease;
          const second = reassigned.exportPointer(2, 2);
          reassigned.invokeKernelExport("kernel_recv", [1, second, 2, 0]);
          reassigned = {
            exportPointer: () => ({} as KernelScratchExportPointer),
            invokeKernelExport: () => 0,
          };

          const exact: KernelScratchLease = lease;
          const exactPointer = exact.exportPointer(3, 3);
          exact.invokeKernelExport(
            "kernel_recv",
            [1, exactPointer, 3, 0],
          );
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.some((finding) => finding.text.includes("lease"))).toBe(
      true,
    );
    expect(
      violations.some((finding) =>
        finding.text.includes("exact.exportPointer"),
      ),
    ).toBe(false);
    expect(
      violations.some((finding) =>
        finding.text.includes("exact.invokeKernelExport"),
      ),
    ).toBe(false);
  });

  it("rejects an inline unknown cast that erases a scratch lease receiver", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface ErasedLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        declare const region: KernelScratchRegion;

        region.withLease((lease) => {
          const pointer = (
            lease as unknown as ErasedLease
          ).exportPointer(4, 4);
          (lease as unknown as ErasedLease).invokeKernelExport(
            "kernel_recv",
            [1, pointer, 4, 0],
          );
        });
      `,
      },
      [scratchRegionSeed()],
    );

    expect(
      result.findings.some(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toBe(true);
  });

  it("rejects destructured lease methods from declarations and assignments", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        let reassigned!: KernelScratchLease["invokeKernelExport"];

        region.withLease((lease) => {
          const { invokeKernelExport: immutable } = lease;
          immutable.call(lease, "kernel_recv", []);

          ({ invokeKernelExport: reassigned } = lease);
          reassigned.call(lease, "kernel_recv", []);
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects Reflect.get and Reflect.apply lease-method extraction", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;

        region.withLease((lease) => {
          const immutable = Reflect.get(
            lease,
            "invokeKernelExport",
          ) as KernelScratchLease["invokeKernelExport"];
          Reflect.apply(immutable, lease, ["kernel_recv", []]);

          let reassigned = Reflect.get(
            lease,
            "exportPointer",
          ) as KernelScratchLease["exportPointer"];
          Reflect.apply(reassigned, lease, [8, 8]);
          reassigned = () => 0;
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects scratch leases passed through destructured helper parameters", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;

        function destructuredParameter(
          { invokeKernelExport }: KernelScratchLease,
          receiver: KernelScratchLease,
        ): number {
          return invokeKernelExport.call(
            receiver,
            "kernel_recv",
            [],
          );
        }

        region.withLease((lease) => {
          const immutable = destructuredParameter;
          immutable(lease, lease);

          let reassigned = destructuredParameter;
          reassigned(lease, lease);
          reassigned = () => 0;
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects structural erasure of the scratch region origin gate", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface ErasedLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        interface ErasedRegion {
          withLease<T>(operation: (lease: ErasedLease) => T): T;
        }
        declare const region: KernelScratchRegion;

        const erasedRegion: ErasedRegion = region;
        erasedRegion.withLease((lease) => {
          const pointer = lease.exportPointer(20, 1);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
        });
      `,
      },
      [scratchRegionSeed()],
    );

    expect(
      result.findings.some(
        (finding) => finding.kind === "scratch-address-contract",
      ),
    ).toBe(true);
  });

  it("rejects mutation and reflective interposition of scratch methods", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;

        region.withLease = () => {
          throw new Error("interposed");
        };
        Object.defineProperty(region, "withLease", {
          value: () => undefined,
        });
        Reflect.set(region, "withLease", () => undefined);

        region.withLease((lease) => {
          lease.invokeKernelExport = () => 0;
          Object.defineProperty(lease, "exportPointer", {
            value: () => ({} as KernelScratchExportPointer),
          });
          Reflect.set(lease, "invokeKernelExport", () => 0);
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.length).toBeGreaterThanOrEqual(6);
  });

  it("rejects function arguments and direct eval as hidden lease receivers", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchExportPointer,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        interface ErasedLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        declare const region: KernelScratchRegion;

        region.withLease(function (lease) {
          const hidden = arguments[0] as ErasedLease;
          const pointer = hidden.exportPointer(61, 1);
          hidden.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
          void lease;
        });
        region.withLease((lease) => {
          eval(
            'lease.invokeKernelExport("kernel_recv", [])',
          );
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a conditional that mixes a real region with a structural fake", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          readonly capacity: number;
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
          revoke(): void;
        }
        export function allocateKernelScratchRegion(): KernelScratchRegion {
          throw new Error("fixture");
        }
      `,
        "caller.ts": `
        import {
          allocateKernelScratchRegion,
          type KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const chooseFake: boolean;
        const real = allocateKernelScratchRegion();
        const fake = {} as KernelScratchRegion;
        const selected: KernelScratchRegion = chooseFake ? fake : real;
        selected.withLease((lease) => {
          const pointer = lease.exportPointer(0, 1);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
        });
      `,
      },
      [],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) => finding.text.includes("selected.withLease")),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("rejects mutable and container contamination of a real scratch region", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          readonly capacity: number;
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
          revoke(): void;
        }
        export function allocateKernelScratchRegion(): KernelScratchRegion {
          throw new Error("fixture");
        }
      `,
        "caller.ts": `
        import {
          allocateKernelScratchRegion,
          type KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const index: number;
        const real = allocateKernelScratchRegion();
        const fake = {} as KernelScratchRegion;

        let reassigned: KernelScratchRegion = real;
        reassigned = fake;
        reassigned.withLease((lease) => {
          const pointer = lease.exportPointer(1, 1);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
        });

        const regions: readonly KernelScratchRegion[] = [real, fake];
        regions[index].withLease((lease) => {
          const pointer = lease.exportPointer(2, 1);
          lease.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
        });
      `,
      },
      [],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    for (const receiver of ["reassigned", "regions[index]"]) {
      expect(
        violations.some((finding) =>
          finding.text.includes(`${receiver}.withLease`),
        ),
        violations.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
  });

  it("rejects mutable helper wrappers around a scratch lease", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchLease,
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        declare const region: KernelScratchRegion;
        let retained: KernelScratchLease | undefined;
        let wrapper = (lease: KernelScratchLease): KernelScratchLease => lease;
        wrapper = (lease) => {
          retained = lease;
          return lease;
        };

        region.withLease((lease) => {
          const escaped = wrapper(lease);
          const pointer = escaped.exportPointer(3, 1);
          escaped.invokeKernelExport(
            "kernel_recv",
            [1, pointer, 1, 0],
          );
        });
      `,
      },
      [scratchRegionSeed()],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) => finding.text === "lease"),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("escaped.exportPointer"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("rejects reflective replacement of seeded scratch authorities", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(
            offset: number,
            length: number,
          ): KernelScratchExportPointer;
          invokeKernelExport(
            name: string,
            args: readonly unknown[],
          ): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type {
          KernelScratchRegion,
        } from "./host/src/kernel-scratch";
        class Kernel {
          helperRegion!: KernelScratchRegion;
          region!: KernelScratchRegion;
          private requireHelperRegion(): KernelScratchRegion {
            return this.helperRegion;
          }
          run(fakeRegion: KernelScratchRegion): void {
            Object.defineProperty(this, "requireHelperRegion", {
              value: () => fakeRegion,
            });
            this.requireHelperRegion().withLease((lease) => {
              const pointer = lease.exportPointer(4, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
            Reflect.set(this, "region", fakeRegion);
            this.region.withLease((lease) => {
              const pointer = lease.exportPointer(5, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [
        scratchRegionSeed("caller.ts::Kernel.helperRegion"),
        scratchRegionSeed("caller.ts::Kernel.region"),
      ],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    expect(
      violations.some((finding) =>
        finding.text.includes("Object.defineProperty"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("this.requireHelperRegion().withLease"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
    expect(
      violations.some((finding) => finding.text.includes("Reflect.set")),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
    expect(
      violations.some((finding) =>
        finding.text.includes("this.region.withLease"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("rejects aliased, bracketed, and call-wrapped reflective replacement", () => {
    const result = auditVirtual(
      {
        "host/src/kernel-scratch.ts": `
        export interface KernelScratchExportPointer {
          readonly opaque: unique symbol;
        }
        export interface KernelScratchLease {
          exportPointer(offset: number, length: number): KernelScratchExportPointer;
          invokeKernelExport(name: string, args: readonly unknown[]): number;
        }
        export interface KernelScratchRegion {
          withLease<T>(operation: (lease: KernelScratchLease) => T): T;
        }
      `,
        "caller.ts": `
        import type { KernelScratchRegion } from "./host/src/kernel-scratch";
        class Kernel {
          region!: KernelScratchRegion;
          run(fake: KernelScratchRegion): void {
            const defineAlias = Object.defineProperty;
            defineAlias(this, "region", { value: fake });
            Object["defineProperty"](this, "region", { value: fake });
            Object.defineProperty.call(
              Object,
              this,
              "region",
              { value: fake },
            );
            Reflect["set"](this, "region", fake);
            const assignAlias = Object.assign;
            assignAlias(this, { region: fake });
            this.region.withLease((lease) => {
              const pointer = lease.exportPointer(0, 1);
              lease.invokeKernelExport(
                "kernel_recv",
                [1, pointer, 1, 0],
              );
            });
          }
        }
      `,
      },
      [scratchRegionSeed("caller.ts::Kernel.region")],
    );

    const violations = result.findings.filter(
      (finding) => finding.kind === "scratch-address-contract",
    );
    for (const call of [
      "defineAlias(",
      'Object["defineProperty"]',
      "Object.defineProperty.call",
      'Reflect["set"]',
      "assignAlias(",
    ]) {
      expect(
        violations.some((finding) => finding.text.includes(call)),
        violations.map((finding) => finding.text).join("\n"),
      ).toBe(true);
    }
    expect(
      violations.some((finding) =>
        finding.text.includes("this.region.withLease"),
      ),
      violations.map((finding) => finding.text).join("\n"),
    ).toBe(true);
  });

  it("discovers every JavaScript and TypeScript runtime extension", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kandelo-memory-audit-"));
    try {
      const runtime = path.join(root, "runtime");
      mkdirSync(runtime, { recursive: true });
      const expected = [
        "runtime/a.ts",
        "runtime/b.tsx",
        "runtime/c.mts",
        "runtime/d.cts",
        "runtime/e.js",
        "runtime/f.jsx",
        "runtime/g.mjs",
        "runtime/h.cjs",
      ];
      for (const relative of expected) {
        writeFileSync(path.join(root, relative), "export {};\n");
      }
      writeFileSync(path.join(runtime, "ignored.d.ts"), "export {};\n");
      writeFileSync(path.join(runtime, "ignored.d.mts"), "export {};\n");
      writeFileSync(path.join(runtime, "ignored.d.cts"), "export {};\n");
      writeFileSync(path.join(runtime, "ignored.test.js"), "export {};\n");
      writeFileSync(path.join(runtime, "ignored.spec.mjs"), "export {};\n");
      mkdirSync(path.join(root, "dist"), { recursive: true });
      writeFileSync(path.join(root, "dist", "ignored.js"), "export {};\n");
      mkdirSync(path.join(root, "nested-checkout", ".git"), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, "nested-checkout", "ignored.ts"),
        "export {};\n",
      );

      expect(
        repositoryRuntimeSourceFiles(root).map((file) =>
          path.relative(root, file).split(path.sep).join("/"),
        ),
      ).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
