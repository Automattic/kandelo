import { describe, expect, it } from "vitest";

import { ForkChildReferences } from "../src/fork-child-references";

const KIND_NULL = 0;
const KIND_FUNCREF = 1;
const KIND_EXTERNREF = 2;
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
  const resolved: number[] = [];
  const token = { the: "host token" };
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
      externrefHandle: (recipeId) => recipeId * 10,
      staticRootSlot: (recipeId) => recipeId,
      },
    {
      functionCatalog,
      staticRootCatalog,
      resolveExternref: (handle) => {
        resolved.push(handle);
        return token;
      },
    },
    "test child references",
  );
  return { refs, functionCatalog, staticRootCatalog, resolved, token };
}

describe("fork child references", () => {
  it("names the activation a reference must wait for, and only when there is one", () => {
    const { refs } = build({
      1: { kind: KIND_FUNCREF, activation: 3 },
      2: { kind: KIND_EXTERNREF },
      3: { kind: KIND_NULL },
    });
    expect(refs.ownerActivation(1, TYPE_FUNCREF)).toBe(3);
    // A host externref belongs to no activation. Making one a dependency would
    // order the child against an activation that has nothing to do with it.
    expect(refs.ownerActivation(2, TYPE_EXTERNREF)).toBeNull();
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

  it("materializes an externref through the broker handle", () => {
    const { refs, resolved, token } = build({ 5: { kind: KIND_EXTERNREF } });
    expect(refs.materialize(5, TYPE_EXTERNREF)).toBe(token);
    expect(resolved, "the handle the module said, not the recipe id").toEqual([50]);
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
      2: { kind: KIND_EXTERNREF },
    });
    expect(() => refs.materialize(1, TYPE_EXTERNREF)).toThrow(
      /node kind 1, which cannot be imported at declared type 7/,
    );
    expect(() => refs.materialize(2, TYPE_FUNCREF)).toThrow(
      /node kind 2, which cannot be imported at declared type 6/,
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
