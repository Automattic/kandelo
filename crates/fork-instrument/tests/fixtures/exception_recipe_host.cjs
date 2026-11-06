// Shared fixture host for the real Wasm exception codec. Durable recipes
// survive fresh instances; each binding owns its weak identity map and LIFO
// exchange ranges. This is test protocol plumbing, not an exception provider.
module.exports = function createExceptionStore() {
  const recipes = new Map();
  const ingress = new Map();
  const externIds = new Map();
  const externals = new Map();
  const brokerIds = new Map();
  let nextRecipe = 1;

  function bind(getProvider, getMemory) {
    const memory = { get buffer() { return getMemory().buffer; } };
    const ids = new WeakMap();
    const scratch = [];
    let scratchTop = 0x10000;
    const thrown = (slot) => {
      try {
        getProvider().exports.__wpk_fork_ref_exn_throw_slot(slot);
      } catch (value) {
        return value;
      }
      throw new Error("exception scratch slot returned");
    };
    const imports = {
      __wpk_fork_module_activation:
        new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      __wpk_fork_ref_exn_lookup(slot) {
        return ids.get(thrown(slot)) ?? 0;
      },
      __wpk_fork_ref_exn_claim(slot) {
        const value = thrown(slot);
        let id = ids.get(value);
        if (id === undefined) {
          id = nextRecipe++;
          ids.set(value, id);
        }
        return id;
      },
      __wpk_fork_ref_exn_define(
        id, activation, tag, layout,
        scalarPointer, scalarLength, refsPointer, refCount,
      ) {
        recipes.set(id, {
          activation, tag, layout,
          scalars: new Uint8Array(
            memory.buffer,
            Number(scalarPointer),
            scalarLength,
          ).slice(),
          refs: new Uint32Array(
            memory.buffer,
            Number(refsPointer),
            refCount,
          ).slice(),
        });
      },
      __wpk_fork_ref_exn_load(
        id, activation, tag, layout,
        scalarPointer, scalarLength, refsPointer, refCount,
      ) {
        const recipe = recipes.get(id);
        if (
          !recipe
          || recipe.activation !== activation
          || recipe.tag !== tag
          || recipe.layout !== layout
          || recipe.scalars.length !== scalarLength
          || recipe.refs.length !== refCount
        ) return 0;
        new Uint8Array(memory.buffer, Number(scalarPointer), scalarLength)
          .set(recipe.scalars);
        new Uint32Array(memory.buffer, Number(refsPointer), refCount)
          .set(recipe.refs);
        return 1;
      },
      __wpk_fork_ref_exn_route(id, activation) {
        const recipe = recipes.get(id);
        return recipe && !recipe.broker && recipe.activation === activation ? recipe.layout : -1;
      },
      __wpk_fork_ref_exn_cache_index(id) {
        return id;
      },
      __wpk_fork_ref_exn_broker_encode(slot) {
        const value = thrown(slot);
        if (brokerIds.has(value)) return brokerIds.get(value);
        const id = nextRecipe++;
        brokerIds.set(value, id);
        recipes.set(id, { broker: true, value });
        return id;
      },
      __wpk_fork_ref_exn_broker_throw_recipe(id) {
        const recipe = recipes.get(id);
        if (!recipe?.broker) throw new Error("invalid broker recipe");
        throw recipe.value;
      },
      __wpk_fork_ref_exn_ingress_throw(token) {
        if (!ingress.has(token)) throw new Error("invalid ingress token");
        throw ingress.get(token);
      },
      __wpk_fork_ref_scratch_reserve(size) {
        const wide = typeof size === 'bigint';
        size = Number(size);
        const aligned = (size + 15) & ~15;
        const address = scratchTop;
        scratchTop += aligned;
        scratch.push({ address, size, aligned });
        new Uint8Array(memory.buffer, address, aligned).fill(0);
        return wide ? BigInt(address) : address;
      },
      __wpk_fork_ref_scratch_release(address, size) {
        address = Number(address);
        size = Number(size);
        const reservation = scratch.pop();
        if (
          !reservation
          || reservation.address !== address
          || reservation.size !== size
        ) throw new Error("non-LIFO scratch release");
        new Uint8Array(memory.buffer, address, reservation.aligned).fill(0);
        scratchTop = address;
      },
      __wpk_fork_ref_encode_funcref() { throw new Error("unused funcref"); },
      __wpk_fork_ref_decode_funcref() { throw new Error("unused funcref"); },
      __wpk_fork_ref_encode_externref(value) {
        if (value === null) return 0;
        if (!externIds.has(value)) {
          const id = nextRecipe++;
          externIds.set(value, id);
          externals.set(id, value);
        }
        return externIds.get(value);
      },
      __wpk_fork_ref_decode_externref(id) {
        if (id === 0) return null;
        if (!externals.has(id)) throw new Error('unknown externref recipe');
        return externals.get(id);
      },
    };
    return {
      imports,
      assertIdle() {
        if (scratch.length !== 0) throw new Error('unreleased exception exchange range');
      },
    };
  }
  return { recipes, ingress, bind };
};
