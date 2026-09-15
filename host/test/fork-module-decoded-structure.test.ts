// Orchestration migration increment C — the module-owned decoded-graph
// STRUCTURE readout, proven end to end in a real WebAssembly engine (Node/V8).
//
// `fm_decoded_node_field(index, field)` is a scalar accessor over the resident
// decoded graph `fm_decode_reference_graph` produces (the shared
// `fork_codec::reference_segments` decode). It exposes the decoded structure
// the host's fork wiring still consumes from a decode of its own:
//   * the exnref tag-validity admission gate reads each exnref node's
//     `moduleActivation` + `tagOrdinal`;
//   * the merged static-root catalog mirror seeding reads each static-root
//     node's `moduleActivation` + `staticRootOrdinal` (and the per-activation
//     max ordinal it derives).
//
// THE ARENA IS CAPTURED, AND THE CAPTURE IS THE ORACLE. This file used to build
// one sealed KFMS arena with the set-aside TypeScript encoder, decode the same
// bytes with the set-aside TypeScript decoder, and assert the module's readout
// matched that decode node-for-node. Both halves of the comparison were the
// same set-aside implementation, so it could only prove the two agreed.
//
// What the readout must report is what was CAPTURED. A parent interns each kind
// at a coordinate chosen here -- in a fork that dlopen'd three side modules, so
// most nodes name an activation that is not activation 0 -- and those
// coordinates are what the assertions compare against.

import { describe, expect, it } from "vitest";

import {
  CAPTURE_KIND_ARRAY,
  CAPTURE_KIND_EXNREF,
  CAPTURE_KIND_STRUCT,
  INTERN_KIND_EXTERNREF,
  INTERN_KIND_FUNCREF,
  INTERN_KIND_I31,
  INTERN_KIND_STATIC_ROOT,
  captureGraph,
  childModule,
  fixture,
} from "./fork-module-capture-fixture";

const EINVAL = 22;
const EXTERNREF_HANDLE = 0xabcd;
/** Side modules this fork dlopen'd: a node naming one of these would read back
 *  as activation 0 if the accessor dropped the activation it decoded. */
const SIDE_ACTIVATIONS = [1, 2, 3];

/** The wire node-kind discriminants, mirroring the Rust `wire_node_kind`. */
const WIRE_KIND = {
  null: 0,
  funcref: 1,
  externref: 2,
  exnref: 3,
  i31: 4,
  struct: 5,
  array: 6,
  staticRoot: 7,
} as const;

/** `fm_decoded_node_field` fields. */
const FIELD_KIND = 0;
const FIELD_ACTIVATION = 1;
const FIELD_ORDINAL = 2;

interface StructureExports {
  fm_decode_reference_graph: (root: number) => number;
  fm_decoded_node_count: () => number;
  fm_decoded_node_field: (index: number, field: number) => number;
  fm_last_errno: () => number;
}

/**
 * What the readout must report for one captured node: its wire kind, and the
 * (activation, ordinal) the capture named -- or `null` for the kinds carrying
 * neither, where the readout must refuse rather than answer a zero.
 */
interface Expected {
  readonly kind: number;
  readonly coordinate:
    | { readonly activation: number; readonly ordinal: number }
    | null;
}

/**
 * Capture one graph covering every accessor arm: the two primary host consumers
 * (exnref, static-root), the other kinds carrying an activation + ordinal
 * (funcref, struct, array), and the kinds carrying neither (null, externref,
 * i31). Each aggregate names the externref leaf as its one edge, so the graph
 * is connected the way a real one is rather than a list of isolated nodes.
 */
function captureInto(
  f: ReturnType<typeof fixture>,
): { root: number; expected: Map<number, Expected> } {
  const { root, recipes, aggregateRecipes } = captureGraph(
    f,
    [
      [INTERN_KIND_EXTERNREF, EXTERNREF_HANDLE, 0],
      [INTERN_KIND_FUNCREF, 3, 7],
      [INTERN_KIND_I31, 42, 0],
      [INTERN_KIND_STATIC_ROOT, 2, 11],
    ],
    [
      {
        kind: CAPTURE_KIND_EXNREF,
        activation: 1,
        typeOrdinal: 9,
        edges: ({ leaves }) => [leaves[0]!],
      },
      {
        kind: CAPTURE_KIND_STRUCT,
        activation: 2,
        typeOrdinal: 13,
        edges: ({ leaves }) => [leaves[0]!],
      },
      {
        kind: CAPTURE_KIND_ARRAY,
        activation: 3,
        typeOrdinal: 17,
        edges: ({ leaves }) => [leaves[0]!],
      },
    ],
    { sideActivations: SIDE_ACTIVATIONS },
  );

  const expected = new Map<number, Expected>([
    // Node 0 is the canonical null every capture reserves.
    [0, { kind: WIRE_KIND.null, coordinate: null }],
    [recipes[0]!, { kind: WIRE_KIND.externref, coordinate: null }],
    [
      recipes[1]!,
      { kind: WIRE_KIND.funcref, coordinate: { activation: 3, ordinal: 7 } },
    ],
    [recipes[2]!, { kind: WIRE_KIND.i31, coordinate: null }],
    [
      recipes[3]!,
      { kind: WIRE_KIND.staticRoot, coordinate: { activation: 2, ordinal: 11 } },
    ],
    [
      aggregateRecipes[0]!,
      { kind: WIRE_KIND.exnref, coordinate: { activation: 1, ordinal: 9 } },
    ],
    [
      aggregateRecipes[1]!,
      { kind: WIRE_KIND.struct, coordinate: { activation: 2, ordinal: 13 } },
    ],
    [
      aggregateRecipes[2]!,
      { kind: WIRE_KIND.array, coordinate: { activation: 3, ordinal: 17 } },
    ],
  ]);
  return { root, expected };
}

