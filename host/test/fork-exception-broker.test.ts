import { describe, expect, it } from "vitest";

import { ForkExceptionBroker } from "../src/fork-exception-broker";
import { WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE } from "../src/generated/abi";

/** `wire_node_kind`: 3 is Exnref, 1 is Funcref. */
const EXNREF = 3;
const FUNCREF = 1;

interface Node {
  readonly kind: number;
  /** `undefined` stands for the module's `EINVAL` -- a host-owned exception. */
  readonly owner?: number;
}

function harness(options: {
  nodes?: readonly Node[];
  root?: number;
  activations?: Map<number, { instance: WebAssembly.Instance }>;
} = {}) {
  const nodes = options.nodes ?? [];
  const decodes: number[] = [];
  const graph = {
    decodeReferenceGraph(root: number): void {
      decodes.push(root);
    },
    decodedNodeKind(index: number): number {
      const node = nodes[index];
      if (!node) throw new Error(`fm_decoded_node_field failed with errno 22`);
      return node.kind;
    },
    decodedNodeModuleActivation(index: number): number {
      const node = nodes[index];
      if (!node || node.owner === undefined) {
        throw new Error(`fm_decoded_node_field failed with errno 22`);
      }
      return node.owner;
    },
  };
  const activations = options.activations ?? new Map();
  const broker = new ForkExceptionBroker(
    () => graph,
    () => ({ get: (id: number) => activations.get(id) }),
    () => options.root ?? 4096,
    "test broker",
  );
  return { broker, decodes, activations };
}

/** An activation whose exported thrower records its argument and throws. */
function throwingActivation(thrown: unknown = new Error("guest exception")) {
  const calls: number[] = [];
  return {
    calls,
    activation: {
      instance: {
        exports: {
          [WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE]: (recipe: number) => {
            calls.push(recipe);
            throw thrown;
          },
        },
      } as unknown as WebAssembly.Instance,
    },
  };
}

describe("fork exception broker", () => {
  it("throws a recipe through the activation the module says owns it", () => {
    // Two activations, and the graph -- not the host -- decides which one is
    // asked. Activation 1 is the owner; activation 2 must never be called, or
    // the exception would re-enter wasm carrying the wrong tag.
    const owner = throwingActivation(new Error("owner threw"));
    const wrong = throwingActivation(new Error("wrong activation threw"));
    const { broker, activations } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF, owner: 1 }],
      activations: new Map([
        [1, owner.activation],
        [2, wrong.activation],
      ]),
    });
    expect(() => broker.throwRecipe(1)).toThrow("owner threw");
    expect(owner.calls, "the owner was asked, with the recipe").toEqual([1]);
    expect(wrong.calls, "no other activation was asked").toEqual([]);
  });

  it("decodes the graph once, and again only after invalidate()", () => {
    // A decode abandons the previous resident graph without freeing it, so
    // decoding per throw would leak per throw. Caching it is only sound while
    // something says when the graph changed.
    const owner = throwingActivation();
    const { broker, decodes, activations } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF, owner: 1 }],
      root: 8192,
    });
    activations.set(1, owner.activation);
    expect(() => broker.throwRecipe(1)).toThrow();
    expect(() => broker.throwRecipe(1)).toThrow();
    expect(decodes, "two throws, one decode").toEqual([8192]);
    broker.invalidate();
    expect(() => broker.throwRecipe(1)).toThrow();
    expect(decodes, "and a fresh decode once the graph changed").toEqual([
      8192,
      8192,
    ]);
  });

  it("refuses a recipe id that is not one", () => {
    const { broker } = harness({ nodes: [{ kind: EXNREF, owner: 1 }] });
    // -1 is what a refusing module encoder returns; 0 is never a recipe.
    for (const bad of [-1, 0, 1.5, 0x7fff_ffff, Number.NaN]) {
      expect(() => broker.throwRecipe(bad), String(bad)).toThrow(RangeError);
    }
  });

  it("refuses when no arena has a graph to ask", () => {
    const { broker } = harness({ nodes: [{ kind: EXNREF, owner: 1 }], root: 0 });
    expect(() => broker.throwRecipe(1)).toThrow(
      /no sealed module-state arena/,
    );
  });

  it("refuses a node that is not an exception", () => {
    // The kind is checked BEFORE the owner, because a funcref node has an
    // activation too -- reading it would route a function to a thrower.
    const owner = throwingActivation();
    const { broker } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: FUNCREF, owner: 1 }],
      activations: new Map([[1, owner.activation]]),
    });
    expect(() => broker.throwRecipe(1)).toThrow(/node kind 1, not an exception/);
    expect(owner.calls, "and nothing was thrown at the activation").toEqual([]);
  });

  it("names the host-owned boundary when the module cannot report an owner", () => {
    const { broker } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF }],
    });
    expect(() => broker.throwRecipe(1)).toThrow(/host-owned/);
  });

  it("refuses an owner this worker never registered", () => {
    const { broker } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF, owner: 7 }],
    });
    expect(() => broker.throwRecipe(1)).toThrow(
      /owned by activation 7, which is not registered/,
    );
  });

  it("refuses an owner that exports no thrower", () => {
    const { broker } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF, owner: 1 }],
      activations: new Map([
        [1, { instance: { exports: {} } as unknown as WebAssembly.Instance }],
      ]),
    });
    expect(() => broker.throwRecipe(1)).toThrow(/exports no __wpk_fork_ref_exn_throw_recipe/);
  });

  it("refuses a thrower that returns", () => {
    // Silence here is the dangerous failure: a replay that continues past an
    // exception it never delivered has corrupted the child, quietly.
    const { broker } = harness({
      nodes: [{ kind: FUNCREF, owner: 0 }, { kind: EXNREF, owner: 1 }],
      activations: new Map([
        [
          1,
          {
            instance: {
              exports: {
                [WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE]: () => undefined,
              },
            } as unknown as WebAssembly.Instance,
          },
        ],
      ]),
    });
    expect(() => broker.throwRecipe(1)).toThrow(/without throwing/);
  });

  // The ingress half's test went with the method. It asserted that the broker
  // named the bound it ran into -- nothing can mint an ingress token, because
  // `__wpk_fork_ref_exn_broker_encode` is the only minter and the module
  // refuses it with EOPNOTSUPP. The module states that bound itself now, so
  // the guest import never reaches JavaScript; `fork-module-host-obligation`
  // asserts the module exports it. Census 191.
});
