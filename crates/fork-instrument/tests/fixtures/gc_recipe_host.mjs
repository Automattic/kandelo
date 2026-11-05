import createExceptionStore from "./exception_recipe_host.cjs";

// Scalar graph journal shared by provider and module-state fixtures. Typed
// GC/exception construction remains in the real Wasm providers.
export default function createGcStore(providerModule, transit, wide, options = {}) {
  const descriptor = new DataView(WebAssembly.Module.customSections(
    providerModule, "kandelo.wpk_fork.gc_codec",
  )[0]);
  const layouts = new Map();
  for (let i = 0; i < descriptor.getUint32(8, true); i++) {
    const offset = 16 + i * 44;
    layouts.set(descriptor.getUint32(offset, true), {
      requiresProvenance: (descriptor.getUint16(offset + 10, true) & 1) !== 0,
      scalarLength: descriptor.getUint32(offset + 36, true),
      referenceCount: descriptor.getUint32(offset + 40, true),
    });
  }
  const recipes = new Map();
  const identities = new WeakMap();
  const capturedValues = new Map();
  const provenance = new WeakMap();
  const brokerValues = new Map();
  const staticRecipes = new Map();
  const vectors = [{ expected: 0, values: [] }];
  const exceptions = createExceptionStore();
  let nextRecipe = 1;
  let nextProvenance = 1;
  let pendingProvenance = null;

  function concatenate(left, right) {
    const result = new Uint8Array(left.length + right.length);
    result.set(left);
    result.set(right, left.length);
    return result;
  }

  function instantiate() {
    const memory = options.memory ? options.memory() : new WebAssembly.Memory({ initial: wide ? 2n : 2, address: wide ? "i64" : "i32" });
    const scratch = [];
    let scratchTop = 0x10000;
    let instance;
    const exceptionBinding = exceptions.bind(() => instance, () => memory);

    const implemented = {
      ...exceptionBinding.imports,
      __wpk_fork_ref_encode_funcref(value) {
        if (value === null) return 0;
        const catalog = instance.exports.__wpk_fork_function_catalog;
        if (catalog) {
          for (let ordinal = 0; ordinal < catalog.length; ordinal++) {
            if (catalog.get(ordinal) === value) return 1000000 + ordinal;
          }
          throw new Error("function is absent from the original catalog");
        }
        const names = options.functions ?? ["source_function"];
        const ordinal = names.findIndex(name => instance.exports[name] === value);
        if (ordinal < 0) throw new Error("unexpected function identity");
        return 1000000 + ordinal;
      },
      __wpk_fork_ref_decode_funcref(recipe) {
        if (recipe === 0) return null;
        const catalog = instance.exports.__wpk_fork_function_catalog;
        if (catalog) {
          const ordinal = recipe - 1000000;
          if (ordinal < 0 || ordinal >= catalog.length) throw new Error("invalid function ordinal");
          return catalog.get(ordinal);
        }
        const name = (options.functions ?? ["source_function"])[recipe - 1000000];
        if (name === undefined) throw new Error("invalid function recipe");
        return instance.exports[name];
      },
      __wpk_fork_ref_gc_lookup(slot) {
        const value = transit.get(slot);
        if (value === null) return 0;
        const known = identities.get(value);
        if (known !== undefined) return known;
        const ordinal = options.lookupStatic?.(value, instance);
        if (ordinal === undefined || ordinal === null) return 0;
        const recipe = nextRecipe++;
        identities.set(value, recipe);
        capturedValues.set(recipe, value);
        staticRecipes.set(recipe, ordinal);
        return recipe;
      },
      __wpk_fork_ref_gc_claim(slot) {
        const value = transit.get(slot);
        if (value === null) throw new Error("claim of null GC transit slot");
        let recipe = identities.get(value);
        if (recipe === undefined) {
          recipe = nextRecipe++;
          identities.set(value, recipe);
          capturedValues.set(recipe, value);
        }
        return recipe;
      },
      __wpk_fork_ref_gc_broker_encode(slot) {
        const value = transit.get(slot);
        if (value === null) throw new Error("broker encode received null");
        let recipe = identities.get(value);
        if (recipe === undefined) {
          recipe = nextRecipe++;
          identities.set(value, recipe);
          brokerValues.set(recipe, value);
        }
        while (transit.length <= recipe + 1) transit.grow(1);
        return recipe;
      },
      __wpk_fork_ref_gc_i31(value) {
        const recipe = nextRecipe++;
        recipes.set(recipe, {
          activation: 7,
          type: 0xffffffff,
          layout: 0,
          kind: 0,
          scalars: Uint8Array.of(
            value & 0xff,
            (value >>> 8) & 0xff,
            (value >>> 16) & 0xff,
            (value >>> 24) & 0xff,
          ),
          vector: 0,
        });
        return recipe;
      },
      __wpk_fork_ref_gc_capture_layout(slot, activation, baseLayout) {
        if (activation !== 7) throw new Error("wrong capture activation");
        const record = provenance.get(transit.get(slot));
        if (!record) {
          if (!layouts.get(baseLayout).requiresProvenance) return baseLayout;
          throw new Error("GC constructor provenance was not registered");
        }
        if (record.activation !== activation) {
          throw new Error("GC constructor provenance has the wrong activation");
        }
        if (record.baseLayout !== baseLayout) {
          throw new Error("GC constructor provenance has the wrong base layout");
        }
        return record.specializedLayout;
      },
      __wpk_fork_ref_gc_provenance_begin(
        slot, activation, baseLayout, specializedLayout,
        scalarLo, scalarHi, referenceCount,
      ) {
        if (pendingProvenance !== null) {
          throw new Error("nested GC provenance registration");
        }
        if (activation !== 7) throw new Error("wrong provenance activation");
        const object = transit.get(slot);
        if (object === null) throw new Error("null GC provenance object");
        const layout = layouts.get(specializedLayout);
        if (referenceCount !== layout.referenceCount) throw new Error("wrong provenance seed count");
        const packed = new Uint8Array(16);
        const view = new DataView(packed.buffer);
        view.setBigUint64(0, BigInt.asUintN(64, scalarLo), true);
        view.setBigUint64(8, BigInt.asUintN(64, scalarHi), true);
        const scalars = packed.slice(0, layout.scalarLength);
        const token = nextProvenance++;
        pendingProvenance = {
          token,
          object,
          activation,
          baseLayout,
          specializedLayout,
          scalars,
          referenceCount,
          references: [],
        };
        return token;
      },
      __wpk_fork_ref_gc_provenance_ref(token, index, slot) {
        if (
          pendingProvenance === null
          || pendingProvenance.token !== token
          || index !== pendingProvenance.references.length
          || index >= pendingProvenance.referenceCount
        ) {
          throw new Error("invalid GC provenance reference");
        }
        pendingProvenance.references.push(transit.get(slot));
      },
      __wpk_fork_ref_gc_provenance_end(token) {
        if (
          pendingProvenance === null
          || pendingProvenance.token !== token
          || pendingProvenance.references.length
            !== pendingProvenance.referenceCount
        ) {
          throw new Error("incomplete GC provenance registration");
        }
        provenance.set(pendingProvenance.object, {
          activation: pendingProvenance.activation,
          baseLayout: pendingProvenance.baseLayout,
          specializedLayout: pendingProvenance.specializedLayout,
          scalars: pendingProvenance.scalars,
          references: pendingProvenance.references,
        });
        pendingProvenance = null;
      },
      __wpk_fork_ref_gc_define(
        recipe, activation, type, layout, kind,
        scalarPointer, scalarLength, vector,
      ) {
        const refs = vectors[vector];
        if (!refs || refs.values.length !== refs.expected) {
          throw new Error("incomplete capture vector");
        }
        const source = capturedValues.get(recipe);
        const constructor = source === undefined ? undefined : provenance.get(source);
        const snapshot = new Uint8Array(
          memory.buffer,
          Number(scalarPointer),
          scalarLength,
        ).slice();
        const constructorRecipes = constructor?.references.map((reference) => {
          if (reference === null) return 0;
          transit.set(0, reference);
          return instance.exports.__wpk_fork_ref_gc_encode_slot(0);
        }) ?? [];
        const combinedVector = constructorRecipes.length === 0
          ? vector
          : vectors.push({
            expected: constructorRecipes.length + refs.values.length,
            values: [...constructorRecipes, ...refs.values],
          }) - 1;
        recipes.set(recipe, {
          activation,
          type,
          layout,
          kind,
          scalars: concatenate(
            constructor?.scalars ?? new Uint8Array(),
            snapshot,
          ),
          vector: combinedVector,
        });
      },
      __wpk_fork_ref_gc_route(recipe, activation) {
        const value = recipes.get(recipe);
        return value?.activation === activation ? value.layout : -1;
      },
      __wpk_fork_ref_gc_payload_len(recipe, activation, layout) {
        const value = recipes.get(recipe);
        if (!value || value.activation !== activation || value.layout !== layout) {
          throw new Error("GC payload route mismatch");
        }
        return value.scalars.length;
      },
      __wpk_fork_ref_gc_load(
        recipe, activation, type, layout, kind, destination, length,
      ) {
        const value = recipes.get(recipe);
        if (
          !value
          || value.activation !== activation
          || value.type !== (type >>> 0)
          || value.layout !== layout
          || value.kind !== kind
          || value.scalars.length !== length
        ) throw new Error("GC load coordinate mismatch");
        new Uint8Array(memory.buffer, Number(destination), length)
          .set(value.scalars);
        return value.vector;
      },
      __wpk_fork_ref_vector_begin(expected) {
        const ordinal = vectors.length;
        vectors.push({ expected, values: [] });
        return ordinal;
      },
      __wpk_fork_ref_vector_append(ordinal, recipe) {
        const vector = vectors[ordinal];
        if (!vector || vector.values.length >= vector.expected) {
          throw new Error("invalid vector append");
        }
        vector.values.push(recipe);
      },
      __wpk_fork_ref_vector_finish(ordinal) {
        const vector = vectors[ordinal];
        if (!vector || vector.values.length !== vector.expected) {
          throw new Error("incomplete vector finish");
        }
        return ordinal;
      },
      __wpk_fork_ref_vector_get(ordinal, index) {
        const value = vectors[ordinal]?.values[index];
        if (value === undefined) throw new Error("invalid vector lookup");
        return value;
      },
      __wpk_fork_ref_scratch_reserve(size) {
        const aligned = (Number(size) + 15) & ~15;
        const address = scratchTop;
        scratchTop += aligned;
        scratch.push({ address, size: Number(size), aligned });
        new Uint8Array(memory.buffer, address, aligned).fill(0);
        return wide ? BigInt(address) : address;
      },
      __wpk_fork_ref_scratch_release(address, size) {
        const reservation = scratch.pop();
        if (
          !reservation
          || reservation.address !== Number(address)
          || reservation.size !== Number(size)
        ) throw new Error("non-LIFO scratch release");
        new Uint8Array(
          memory.buffer,
          reservation.address,
          reservation.aligned,
        ).fill(0);
        scratchTop = reservation.address;
      },
    };

    const imports = options.bind ? options.bind(() => instance, memory) : {};
    for (const descriptor of WebAssembly.Module.imports(providerModule)) {
      const namespace = imports[descriptor.module] ??= {};
      if (descriptor.name in namespace) continue;
      if (descriptor.kind === "memory") {
        namespace[descriptor.name] = memory;
      } else if (descriptor.kind === "global") {
        namespace[descriptor.name] = descriptor.name === "__wpk_fork_module_activation"
          ? new WebAssembly.Global({ value: "i32", mutable: false }, 7)
          : new WebAssembly.Global({ value: "i32", mutable: true }, 0);
      } else if (descriptor.kind === "table") {
        namespace[descriptor.name] =
          descriptor.name === "__wpk_fork_ref_gc_transit"
            ? transit
            : new WebAssembly.Table({
                element: "anyfunc",
                initial: 1,
              });
      } else if (descriptor.kind === "tag") {
        namespace[descriptor.name] = new WebAssembly.Tag({ parameters: [] });
      } else if (descriptor.kind === "function") {
        namespace[descriptor.name] = implemented[descriptor.name] ?? (() => {
          throw new Error(`unexpected import call ${descriptor.name}`);
        });
      }
    }
    instance = new WebAssembly.Instance(providerModule, imports);
    return {
      instance, memory,
      assertReleased() {
        if (scratch.length !== 0 || scratchTop !== 0x10000) {
          throw new Error("GC helper retained exchange memory");
        }
        exceptionBinding.assertIdle();
      },
    };
  }
  return { recipes, vectors, brokerValues, staticRecipes, instantiate };
}
