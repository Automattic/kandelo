import { describe, expect, it, vi } from "vitest";

import {
  createKernelEntryGatedInstance,
  createKernelEntryScopedInstance,
  hasValidatedKernelEntryExport,
  isKernelExportFailure,
  invokeKernelEntrySerializedHostOperation,
  KernelEntryGate,
  KernelReentrantEntryError,
  validatedKernelEntryCallable,
} from "../src/kernel-entry-gate";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

function testInstance(
  pointerWidth: 4 | 8,
  gate: KernelEntryGate,
  implementations: Record<string, unknown>,
): {
  raw: WebAssembly.Instance;
  gated: WebAssembly.Instance;
} {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const raw = createKernelScratchTestInstance(
    pointerWidth,
    memory,
    () => implementations,
    () => pointerWidth === 8 ? 4096n : 4096,
  );
  return {
    raw,
    gated: createKernelEntryGatedInstance(raw, gate),
  };
}

describe("KernelEntryGate", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s hides mutable exports and rejects result-bearing reverse entry",
    (_name, pointerWidth) => {
      const gate = new KernelEntryGate();
      const nestedRaw = vi.fn(() => 0);
      let gated!: WebAssembly.Instance;
      const implementations: Record<string, unknown> = {
        kernel_handle_channel: vi.fn(() => {
          const nested = gated.exports.kernel_transfer_scratch_cancel as
            (token: bigint) => number;
          expect(() => nested(1n)).toThrow(KernelReentrantEntryError);
          return 0;
        }),
        kernel_transfer_scratch_cancel: nestedRaw,
      };
      const instance = testInstance(pointerWidth, gate, implementations);
      gated = instance.gated;

      expect(Object.isFrozen(gated.exports)).toBe(true);
      expect(gated.exports.memory).toBeUndefined();
      expect(gated).toBeInstanceOf(WebAssembly.Instance);
      expect(() => Reflect.apply(
        Object.getOwnPropertyDescriptor(
          WebAssembly.Instance.prototype,
          "exports",
        )!.get!,
        gated,
        [],
      )).toThrow();

      const handle = gated.exports.kernel_handle_channel as (
        pointer: number | bigint,
        capacity: number,
        pointerWidth: number,
        retryToken: bigint,
      ) => number;
      expect(handle(pointerWidth === 8 ? 0n : 0, 0, pointerWidth, 0n))
        .toBe(0);
      expect(nestedRaw).not.toHaveBeenCalled();
    },
  );

  it("binds one raw instance to exactly one gate generation", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const inner = vi.fn(() => 0);
    const raw = createKernelScratchTestInstance(
      4,
      memory,
      () => ({
        kernel_transfer_scratch_cancel: inner,
      }),
      () => 4096,
    );
    const gateA = new KernelEntryGate();
    const gateB = new KernelEntryGate();

    const first = createKernelEntryGatedInstance(raw, gateA);
    expect(createKernelEntryGatedInstance(raw, gateA)).toBe(first);
    expect(() => createKernelEntryGatedInstance(raw, gateB)).toThrow(
      /different kernel entry gate|already.*gate/i,
    );
    expect(inner).not.toHaveBeenCalled();

    const cancel = first.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;
    expect(cancel(1n)).toBe(0);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("rejects gate subclass and mutation-based dispatch overrides", () => {
    class SubclassedGate extends KernelEntryGate {}

    expect(() => new SubclassedGate()).toThrow(
      /subclass|exact KernelEntryGate/i,
    );

    const gate = new KernelEntryGate();
    const originalRun = KernelEntryGate.prototype.runOrDeferVoidIngress;
    const replacement = vi.fn(() => false);
    expect(Object.isFrozen(KernelEntryGate.prototype)).toBe(true);
    expect(Object.isFrozen(gate)).toBe(true);
    expect(Reflect.set(
      KernelEntryGate.prototype,
      "runOrDeferVoidIngress",
      replacement,
    )).toBe(false);
    expect(Reflect.defineProperty(
      KernelEntryGate.prototype,
      "runOrDeferVoidIngress",
      { value: replacement },
    )).toBe(false);
    expect(Reflect.defineProperty(
      gate,
      "runOrDeferVoidIngress",
      { value: replacement },
    )).toBe(false);
    expect(KernelEntryGate.prototype.runOrDeferVoidIngress).toBe(originalRun);
    expect(gate.runOrDeferVoidIngress("still guarded", () => {})).toBe(false);
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s drains void reverse entries once in FIFO order",
    async (_name, pointerWidth) => {
      const gate = new KernelEntryGate();
      const order: string[] = [];
      const dedupe = {};
      const implementations: Record<string, unknown> = {
        kernel_handle_channel: vi.fn(() => {
          expect(gate.runOrDeferVoidIngress(
            "first",
            () => {
              order.push("first");
            },
            dedupe,
          )).toBe(true);
          expect(gate.runOrDeferVoidIngress(
            "duplicate",
            () => {
              order.push("duplicate");
            },
            dedupe,
          )).toBe(true);
          expect(gate.runOrDeferVoidIngress(
            "second",
            () => {
              order.push("second");
            },
          )).toBe(true);
          expect(order).toEqual([]);
          return 0;
        }),
      };
      const { gated } = testInstance(pointerWidth, gate, implementations);
      const handle = gated.exports.kernel_handle_channel as (
        pointer: number | bigint,
        capacity: number,
        pointerWidth: number,
        retryToken: bigint,
      ) => number;

      expect(handle(pointerWidth === 8 ? 0n : 0, 0, pointerWidth, 0n))
        .toBe(0);
      expect(order).toEqual([]);
      await Promise.resolve();
      expect(order).toEqual(["first", "second"]);
    },
  );

  it("rejects immediate-only ingress without retaining its callback", async () => {
    const gate = new KernelEntryGate();
    const rejected = vi.fn();
    const order: string[] = [];

    gate.invokeKernelExport("outer", () => {
      expect(() => gate.runImmediateVoidIngress(
        "immediate-only test seam",
        rejected,
      )).toThrow(KernelReentrantEntryError);
      expect(gate.runOrDeferVoidIngress(
        "queued follower",
        () => {
          order.push("follower");
        },
      )).toBe(true);
    });

    expect(rejected).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    expect(order).toEqual(["follower"]);

    gate.runImmediateVoidIngress("later immediate ingress", () => {
      order.push("immediate");
    });
    expect(order).toEqual(["follower", "immediate"]);
  });

  it("rejects immediate-only ingress during a transaction start", async () => {
    const gate = new KernelEntryGate();
    const rejected = vi.fn();
    const observedRejection = vi.fn();

    expect(gate.runOrDeferVoidIngress(
      "transaction owner",
      (_scope, effects) => {
        effects.deferProtocolTransactionStart(() => {
          expect(() => gate.runImmediateVoidIngress(
            "transaction-start reentry",
            rejected,
          )).toThrow(KernelReentrantEntryError);
          observedRejection();
        });
      },
    )).toBe(false);

    await Promise.resolve();
    expect(observedRejection).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
  });

  it("keeps nested ingress behind work already queued after its parent", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];

    gate.invokeKernelExport("outer", () => {
      gate.runOrDeferVoidIngress("A", () => {
        order.push("A");
        gate.runOrDeferVoidIngress(
          "B",
          () => {
            order.push("B");
          },
        );
      });
      gate.runOrDeferVoidIngress("C", () => {
        order.push("C");
      });
    });
    await Promise.resolve();

    expect(order).toEqual(["A", "C", "B"]);
  });

  it("grants a selected generic callback no observer-stealable export authority", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];

    gate.invokeKernelExport("outer", () => {
      gate.runOrDeferVoidIngress("TCP listener registration", () => {
        order.push("observer");
        expect(() => gate.invokeKernelExport(
          "observer-stolen export",
          () => order.push("stolen"),
        )).toThrow(KernelReentrantEntryError);
      });
      gate.runOrDeferVoidIngress(
        "follower",
        () => {
          order.push("follower");
        },
      );
    });
    await Promise.resolve();

    expect(order).toEqual(["observer", "follower"]);
  });

  it("requires explicit scope for every export-bearing deferred callback", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: () => {
        order.push("allowed");
        return 0;
      },
    });
    const unscoped = gated.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;

    gate.invokeKernelExport("outer", () => {
      gate.runOrDeferVoidIngress("host-only", () => {
        order.push("host-only");
        expect(() => unscoped(1n)).toThrow(KernelReentrantEntryError);
      });
      gate.runOrDeferVoidIngress("scoped", (scope) => {
        order.push("scoped");
        const scoped = createKernelEntryScopedInstance(gated, scope);
        const cancel = scoped.exports.kernel_transfer_scratch_cancel as
          (token: bigint) => number;
        expect(cancel(1n)).toBe(0);
      });
      gate.runOrDeferVoidIngress(
        "follower",
        () => {
          order.push("follower");
        },
      );
    });
    await Promise.resolve();

    expect(order).toEqual([
      "host-only",
      "scoped",
      "allowed",
      "follower",
    ]);
  });

  it("keeps a reviewed synchronous void ingress across sequential exports", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const ingress = (label: string): void => {
      gate.runOrDeferVoidIngress(
        label,
        () => {
          order.push(label);
        },
      );
    };
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: (token: bigint) => {
        if (token === 1n) {
          order.push("first");
          ingress("nested");
        } else {
          order.push("second");
        }
        return 0;
      },
    });

    gate.invokeKernelExport("outer", () => {
      expect(gate.runOrDeferVoidIngress("chunked input", (scope) => {
        order.push("selected");
        const scoped = createKernelEntryScopedInstance(gated, scope);
        const cancel = scoped.exports.kernel_transfer_scratch_cancel as
          (token: bigint) => number;
        expect(cancel(1n)).toBe(0);
        expect(() => gate.invokeKernelExport(
          "callback-borrowed result export",
          () => order.push("stolen"),
        )).toThrow(KernelReentrantEntryError);
        expect(cancel(2n)).toBe(0);
      })).toBe(true);
      ingress("follower");
    });
    await Promise.resolve();

    expect(order).toEqual([
      "selected",
      "first",
      "second",
      "follower",
      "nested",
    ]);
  });

  it("keeps one synchronous host operation inside the exact entry lifetime", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    let invokeAfterRevocation!: () => number;

    expect(gate.runOrDeferVoidIngress(
      "MAP_SHARED transaction",
      (scope, effects) => {
        invokeAfterRevocation = () =>
          invokeKernelEntrySerializedHostOperation(scope, () => 11);
        const result = invokeKernelEntrySerializedHostOperation(
          scope,
          () => {
            order.push("host:start");
            expect(() => gate.invokeKernelExport(
              "host callback result ingress",
              () => order.push("stolen"),
            )).toThrow(KernelReentrantEntryError);
            expect(gate.runOrDeferVoidIngress(
              "host callback void ingress",
              () => {
                order.push("queued");
              },
            )).toBe(true);
            expect(() => invokeKernelEntrySerializedHostOperation(
              scope,
              () => 12,
            )).toThrow(KernelReentrantEntryError);
            expect(() => effects.deferProtocolEffect(
              () => undefined,
            )).toThrow(/effect registration is no longer active/);
            order.push("host:end");
            return 7;
          },
        );
        expect(result).toBe(7);
        order.push("commit");
      },
    )).toBe(false);

    expect(order).toEqual(["host:start", "host:end", "commit"]);
    expect(() => invokeAfterRevocation()).toThrow(/scope is no longer active/);
    await Promise.resolve();
    expect(order).toEqual(["host:start", "host:end", "commit", "queued"]);
  });

  it("serializes a host-only operation and releases ordinary backend errors", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const backendFailure = new Error("backend read failed");

    expect(() => gate.runSerializedHostOperation(
      "host-only MAP_SHARED read",
      () => {
        order.push("host:start");
        expect(gate.runOrDeferVoidIngress(
          "backend callback void ingress",
          () => {
            order.push("queued");
          },
        )).toBe(true);
        expect(() => gate.invokeKernelExport(
          "backend callback result ingress",
          () => order.push("stolen"),
        )).toThrow(KernelReentrantEntryError);
        expect(() => gate.runSerializedHostOperation(
          "nested host operation",
          () => 1,
        )).toThrow(KernelReentrantEntryError);
        order.push("host:error");
        throw backendFailure;
      },
    )).toThrow(backendFailure);

    expect(order).toEqual(["host:start", "host:error"]);
    expect(() => gate.runSerializedHostOperation(
      "overtaking host operation",
      () => 8,
    )).toThrow(KernelReentrantEntryError);
    await Promise.resolve();
    expect(order).toEqual(["host:start", "host:error", "queued"]);
    expect(gate.runSerializedHostOperation(
      "later host operation",
      () => 9,
    )).toBe(9);
    expect(gate.invokeKernelExport("later export", () => 12)).toBe(12);
  });

  it("fails closed when a serialized host operation crosses an async boundary", async () => {
    let gate!: KernelEntryGate;
    let invokeAfterRevocation!: () => number;
    const fatalScopeProbe = vi.fn();
    const onFatal = vi.fn(() => {
      expect(() => invokeAfterRevocation()).toThrow(
        /scope is no longer active/,
      );
      fatalScopeProbe();
    });
    gate = new KernelEntryGate(onFatal);
    const continuation = vi.fn();

    expect(() => gate.runOrDeferVoidIngress(
      "async MAP_SHARED transaction",
      (scope) => {
        invokeAfterRevocation = () =>
          invokeKernelEntrySerializedHostOperation(scope, () => 11);
        invokeKernelEntrySerializedHostOperation(
          scope,
          () => Promise.resolve().then(continuation),
        );
      },
    )).toThrow(/returned a Promise or thenable/);

    expect(onFatal).toHaveBeenCalledOnce();
    expect(fatalScopeProbe).toHaveBeenCalledOnce();
    expect(() => gate.invokeKernelExport("after async escape", () => 1))
      .toThrow(/returned a Promise or thenable/);
    await Promise.resolve();
    expect(continuation).toHaveBeenCalledOnce();
  });

  it("keeps thenable inspection inside the idle host-operation barrier", async () => {
    const onFatal = vi.fn();
    const gate = new KernelEntryGate(onFatal);
    const order: string[] = [];
    const thenable = {
      get then(): () => void {
        order.push("then:get");
        expect(gate.runOrDeferVoidIngress(
          "then getter reentry",
          () => {
            order.push("queued");
          },
        )).toBe(true);
        expect(() => gate.invokeKernelExport(
          "then getter result ingress",
          () => order.push("stolen"),
        )).toThrow(KernelReentrantEntryError);
        return () => undefined;
      },
    };

    expect(() => gate.runSerializedHostOperation(
      "host-only async result",
      () => thenable,
    )).toThrow(/returned a Promise or thenable/);
    expect(order).toEqual(["then:get"]);
    expect(onFatal).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(order).toEqual(["then:get"]);
  });

  it("rejects coercive export names before scoped or raw lookup", () => {
    const gate = new KernelEntryGate();
    const rawCancel = vi.fn(() => 0);
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: rawCancel,
    });
    const coerce = vi.fn(() => "kernel_transfer_scratch_cancel");
    const hostileName = { toString: coerce } as unknown as string;

    expect(() => hasValidatedKernelEntryExport(gated, hostileName))
      .toThrow(/primitive string/);
    expect(() => validatedKernelEntryCallable(gated, hostileName))
      .toThrow(/primitive string/);
    expect(coerce).not.toHaveBeenCalled();
    expect(rawCancel).not.toHaveBeenCalled();
  });

  it("returns only the persistent gated wrapper from callable validation", () => {
    const gate = new KernelEntryGate();
    const rawCancel = vi.fn(() => 0);
    const { raw, gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: rawCancel,
    });
    const binding = validatedKernelEntryCallable(
      gated,
      "kernel_transfer_scratch_cancel",
    )!;
    const persistent = gated.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;
    const rawCallable = raw.exports.kernel_transfer_scratch_cancel;

    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding.call).toBe(persistent);
    expect(binding.call).not.toBe(rawCallable);
    expect(binding.argumentCount).toBe(1);

    gate.runOrDeferVoidIngress("callable validation scope", (scope) => {
      const scoped = createKernelEntryScopedInstance(gated, scope);
      const scopedCallable = scoped.exports.kernel_transfer_scratch_cancel as
        (token: bigint) => number;
      expect(scopedCallable).not.toBe(binding.call);
      expect(() => Reflect.apply(binding.call, undefined, [1n]))
        .toThrow(KernelReentrantEntryError);
      expect(scopedCallable(1n)).toBe(0);
    });
    expect(rawCancel).toHaveBeenCalledOnce();
  });

  it("revokes immediate scope and keeps post reentry behind the whole host phase", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: () => {
        order.push("export");
        return 0;
      },
    });
    let extractedScoped!: (token: bigint) => number;

    expect(gate.runOrDeferVoidIngress(
      "immediate split phase",
      (scope, effects) => {
        order.push("scoped");
        const scoped = createKernelEntryScopedInstance(gated, scope);
        extractedScoped = scoped.exports.kernel_transfer_scratch_cancel as
          (token: bigint) => number;
        expect(extractedScoped(1n)).toBe(0);
        effects.deferObserverEffect(() => {
          order.push("post:first");
          expect(() => extractedScoped(2n)).toThrow(
            /scope is no longer active/,
          );
          const ordinary = gated.exports.kernel_transfer_scratch_cancel as
            (token: bigint) => number;
          expect(() => ordinary(3n)).toThrow(KernelReentrantEntryError);
          expect(gate.runOrDeferVoidIngress(
            "post reentry",
            (reentryScope) => {
              order.push("reentry");
              const reentryInstance = createKernelEntryScopedInstance(
                gated,
                reentryScope,
              );
              const cancel =
                reentryInstance.exports.kernel_transfer_scratch_cancel as
                  (token: bigint) => number;
              expect(cancel(4n)).toBe(0);
            },
          )).toBe(true);
          order.push("post:second");
        });
      },
    )).toBe(false);

    expect(order).toEqual([
      "scoped",
      "export",
      "post:first",
      "post:second",
    ]);
    await Promise.resolve();
    expect(order).toEqual([
      "scoped",
      "export",
      "post:first",
      "post:second",
      "reentry",
      "export",
    ]);
  });

  it("reports an immediate observer failure without poisoning the gate", () => {
    const gate = new KernelEntryGate();
    const failure = new Error("immediate observer failed");
    const after = vi.fn(() => 0);
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: after,
    });

    expect(() => gate.runOrDeferVoidIngress(
      "immediate observer",
      (_scope, effects) => {
        effects.deferObserverEffect(() => {
          throw failure;
        });
      },
    )).not.toThrow();

    const cancel = gated.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;
    expect(cancel(1n)).toBe(0);
    expect(after).toHaveBeenCalledOnce();
  });

  it("stops every later effect when an observer latches the gate fatal", () => {
    const gate = new KernelEntryGate();
    const fatal = new Error("observer requested kernel shutdown");
    const order: string[] = [];

    expect(gate.runOrDeferVoidIngress(
      "observer fatal latch",
      (_scope, effects) => {
        effects.deferObserverEffect(() => {
          order.push("observer");
          gate.fail(fatal);
        });
        effects.deferProtocolEffect(() => {
          order.push("protocol-after-fatal");
        });
        effects.deferObserverEffect(() => {
          order.push("observer-after-fatal");
        });
      },
    )).toBe(false);

    expect(order).toEqual(["observer"]);
    expect(() => gate.invokeKernelExport("after fatal", () => {}))
      .toThrow(fatal);
  });

  it("reports a trapped scoped export only after all entry authority is revoked", () => {
    let gate!: KernelEntryGate;
    let scopedCancel!: (token: bigint) => number;
    const queuedIngress = vi.fn();
    const rawReentry = vi.fn(() => 0);
    const onFatal = vi.fn((failure: Error) => {
      expect(() => scopedCancel(2n)).toThrow(/scope is no longer active/);
      expect(gate.runOrDeferVoidIngress(
        "fatal observer ingress",
        () => {
          queuedIngress();
        },
      )).toBe(true);
      expect(queuedIngress).not.toHaveBeenCalled();
      expect(() => gate.invokeKernelExport(
        "fatal observer export",
        rawReentry,
      )).toThrow(failure);
      expect(rawReentry).not.toHaveBeenCalled();
    });
    gate = new KernelEntryGate(onFatal);
    const rawTrap = new Error("synthetic scoped export trap");
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: () => {
        throw rawTrap;
      },
    });

    let trapped!: Error & { cause?: unknown };
    try {
      gate.runOrDeferVoidIngress(
        "scoped export trap",
        (scope) => {
          const scoped = createKernelEntryScopedInstance(gated, scope);
          scopedCancel = scoped.exports.kernel_transfer_scratch_cancel as
            (token: bigint) => number;
          scopedCancel(1n);
        },
      );
    } catch (error) {
      trapped = error as Error & { cause?: unknown };
    }

    expect(trapped.message).toBe(
      "kernel export kernel_transfer_scratch_cancel failed",
    );
    expect(trapped.cause).toBe(rawTrap);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledWith(trapped);
  });

  it("brands a trapped export inside its live scope and preserves the brand through rethrow", () => {
    const rawTrap = new Error("synthetic scoped export trap");
    const onFatal = vi.fn();
    const gate = new KernelEntryGate(onFatal);
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: () => {
        throw rawTrap;
      },
    });
    let caughtInScope!: Error & { cause?: unknown };
    let rethrown!: Error;

    try {
      gate.runOrDeferVoidIngress(
        "same-scope export catch",
        (scope) => {
          const scoped = createKernelEntryScopedInstance(gated, scope);
          const cancel = scoped.exports.kernel_transfer_scratch_cancel as
            (token: bigint) => number;
          try {
            cancel(1n);
          } catch (error) {
            expect(isKernelExportFailure(error)).toBe(true);
            expect(onFatal).not.toHaveBeenCalled();
            caughtInScope = error as Error & { cause?: unknown };
            try {
              throw error;
            } catch (sameError) {
              rethrown = sameError as Error;
              expect(isKernelExportFailure(sameError)).toBe(true);
            }
            throw error;
          }
        },
      );
    } catch (error) {
      expect(error).toBe(caughtInScope);
    }

    expect(rethrown).toBe(caughtInScope);
    expect(caughtInScope.cause).toBe(rawTrap);
    expect(isKernelExportFailure(caughtInScope)).toBe(true);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledWith(caughtInScope);
  });

  it("keeps the export-failure brand non-forgeable under mutable WeakSet hooks", () => {
    const gate = new KernelEntryGate();
    const rawTrap = new Error("raw export trap");
    let actual!: Error & { cause?: unknown };
    try {
      gate.invokeKernelExport("trapping export", () => {
        throw rawTrap;
      });
    } catch (error) {
      actual = error as Error & { cause?: unknown };
    }
    const sameFields = Object.assign(
      new Error(actual.message),
      { cause: actual.cause },
    );
    const inheritedFields = Object.create(actual) as Error;
    const primitiveValues: unknown[] = [
      undefined,
      null,
      false,
      0,
      "kernel export trapping export failed",
    ];

    expect(isKernelExportFailure(actual)).toBe(true);
    expect(isKernelExportFailure(sameFields)).toBe(false);
    expect(isKernelExportFailure(inheritedFields)).toBe(false);
    for (const value of primitiveValues) {
      expect(isKernelExportFailure(value)).toBe(false);
    }

    const hasSpy = vi
      .spyOn(WeakSet.prototype, "has")
      .mockImplementation(() => true);
    try {
      expect(isKernelExportFailure(actual)).toBe(true);
      expect(isKernelExportFailure(sameFields)).toBe(false);
      expect(hasSpy).not.toHaveBeenCalled();
    } finally {
      hasSpy.mockRestore();
    }
  });

  it("does not brand backend, reentry, or non-export gate failures", () => {
    const backendFailure = new Error("backend failure");
    const backendGate = new KernelEntryGate();
    let caughtBackend!: unknown;
    try {
      backendGate.runSerializedHostOperation("backend operation", () => {
        throw backendFailure;
      });
    } catch (error) {
      caughtBackend = error;
    }
    expect(caughtBackend).toBe(backendFailure);
    expect(isKernelExportFailure(caughtBackend)).toBe(false);

    let reentryFailure!: unknown;
    backendGate.invokeKernelExport("outer export", () => {
      try {
        backendGate.invokeKernelExport("nested export", () => undefined);
      } catch (error) {
        reentryFailure = error;
      }
    });
    expect(reentryFailure).toBeInstanceOf(KernelReentrantEntryError);
    expect(isKernelExportFailure(reentryFailure)).toBe(false);

    const invalidIngressGate = new KernelEntryGate();
    let invalidIngressFailure!: unknown;
    try {
      invalidIngressGate.runOrDeferVoidIngress(
        "invalid non-export ingress",
        (() => 1) as unknown as () => undefined,
      );
    } catch (error) {
      invalidIngressFailure = error;
    }
    expect(invalidIngressFailure).toBeInstanceOf(Error);
    expect(isKernelExportFailure(invalidIngressFailure)).toBe(false);
    expect(isKernelExportFailure(new Error("ordinary failure"))).toBe(false);
  });

  it("drains reentry queued by a failing immediate observer", async () => {
    const gate = new KernelEntryGate();
    const failure = new Error("observer failed after reentry");
    const order: string[] = [];

    expect(() => gate.runOrDeferVoidIngress(
      "throwing immediate observer",
      (_scope, effects) => {
        effects.deferObserverEffect(() => {
          expect(gate.runOrDeferVoidIngress(
            "queued before throw",
            () => {
              order.push("queued");
            },
          )).toBe(true);
          throw failure;
        });
      },
    )).not.toThrow();

    expect(() => gate.invokeKernelExport(
      "overtaking export",
      () => order.push("overtook"),
    )).toThrow(KernelReentrantEntryError);
    expect(order).toEqual([]);
    await Promise.resolve();
    expect(order).toEqual(["queued"]);
    expect(() => gate.invokeKernelExport(
      "after drain",
      () => order.push("after"),
    )).not.toThrow();
    expect(order).toEqual(["queued", "after"]);
  });

  it("keeps detached reentry behind followers and lends it no drain authority", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const rawCancel = vi.fn(() => {
      order.push("export");
      return 0;
    });
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: rawCancel,
    });
    const ordinary = gated.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;
    let extractedScoped!: (token: bigint) => number;

    gate.invokeKernelExport("outer", () => {
      gate.runOrDeferVoidIngress(
        "split phase",
        (scope, effects) => {
          order.push("scoped");
          const scoped = createKernelEntryScopedInstance(gated, scope);
          extractedScoped = scoped.exports.kernel_transfer_scratch_cancel as
            (token: bigint) => number;
          expect(extractedScoped(1n)).toBe(0);
          effects.deferObserverEffect(() => {
            order.push("post");
            expect(() => extractedScoped(2n)).toThrow(
              /scope is no longer active/,
            );
            expect(() => ordinary(3n)).toThrow(KernelReentrantEntryError);
            expect(gate.runOrDeferVoidIngress(
              "post reentry",
              (reentryScope) => {
                order.push("reentry");
                const reentryInstance = createKernelEntryScopedInstance(
                  gated,
                  reentryScope,
                );
                const cancel =
                  reentryInstance.exports.kernel_transfer_scratch_cancel as
                    (token: bigint) => number;
                expect(cancel(4n)).toBe(0);
              },
            )).toBe(true);
          });
        },
      );
      gate.runOrDeferVoidIngress(
        "follower",
        () => {
          order.push("follower");
        },
      );
    });
    await Promise.resolve();

    expect(order).toEqual([
      "scoped",
      "export",
      "post",
      "follower",
      "reentry",
      "export",
    ]);
    expect(rawCancel).toHaveBeenCalledTimes(2);
  });

  it("revokes transaction scope and admits only a fresh public ingress", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];
    const rawCancel = vi.fn((token: bigint) => {
      order.push(`export:${token}`);
      return 0;
    });
    const { gated } = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: rawCancel,
    });
    const ordinary = gated.exports.kernel_transfer_scratch_cancel as
      (token: bigint) => number;
    let extractedScoped!: (token: bigint) => number;

    expect(gate.runOrDeferVoidIngress(
      "transaction owner",
      (scope, effects) => {
        order.push("scope");
        const scoped = createKernelEntryScopedInstance(gated, scope);
        extractedScoped = scoped.exports.kernel_transfer_scratch_cancel as
          (token: bigint) => number;
        effects.deferProtocolTransactionStart(() => {
          order.push("transaction");
          // WHY: the transaction can outlive the selected kernel scratch
          // bytes. Neither its revoked scope nor the ordinary façade grants
          // ambient Wasm authority after this asynchronous boundary.
          expect(() => extractedScoped(1n)).toThrow(
            /scope is no longer active/,
          );
          expect(() => ordinary(2n)).toThrow(KernelReentrantEntryError);
          expect(gate.runOrDeferVoidIngress(
            "fresh transaction ingress",
            (freshScope) => {
              order.push("fresh");
              const fresh = createKernelEntryScopedInstance(
                gated,
                freshScope,
              );
              const cancel =
                fresh.exports.kernel_transfer_scratch_cancel as
                  (token: bigint) => number;
              expect(cancel(3n)).toBe(0);
            },
          )).toBe(false);
        });
      },
    )).toBe(false);
    expect(order).toEqual(["scope"]);

    await Promise.resolve();
    expect(order).toEqual([
      "scope",
      "transaction",
      "fresh",
      "export:3",
    ]);
    expect(rawCancel).toHaveBeenCalledOnce();
  });

  it("queues roots opened by a transaction-start root's detached effects", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];

    expect(gate.runOrDeferVoidIngress(
      "transaction owner",
      (_scope, effects) => {
        order.push("scope");
        effects.deferProtocolTransactionStart(() => {
          order.push("transaction");
          expect(gate.runOrDeferVoidIngress(
            "fresh transaction ingress",
            (_freshScope, freshEffects) => {
              order.push("fresh");
              freshEffects.deferProtocolEffect(() => {
                order.push("effect");
                // WHY: this effect is detached from its fresh entry, but the
                // surrounding transaction start has not returned yet. A
                // second root must join the FIFO instead of nesting detached
                // publication and poisoning the kernel generation.
                expect(gate.runOrDeferVoidIngress(
                  "effect follower",
                  () => {
                    order.push("follower");
                  },
                )).toBe(true);
              });
            },
          )).toBe(false);
        });
      },
    )).toBe(false);
    expect(order).toEqual(["scope"]);

    await Promise.resolve();
    expect(order).toEqual([
      "scope",
      "transaction",
      "fresh",
      "effect",
    ]);
    await Promise.resolve();
    expect(order).toEqual([
      "scope",
      "transaction",
      "fresh",
      "effect",
      "follower",
    ]);
  });

  it("keeps an unrelated ingress behind a pending transaction start", async () => {
    const gate = new KernelEntryGate();
    const order: string[] = [];

    expect(gate.runOrDeferVoidIngress(
      "transaction owner",
      (_scope, effects) => {
        order.push("scope");
        effects.deferProtocolTransactionStart(() => {
          order.push("transaction");
        });
      },
    )).toBe(false);
    expect(gate.runOrDeferVoidIngress(
      "unrelated follower",
      () => {
        order.push("follower");
      },
    )).toBe(true);
    expect(order).toEqual(["scope"]);

    await Promise.resolve();
    expect(order).toEqual(["scope", "transaction"]);
    await Promise.resolve();
    expect(order).toEqual(["scope", "transaction", "follower"]);
  });

  it("uses its captured microtask scheduler for transaction starts", async () => {
    vi.resetModules();
    const {
      createKernelEntryGatedInstance: createFreshGatedInstance,
      KernelEntryGate: FreshKernelEntryGate,
    } = await import("../src/kernel-entry-gate");
    const originalQueueMicrotask = globalThis.queueMicrotask;
    const replacement = vi.fn((_callback: VoidFunction) => undefined);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
    const raw = createKernelScratchTestInstance(
      4,
      memory,
      () => ({}),
      () => 4096,
    );
    const gate = new FreshKernelEntryGate();
    createFreshGatedInstance(raw, gate);
    const started = vi.fn();

    try {
      globalThis.queueMicrotask = replacement;
      expect(gate.runOrDeferVoidIngress(
        "captured scheduler transaction",
        (_scope, effects) => {
          effects.deferProtocolTransactionStart(() => {
            started();
          });
        },
      )).toBe(false);
    } finally {
      globalThis.queueMicrotask = originalQueueMicrotask;
    }

    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("transaction start threw");
      },
      "transaction start threw",
    ],
    [
      "returns a value",
      (() => 1) as unknown as () => undefined,
      "returned a value",
    ],
  ] as const)(
    "poisons the gate, reports, and discards followers when a transaction start %s",
    async (_description, transactionStart, causeMessage) => {
      const onFatal = vi.fn();
      const gate = new KernelEntryGate(onFatal);
      const follower = vi.fn();

      expect(gate.runOrDeferVoidIngress(
        "invalid transaction",
        (_scope, effects) => {
          effects.deferProtocolTransactionStart(transactionStart);
        },
      )).toBe(false);
      expect(gate.runOrDeferVoidIngress(
        "must be discarded",
        () => {
          follower();
        },
      )).toBe(true);
      expect(onFatal).not.toHaveBeenCalled();

      await Promise.resolve();
      expect(onFatal).toHaveBeenCalledOnce();
      const [failure] = onFatal.mock.calls[0] as [Error & { cause?: unknown }];
      expect(failure.message).toBe(
        "protocol transaction start 0 for invalid transaction failed",
      );
      expect((failure.cause as Error).message).toContain(causeMessage);
      expect(follower).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(follower).not.toHaveBeenCalled();
      expect(() => gate.invokeKernelExport(
        "after invalid transaction",
        () => undefined,
      )).toThrow(failure);
    },
  );

  it("reports a deferred detached failure without poisoning or dropping followers", async () => {
    vi.resetModules();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    // Import after installing the spy because the authority boundary captures
    // reporting intrinsics before any untrusted kernel callback can replace
    // them.
    const { KernelEntryGate: FreshKernelEntryGate } = await import(
      "../src/kernel-entry-gate"
    );
    const gate = new FreshKernelEntryGate();
    const order: string[] = [];
    const failure = new Error("deferred observer failed");

    gate.invokeKernelExport("outer", () => {
      gate.runOrDeferVoidIngress(
        "deferred observer",
        (_scope, effects) => {
          order.push("scoped");
          effects.deferObserverEffect(() => {
            order.push("post");
            throw failure;
          });
        },
      );
      gate.runOrDeferVoidIngress(
        "follower",
        () => {
          order.push("follower");
        },
      );
    });
    await Promise.resolve();

    expect(order).toEqual(["scoped", "post", "follower"]);
    expect(report).toHaveBeenCalledWith(
      "[kernel-entry-gate] detached host phase failed for deferred observer",
      failure,
    );
    const after = vi.fn();
    gate.invokeKernelExport("after detached failure", after);
    expect(after).toHaveBeenCalledOnce();
    report.mockRestore();
  });

  it("binds scoped exports only to a registered gated instance", () => {
    const gate = new KernelEntryGate();
    const rawCancel = vi.fn(() => 0);
    const instance = testInstance(4, gate, {
      kernel_transfer_scratch_cancel: rawCancel,
    });

    expect(gate.runOrDeferVoidIngress("scoped façade", (scope) => {
      expect(() => createKernelEntryScopedInstance(instance.raw, scope))
        .toThrow(/requires a registered gated instance/);
      const scoped = createKernelEntryScopedInstance(instance.gated, scope);
      const scopedExports = scoped.exports as Record<string, unknown>;
      const injected = vi.fn(() => 0);
      expect(Reflect.set(
        scopedExports,
        "kernel_transfer_scratch_cancel",
        injected,
      )).toBe(false);
      expect(Reflect.defineProperty(
        scopedExports,
        "kernel_transfer_scratch_cancel",
        { value: injected },
      )).toBe(false);
      expect(Reflect.setPrototypeOf(scopedExports, { injected })).toBe(false);
      expect(Reflect.preventExtensions(scopedExports)).toBe(true);
      const cancel = scoped.exports.kernel_transfer_scratch_cancel as
        (token: bigint) => number;
      expect(Reflect.deleteProperty(
        scopedExports,
        "kernel_transfer_scratch_cancel",
      )).toBe(true);
      expect(Reflect.set(
        scopedExports,
        "kernel_transfer_scratch_cancel",
        injected,
      )).toBe(false);
      expect(Reflect.defineProperty(
        scopedExports,
        "kernel_transfer_scratch_cancel",
        { value: injected },
      )).toBe(false);
      expect(cancel(1n)).toBe(0);
      expect(injected).not.toHaveBeenCalled();
      expect(rawCancel).toHaveBeenCalledOnce();
    })).toBe(false);
  });

  it("rejects a scope from another gate before either export executes", () => {
    const gateA = new KernelEntryGate();
    const gateB = new KernelEntryGate();
    const gateBExport = vi.fn(() => 0);
    const { gated: gatedB } = testInstance(4, gateB, {
      kernel_transfer_scratch_cancel: gateBExport,
    });

    expect(gateA.runOrDeferVoidIngress("gate A", (scopeA) => {
      expect(() => createKernelEntryScopedInstance(gatedB, scopeA))
        .toThrow(/does not own the supplied scope/);
    })).toBe(false);
    expect(gateBExport).not.toHaveBeenCalled();
  });

  it.each([
    ["a result", () => 1],
    ["a Promise", () => Promise.resolve()],
  ] as const)(
    "poisons the gate when void ingress returns %s",
    (_description, operation) => {
      const onFatal = vi.fn();
      const gate = new KernelEntryGate(onFatal);

      let failure!: Error & { cause?: unknown };
      try {
        gate.runOrDeferVoidIngress(
          "invalid void operation",
          operation,
        );
      } catch (error) {
        failure = error as Error & { cause?: unknown };
      }

      expect(failure.message).toBe(
        "void kernel ingress invalid void operation failed",
      );
      expect((failure.cause as Error).message).toBe(
        "void kernel ingress invalid void operation must return undefined synchronously",
      );
      expect(onFatal).toHaveBeenCalledOnce();
      expect(onFatal).toHaveBeenCalledWith(failure);
      expect(() => gate.invokeKernelExport("after failure", () => {}))
        .toThrow(failure);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s keeps queued ingress ahead of pre-existing Promise callbacks",
    async (_name, pointerWidth) => {
      const gate = new KernelEntryGate();
      const order: string[] = [];
      const laterRaw = vi.fn(() => 0);
      let gated!: WebAssembly.Instance;
      const implementations: Record<string, unknown> = {
        kernel_handle_channel: vi.fn(() => {
          expect(gate.runOrDeferVoidIngress(
            "first arrival",
            () => {
              order.push("first");
              const later = gated.exports.kernel_transfer_scratch_cancel as
                (token: bigint) => number;
              expect(() => later(1n)).toThrow(KernelReentrantEntryError);
            },
          )).toBe(true);
          return 0;
        }),
        kernel_transfer_scratch_cancel: laterRaw,
      };
      const instance = testInstance(pointerWidth, gate, implementations);
      gated = instance.gated;
      const handle = gated.exports.kernel_handle_channel as (
        pointer: number | bigint,
        capacity: number,
        width: number,
        retryToken: bigint,
      ) => number;
      const later = gated.exports.kernel_transfer_scratch_cancel as
        (token: bigint) => number;

      // Queue this callback before the outer export queues the gate's drain.
      // Its ingress still arrived after "first" and may not overtake it.
      const preExistingPromise = Promise.resolve().then(() => {
        expect(gate.runOrDeferVoidIngress(
          "second arrival",
          () => {
            order.push("second");
          },
        )).toBe(true);
        expect(() => later(2n)).toThrow(KernelReentrantEntryError);
      });

      expect(handle(
        pointerWidth === 8 ? 0n : 0,
        0,
        pointerWidth,
        0n,
      )).toBe(0);
      expect(() => later(3n)).toThrow(KernelReentrantEntryError);
      expect(order).toEqual([]);

      await preExistingPromise;
      await Promise.resolve();
      expect(order).toEqual(["first", "second"]);
      // Generic FIFO callbacks and both overtaking attempts have zero export
      // authority. Only the later call after the queue is empty reaches Wasm.
      expect(laterRaw).not.toHaveBeenCalled();
      expect(later(4n)).toBe(0);
      expect(laterRaw).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s poisons the generation when an export unwinds exceptionally",
    async (_name, pointerWidth) => {
      const fatal = new Error("synthetic kernel export trap");
      const onFatal = vi.fn();
      const gate = new KernelEntryGate(onFatal);
      const deferred = vi.fn();
      const implementations: Record<string, unknown> = {
        kernel_handle_channel: vi.fn(() => {
          expect(gate.runOrDeferVoidIngress(
            "must not run after trap",
            () => {
              deferred();
            },
          )).toBe(true);
          throw fatal;
        }),
      };
      const { gated } = testInstance(pointerWidth, gate, implementations);
      const handle = gated.exports.kernel_handle_channel as (
        pointer: number | bigint,
        capacity: number,
        width: number,
        retryToken: bigint,
      ) => number;

      let trapped!: Error & { cause?: unknown };
      try {
        handle(
          pointerWidth === 8 ? 0n : 0,
          0,
          pointerWidth,
          0n,
        );
      } catch (error) {
        trapped = error as Error & { cause?: unknown };
      }
      expect(trapped).toBeInstanceOf(Error);
      expect(trapped.message).toBe(
        "kernel export kernel_handle_channel failed",
      );
      expect(trapped.cause).toBe(fatal);
      expect(onFatal).toHaveBeenCalledOnce();
      expect(onFatal).toHaveBeenCalledWith(trapped);
      await Promise.resolve();
      expect(deferred).not.toHaveBeenCalled();
      expect(() => handle(
        pointerWidth === 8 ? 0n : 0,
        0,
        pointerWidth,
        0n,
      )).toThrow(trapped);
      expect(onFatal).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s discards deferred work after a fatal latch",
    async (_name, pointerWidth) => {
      const gate = new KernelEntryGate();
      const deferred = vi.fn();
      const fatal = new Error("synthetic fatal kernel state");
      const implementations: Record<string, unknown> = {
        kernel_transfer_io_execute: vi.fn(() => {
          expect(gate.runOrDeferVoidIngress(
            "must be discarded",
            () => {
              deferred();
            },
          )).toBe(true);
          gate.fail(fatal);
          return 0;
        }),
      };
      const { gated } = testInstance(pointerWidth, gate, implementations);
      const execute = gated.exports.kernel_transfer_io_execute as (
        pid: number,
        tid: number,
        token: bigint,
        length: number | bigint,
        syscall: number,
        fd: number,
        offset: bigint,
        retryToken: bigint,
      ) => number;

      expect(execute(
        1,
        1,
        1n,
        pointerWidth === 8 ? 0n : 0,
        0,
        0,
        0n,
        0n,
      )).toBe(0);
      await Promise.resolve();
      expect(deferred).not.toHaveBeenCalled();
      expect(() => execute(
        1,
        1,
        1n,
        pointerWidth === 8 ? 0n : 0,
        0,
        0,
        0n,
        0n,
      )).toThrow(fatal);
    },
  );
});
