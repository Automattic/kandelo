import { describe, expect, it } from "vitest";

import { ForkChildReferences } from "../src/fork-child-references";

const KIND_NULL = 0;
const KIND_FUNCREF = 1;
/** The retired host-externref kind (externref stage E2); no graph names it. */
const KIND_RETIRED_EXTERNREF = 2;
const KIND_EXNREF = 3;
const KIND_I31 = 4;
const KIND_STRUCT = 5;
const KIND_STATIC_ROOT = 7;

const TYPE_FUNCREF = 6;
const TYPE_EXTERNREF = 7;
const TYPE_EXNREF = 8;
const TYPE_ANYREF = 9;
const TYPE_I32 = 1;

function build(nodes: Record<number, { kind: number; activation?: number }>) {
  const functionCatalog = new WebAssembly.Table({ element: "anyfunc", initial: 4 });
  const staticRootCatalog = new WebAssembly.Table({ element: "externref", initial: 4 });
  const refs = new ForkChildReferences(
    {
      decodedNodeKind: (index) => {
        const node = nodes[index];
        if (!node) throw new Error(`fm_decoded_node_field failed with errno 22`);
        return node.kind;
      },
      decodedNodeModuleActivation: (index) => {
        const node = nodes[index];
        if (!node || node.activation === undefined) {
          throw new Error(`fm_decoded_node_field failed with errno 22`);
        }
        return node.activation;
      },
      funcrefOrdinal: (recipeId) => recipeId,
      staticRootSlot: (recipeId) => recipeId,
      },
    {
      functionCatalog,
      staticRootCatalog,
    },
    "test child references",
  );
  return { refs, functionCatalog, staticRootCatalog };
}

describe("fork child references", () => {
  it("names the activation a reference must wait for, and only when there is one", () => {
    const { refs } = build({
      1: { kind: KIND_FUNCREF, activation: 3 },
      3: { kind: KIND_NULL },
    });
    expect(refs.ownerActivation(1, TYPE_FUNCREF)).toBe(3);
    expect(refs.ownerActivation(3, TYPE_FUNCREF), "null belongs to nobody").toBeNull();
  });

  it("materializes a funcref through the merged catalog", () => {
    const { refs, functionCatalog } = build({ 2: { kind: KIND_FUNCREF, activation: 0 } });
    const fn = new WebAssembly.Instance(
      new WebAssembly.Module(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
          7, 5, 1, 1, 102, 0, 0, 10, 4, 1, 2, 0, 11,
        ]),
      ),
    ).exports.f as CallableFunction;
    functionCatalog.set(2, fn as never);
    expect(refs.materialize(2, TYPE_FUNCREF)).toBe(fn);
  });

  it("refuses a funcref whose catalog slot is empty", () => {
    const { refs } = build({ 2: { kind: KIND_FUNCREF, activation: 0 } });
    expect(() => refs.materialize(2, TYPE_FUNCREF)).toThrow(
      /names catalog slot 2, which holds no function/,
    );
  });

  it("refuses the retired host-externref kind at every reference type", () => {
    // A fork does not carry a raw host externref (externref stage E2), so no
    // decoded graph names kind 2. Should one appear, the child refuses it
    // rather than inventing a value.
    const { refs } = build({ 5: { kind: KIND_RETIRED_EXTERNREF } });
    for (const type of [TYPE_FUNCREF, TYPE_EXTERNREF, TYPE_EXNREF, TYPE_ANYREF]) {
      expect(() => refs.materialize(5, type), `type ${type}`).toThrow(
        /node kind 2, which cannot be imported/,
      );
    }
  });

  it("materializes a static root through its catalog slot", () => {
    const { refs, staticRootCatalog } = build({
      1: { kind: KIND_STATIC_ROOT, activation: 2 },
    });
    const value = { static: "root" };
    staticRootCatalog.set(1, value);
    expect(refs.materialize(1, TYPE_EXTERNREF)).toBe(value);
  });

  it("returns null for a null reference at any reference type", () => {
    const { refs } = build({ 0: { kind: KIND_NULL } });
    for (const type of [TYPE_FUNCREF, TYPE_EXTERNREF, TYPE_EXNREF, TYPE_ANYREF]) {
      expect(refs.materialize(0, type), `type ${type}`).toBeNull();
    }
  });

  it("refuses an exnref, which cannot cross into JavaScript at all", () => {
    const { refs } = build({ 4: { kind: KIND_EXNREF, activation: 1 } });
    expect(() => refs.materialize(4, TYPE_EXNREF)).toThrow(
      /cannot cross JavaScript/,
    );
  });

  it("refuses a typed GC value, which needs the module's drive", () => {
    const { refs } = build({
      6: { kind: KIND_STRUCT, activation: 1 },
      7: { kind: KIND_I31 },
    });
    expect(() => refs.materialize(6, TYPE_ANYREF)).toThrow(/module's drive/);
    expect(() => refs.materialize(7, TYPE_ANYREF)).toThrow(/module's drive/);
  });

  it("refuses a node whose kind the declared type cannot carry", () => {
    // The kind and the declared type come from different records written at
    // different times. A mismatch means the arena disagrees with itself, and
    // binding the wrong reference into an import object is silent.
    const { refs } = build({
      1: { kind: KIND_FUNCREF, activation: 0 },
      2: { kind: KIND_EXNREF, activation: 0 },
    });
    expect(() => refs.materialize(1, TYPE_EXTERNREF)).toThrow(
      /node kind 1, which cannot be imported at declared type 7/,
    );
    expect(() => refs.materialize(2, TYPE_FUNCREF)).toThrow(
      /node kind 3, which cannot be imported at declared type 6/,
    );
    expect(() => refs.materialize(1, TYPE_I32), "not a reference type").toThrow(
      /declared type 1/,
    );
  });

  it("refuses a recipe id that is not one", () => {
    const { refs } = build({});
    expect(() => refs.materialize(-1, TYPE_FUNCREF)).toThrow(/not a recipe id/);
    expect(() => refs.materialize(1.5, TYPE_FUNCREF)).toThrow(/not a recipe id/);
  });
});
