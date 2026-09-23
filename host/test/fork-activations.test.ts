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

function recordingDrive(): {
  bound: number[];
  seeded: [number, Uint8Array][];
  sink: ForkActivationDriveSink;
} {
  const bound: number[] = [];
  const seeded: [number, Uint8Array][] = [];
  return {
    bound,
    seeded,
    sink: {
      bindActivationDrive: (activationId) => void bound.push(activationId),
      setActivationTemplateId: (activationId, templateId) =>
        void seeded.push([activationId, templateId]),
    },
  };
}

/** An activation with just enough shape to be registered. */
function activation(
  activationId: number,
  fixedPrefixSize = 32,
  exports: Record<string, unknown> = {},
): ForkActivation {
  return {
    activationId,
    instance: { exports } as unknown as WebAssembly.Instance,
    fixedPrefixSize,
    // Distinct per activation, so a test can tell whose id was seeded.
    templateId: new Uint8Array(32).fill(activationId),
  };
}

/** An activation whose bootstrap export records that it ran. */
function bootstrapping(activationId: number): {
  activation: ForkActivation;
  runs: () => number;
} {
  let runs = 0;
  return {
    activation: activation(activationId, 32, {
      wpk_fork_module_bootstrap: () => void (runs += 1),
    }),
    runs: () => runs,
  };
}

describe("the host's record of live activations", () => {
  it("seeds each activation's template id when it registers", () => {
    // Not incidental: the module writes one `Module` record per activation into
    // the capture arena and that record carries this id, so an activation that
    // registers without it makes `fm_parent_begin_capture` refuse with EINVAL.
    // Nothing called the seeding entry at all until the dlopen e2e ran.
    const { seeded, sink } = recordingDrive();
    const activations = new ForkActivations(sink, "test");
    activations.register(activation(0));
    activations.register(activation(4));
    expect(seeded.map(([id]) => id)).toEqual([0, 4]);
    expect(seeded[1]![1], "each activation's own id, not a shared buffer").toEqual(
      new Uint8Array(32).fill(4),
    );
  });

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

describe("running an activation's module-state bootstrap", () => {
  it("calls the guest export once", () => {
    const activations = new ForkActivations(recordingDrive().sink, "test");
    const { activation: a, runs } = bootstrapping(0);
    activations.register(a);
    activations.bootstrap(0);
    expect(runs()).toBe(1);
  });

  it("refuses a second bootstrap of one activation", () => {
    // Bootstrap converts the activation's active element segments, which is
    // destructive: a second run consumes segments the first already took and
    // leaves tables a child cannot rebuild.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    const { activation: a, runs } = bootstrapping(1);
    activations.register(a);
    activations.bootstrap(1);
    expect(() => activations.bootstrap(1)).toThrow(/bootstrapped twice/);
    expect(runs(), "and the guest was not called again").toBe(1);
  });

  it("lets a bootstrap that threw be retried", () => {
    // The registry's order, and the reason holds: a guest that trapped part way
    // has not consumed what it did not reach, so the run is not spent.
    const activations = new ForkActivations(recordingDrive().sink, "test");
    let calls = 0;
    activations.register(
      activation(2, 32, {
        wpk_fork_module_bootstrap: () => {
          calls += 1;
          if (calls === 1) throw new Error("guest trapped");
        },
      }),
    );
    expect(() => activations.bootstrap(2)).toThrow(/guest trapped/);
    expect(() => activations.bootstrap(2)).not.toThrow();
    expect(calls).toBe(2);
  });

  it("refuses an activation it does not have, and one with no such export", () => {
    const activations = new ForkActivations(recordingDrive().sink, "test");
    expect(() => activations.bootstrap(9)).toThrow(/not registered/);
    activations.register(activation(3));
    expect(() => activations.bootstrap(3)).toThrow(/exports no/);
  });
});