/** A child instance with the captured graph decoded and resident. */
function decodedChild(
  f: ReturnType<typeof fixture>,
  root: number,
  label: string,
): StructureExports {
  const x = childModule(f, { label }) as unknown as StructureExports;
  const count = x.fm_decode_reference_graph(root);
  expect(x.fm_last_errno(), "the child decodes the sealed graph").toBe(0);
  expect(count, "and finds every captured node").toBeGreaterThan(0);
  return x;
}

describe("fork-module decoded-graph structure readout (orchestration migration increment C)", () => {
  it("reports the kind / activation / ordinal each node was captured with", () => {
    const f = fixture();
    const { root, expected } = captureInto(f);
    const x = decodedChild(f, root, "decoded-structure-child");

    expect(x.fm_decoded_node_count()).toBe(expected.size);

    for (const [index, want] of expected) {
      expect(
        x.fm_decoded_node_field(index, FIELD_KIND),
        `node ${index} kind`,
      ).toBe(want.kind);
      expect(x.fm_last_errno()).toBe(0);

      if (want.coordinate === null) {
        // A kind without an activation/ordinal is a truthful EINVAL, not a zero.
        expect(x.fm_decoded_node_field(index, FIELD_ACTIVATION)).toBe(-1);
        expect(x.fm_last_errno()).toBe(EINVAL);
        expect(x.fm_decoded_node_field(index, FIELD_ORDINAL)).toBe(-1);
        expect(x.fm_last_errno()).toBe(EINVAL);
      } else {
        expect(
          x.fm_decoded_node_field(index, FIELD_ACTIVATION),
          `node ${index} activation`,
        ).toBe(want.coordinate.activation);
        expect(x.fm_last_errno()).toBe(0);
        expect(
          x.fm_decoded_node_field(index, FIELD_ORDINAL),
          `node ${index} ordinal`,
        ).toBe(want.coordinate.ordinal);
        expect(x.fm_last_errno()).toBe(0);
      }
    }
  });

  it("proves the two primary host consumers can source their structure from the module", () => {
    const f = fixture();
    const { root } = captureInto(f);
    const x = decodedChild(f, root, "decoded-structure-consumers");

    // The exnref admission gate collects {activation, tagOrdinal}.
    const exnrefs: { activation: number; tagOrdinal: number }[] = [];
    // The static-root mirror seeding collects {activation, staticRootOrdinal}.
    const staticRoots: { activation: number; staticRootOrdinal: number }[] = [];
    for (let i = 0; i < x.fm_decoded_node_count(); i++) {
      const kind = x.fm_decoded_node_field(i, FIELD_KIND);
      if (kind === WIRE_KIND.exnref) {
        exnrefs.push({
          activation: x.fm_decoded_node_field(i, FIELD_ACTIVATION),
          tagOrdinal: x.fm_decoded_node_field(i, FIELD_ORDINAL),
        });
      } else if (kind === WIRE_KIND.staticRoot) {
        staticRoots.push({
          activation: x.fm_decoded_node_field(i, FIELD_ACTIVATION),
          staticRootOrdinal: x.fm_decoded_node_field(i, FIELD_ORDINAL),
        });
      }
    }

    expect(exnrefs).toEqual([{ activation: 1, tagOrdinal: 9 }]);
    expect(staticRoots).toEqual([{ activation: 2, staticRootOrdinal: 11 }]);
  });

  it("fails cleanly on an out-of-range index and with no resident graph", () => {
    const f = fixture();
    const { root } = captureInto(f);
    const x = childModule(f, {
      label: "decoded-structure-boundaries",
    }) as unknown as StructureExports;

    // No resident graph yet: every field refuses.
    for (const field of [FIELD_KIND, FIELD_ACTIVATION, FIELD_ORDINAL]) {
      expect(x.fm_decoded_node_field(0, field)).toBe(-1);
      expect(x.fm_last_errno()).toBe(EINVAL);
    }

    const count = x.fm_decode_reference_graph(root);
    expect(x.fm_last_errno()).toBe(0);
    // After decode, one past the end is a truthful EINVAL.
    for (const field of [FIELD_KIND, FIELD_ACTIVATION, FIELD_ORDINAL]) {
      expect(x.fm_decoded_node_field(count, field)).toBe(-1);
      expect(x.fm_last_errno()).toBe(EINVAL);
    }
  });
});
