import { describe, expect, it } from "vitest";
import {
  type ForkActivation,
  ForkActivations,
  type ForkActivationDriveSink,
} from "../src/fork-activations";

/**
 * The host's record of live activations: four fields and a drive bind.
 *
 * Everything this used to sit next to -- reference tables, GC transit, the
 * dirty-page journal, the guest save/restore wrappers -- is the module's. If a
 * test here starts asserting anything about those, the split has moved back.
 */

function recordingDrive(): { bound: number[]; sink: ForkActivationDriveSink } {
  const bound: number[] = [];
  return {
    bound,
    sink: { bindActivationDrive: (activationId) => void bound.push(activationId) },
  };
}

/** An activation with just enough shape to be registered. */
function activation(activationId: number, fixedPrefixSize = 32): ForkActivation {
  return {
    activationId,
    module: {} as WebAssembly.Module,
    instance: { exports: {} } as unknown as WebAssembly.Instance,
    fixedPrefixSize,
  };
}

describe("the host's record of live activations", () => {
  it("binds an activation's drive slots when it registers, not at capture", () => {
    // An unbound slot is a `call_indirect` on null inside the module, so it
    // surfaces as a trap mid-unwind rather than as a missing feature here.
    // Binding is a property of the instance, so it belongs at registration.
    const { bound, sink } = recordingDrive();
    const activations = new ForkActivations(sink, "test");
    activations.register(activation(0));
    activations.register(activation(3));
    expect(bound).toEqual([0, 3]);
  });

  it("refuses to register one activation twice", () => {
    // Two registrations for one id means two instances claim the same drive
    // slots, and the second bind silently wins -- the module would then drive
    // the wrong guest's unwind.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    activations.register(activation(1));
    expect(() => activations.register(activation(1))).toThrow(/already registered/);
  });

  it("refuses to forget an activation it does not have", () => {
    // The cleanup path calls this when a registration failed part way. An id it
    // does not know means the caller's idea of what registered disagrees with
    // this record, and silently succeeding leaves the disagreement in place.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    expect(() => activations.forget(2)).toThrow(/not registered/);
    activations.register(activation(2));
    expect(() => activations.forget(2)).not.toThrow();
  });

  it("orders activations by id rather than by when they registered", () => {
    // A dlopen races nothing, so a side activation can register before a
    // lower-numbered one. Capture drives them ascending and a child
    // instantiates them ascending, so insertion order is the wrong answer in
    // exactly the case that is hard to reproduce.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    activations.register(activation(5));
    activations.register(activation(0));
    activations.register(activation(2));
    expect(activations.ordered().map((a) => a.activationId)).toEqual([0, 2, 5]);
  });

  it("names every activation but 0 as a side, with its own prefix", () => {
    // Activation 0's prefix reaches the module through `fm_set_format`; the
    // sides carry theirs in this list. Including 0 here would add it twice, and
    // the module refuses a second add of an activation it already opened.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    activations.register(activation(0, 16));
    activations.register(activation(4, 48));
    activations.register(activation(1, 24));
    expect(activations.sides()).toEqual([
      { id: 1, fixedPrefix: 24 },
      { id: 4, fixedPrefix: 48 },
    ]);
  });
});
