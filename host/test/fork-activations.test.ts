import { describe, expect, it } from "vitest";
import {
  type ForkActivation,
  type ForkActivationRow,
  ForkActivations,
  type ForkActivationDriveSink,
} from "../src/fork-activations";

/**
 * The host's record of live activations: two fields and what it does with the
 * module's `fm_bind_activation` row.
 *
 * Everything this used to sit next to -- reference tables, GC transit, the
 * dirty-page journal, the guest save/restore wrappers -- is the module's. If a
 * test here starts asserting anything about those, the split has moved back.
 */

/** A stand-in row: distinct, recognisable bases per activation. */
function rowFor(activationId: number, resumeCount = 0): ForkActivationRow {
  return {
    driveBase: activationId * 19,
    funcCatalogBase: activationId * 10,
    staticRootBase: activationId * 100,
    resume: { ptr: 4096 + activationId, count: resumeCount },
  };
}

function recordingDrive(): {
  asked: [number, number, number][];
  bound: [number, number][];
  sink: ForkActivationDriveSink;
} {
  const asked: [number, number, number][] = [];
  const bound: [number, number][] = [];
  return {
    asked,
    bound,
    sink: {
      bindActivation: (activationId, funcLength, staticLength) => {
        asked.push([activationId, funcLength, staticLength]);
        return rowFor(activationId);
      },
      bindActivationDrive: (activationId, base) => void bound.push([activationId, base]),
      releaseResumeSlots: () => 0,
    },
  };
}

/**
 * An activation with just enough shape to be registered: the two catalog
 * tables every instrumented guest exports, and a placement shim over an empty
 * resume catalog.
 */
function activation(
  activationId: number,
  exports: Record<string, unknown> = {},
  placed: [number, number][] = [],
): ForkActivation {
  return {
    activationId,
    instance: {
      exports: {
        __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 2 }),
        __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 3 }),
        __wpk_fork_resume_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
        __wpk_fork_place_resume_thunks: (ptr: number, count: number) =>
          (placed.push([ptr, count]), count),
        ...exports,
      },
    } as unknown as WebAssembly.Instance,
  };
}

/** An activation whose bootstrap export records that it ran. */
function bootstrapping(activationId: number): {
  activation: ForkActivation;
  runs: () => number;
} {
  let runs = 0;
  return {
    activation: activation(activationId, {
      wpk_fork_module_bootstrap: () => void (runs += 1),
    }),
    runs: () => runs,
  };
}

describe("the host's record of live activations", () => {
  it("binds each activation with its catalog lengths and acts on the row", () => {
    // The module places the activation and answers one row; the host's part is
    // the reference-typed work: the drive bind at the drive base and the
    // guest's own resume placement from the row's pointer and count. An
    // unbound slot is a `call_indirect` on null inside the module, so it
    // surfaces as a trap mid-unwind -- which is why this is registration's job
    // rather than capture's.
    const { asked, bound, sink } = recordingDrive();
    const activations = new ForkActivations(sink, "test");
    const placed: [number, number][] = [];
    activations.register(activation(0, {}, placed));
    activations.register(activation(3, {}, placed));
    expect(asked).toEqual([[0, 2, 3], [3, 2, 3]]);
    expect(bound).toEqual([[0, 0], [3, 57]]);
    expect(placed).toEqual([[4096, 0], [4099, 0]]);
    expect(activations.ordered().map((a) => a.staticRootBase)).toEqual([0, 300]);
  });

  it("refuses a guest whose resume catalog disagrees with the module's count", () => {
    // The admitted catalog and the instantiated guest are one artifact or they
    // are not: a guest with MORE thunks than the module assigned would place a
    // prefix and leave the rest at no slot, silently.
    const { sink } = recordingDrive();
    sink.bindActivation = (id) => rowFor(id, 5);
    const activations = new ForkActivations(sink, "test");
    expect(() => activations.register(activation(1))).toThrow(/not the same artifact/);
  });

  it("publishes the catalogs at the bases the module placed", () => {
    const calls: string[] = [];
    const activations = new ForkActivations(recordingDrive().sink, "test", {
      registerCatalog: (base, table) => void calls.push(`functions ${base}+${table.length}`),
      registerStaticRoots: (base, table) => void calls.push(`roots ${base}+${table.length}`),
    });
    activations.register(activation(2, { __wpk_fork_static_root_harvest: () => void calls.push("harvest") }));
    expect(calls).toEqual(["harvest", "functions 20+2", "roots 200+3"]);
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

  it("forgets through the module alone, so the id can come back", () => {
    // `dlopen` reuses a closed id. The module holds everything -- including
    // the re-election of any shared table the activation had a coordinate of
    // (lane F stage 1H) -- so `forget` is one module release and nothing else.
    const calls: string[] = [];
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    const sink = recordingDrive().sink;
    sink.releaseResumeSlots = (id) => (calls.push(`module ${id}`), 0);
    const activations = new ForkActivations(sink, "test", {
      registerCatalog: () => {},
      registerStaticRoots: () => {},
    });
    const guest = activation(3, {
      __wpk_fork_static_root_harvest: () => {},
      __wpk_fork_table_2: table,
    });
    activations.register(guest);
    activations.forget(3);
    expect(calls).toEqual(["module 3"]);
    expect(activations.ordered()).toEqual([]);
    expect(() => activations.register(guest), "the id is free again").not.toThrow();
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
      activation(2, {
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
