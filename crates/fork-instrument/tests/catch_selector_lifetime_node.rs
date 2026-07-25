use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

const SEQUENTIAL_REGIONS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $a (param i32))
      (tag $b (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $phase i32)
        (local $caught i32)
        (loop $again
          (block $skip_a
            (block $caught_a (result i32)
              (try_table (catch $a $caught_a)
                local.get $phase
                if
                  i32.const 101
                  throw $a
                else
                  br $skip_a
                end
                unreachable)
              unreachable)
            local.set $caught
            i32.const 4096
            call $fork
            local.get $caught
            i32.add
            i32.store
            return)

          (block $skip_b
            (block $caught_b (result i32)
              (try_table (catch $b $caught_b)
                local.get $phase
                i32.eqz
                if
                  i32.const 202
                  throw $b
                else
                  br $skip_b
                end
                unreachable)
              unreachable)
            drop)

          i32.const 1
          local.set $phase
          br $again)))
"#;

const NESTED_REGIONS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $outer (param i32))
      (tag $inner (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $phase i32)
        (local $caught i32)
        (loop $again
          (block $outer_handler
            (block $caught_outer (result i32)
              (try_table (catch $outer $caught_outer)
                i32.const 301
                throw $outer
                unreachable)
              unreachable)
            local.set $caught

            local.get $phase
            if
              i32.const 4096
              call $fork
              local.get $caught
              i32.add
              i32.store
              return
            end

            (block $caught_inner (result i32)
              (try_table (catch $inner $caught_inner)
                i32.const 302
                throw $inner
                unreachable)
              unreachable)
            drop)

          i32.const 1
          local.set $phase
          br $again)))
"#;

const LOOP_REENTERED_ARMS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $a (param i32))
      (tag $b (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $phase i32)
        (local $caught i32)
        (loop $again
          (block $caught (result i32)
            (try_table (catch $a $caught) (catch $b $caught)
              local.get $phase
              if
                i32.const 401
                throw $a
              else
                i32.const 402
                throw $b
              end
              unreachable)
            unreachable)
          local.set $caught

          local.get $phase
          if
            i32.const 4096
            call $fork
            local.get $caught
            i32.add
            i32.store
            return
          end

          i32.const 1
          local.set $phase
          br $again)))
"#;

const NESTED_INNER_LATEST: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $outer (param i32))
      (tag $inner (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $outer_value i32)
        (local $inner_value i32)
        (block $caught_outer (result i32)
          (try_table (catch $outer $caught_outer)
            i32.const 501
            throw $outer
            unreachable)
          unreachable)
        local.set $outer_value
        (block $caught_inner (result i32)
          (try_table (catch $inner $caught_inner)
            i32.const 502
            throw $inner
            unreachable)
          unreachable)
        local.set $inner_value
        i32.const 4096
        call $fork
        local.get $outer_value
        i32.add
        local.get $inner_value
        i32.add
        i32.store))
"#;

const NESTED_RECIPE_REGIONS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $outer (param v128))
      (tag $inner (param v128))
      (memory (export "memory") 8)

      (func (export "run")
        (local $outer_value i32)
        (local $inner_value i32)
        (block $outer_handler_scope
          (block $caught_outer (result v128 exnref)
            (try_table (catch_ref $outer $caught_outer)
              v128.const i32x4 701 0 0 0
              throw $outer
              unreachable)
            unreachable)
          drop
          i32x4.extract_lane 0
          local.set $outer_value

          ;; This second recipe-backed catch executes in the continuation of
          ;; the outer handler. Its selector and exception supersede the outer
          ;; synthetic replay state, while the ordinary scalar value remains
          ;; independently activation-owned.
          (block $caught_inner (result v128 exnref)
            (try_table (catch_ref $inner $caught_inner)
              v128.const i32x4 702 0 0 0
              throw $inner
              unreachable)
            unreachable)
          drop
          i32x4.extract_lane 0
          local.set $inner_value

          i32.const 4096
          call $fork
          local.get $outer_value
          i32.add
          local.get $inner_value
          i32.add
          i32.store))
    )
"#;

const SCALAR_SUPERSEDES_RECIPE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $recipe (param v128))
      (tag $scalar (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $recipe_value i32)
        (local $scalar_value i32)
        (block $caught_recipe (result v128 exnref)
          (try_table (catch_ref $recipe $caught_recipe)
            v128.const i32x4 801 0 0 0
            throw $recipe
            unreachable)
          unreachable)
        drop
        i32x4.extract_lane 0
        local.set $recipe_value

        (block $caught_scalar (result i32)
          (try_table (catch $scalar $caught_scalar)
            i32.const 802
            throw $scalar
            unreachable)
          unreachable)
        local.set $scalar_value

        i32.const 4096
        call $fork
        local.get $recipe_value
        i32.add
        local.get $scalar_value
        i32.add
        i32.store))
"#;

const MERGED_NORMAL_AFTER_CATCH: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $caught (param i32))
      (memory (export "memory") 8)

      (func (export "run")
        (local $caught_value i32)
        (block $handler (result i32)
          (try_table (catch $caught $handler)
            i32.const 601
            throw $caught
            unreachable)
          unreachable)
        local.set $caught_value

        ;; Both the catch and normal predecessor have left their structured
        ;; region before this ordinary merged suffix. Replay must dispatch
        ;; directly to fork without executing the obsolete throw stub.
        (block $merged
          nop)
        i32.const 4096
        call $fork
        local.get $caught_value
        i32.add
        i32.store))
"#;

fn instrument_fixture(source: &str) -> Vec<u8> {
    let input = wat::parse_str(source).expect("parse catch lifetime fixture");
    instrument(&input, &Options::default()).expect("instrument catch lifetime fixture")
}

#[test]
fn fresh_replay_uses_dynamic_selector_without_reentering_obsolete_catches() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-catch-selector-lifetime-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    for (name, source, expected_selector, expected_result, expected_recipe) in [
        ("sequential", SEQUENTIAL_REGIONS, 1, 108, -1),
        ("nested", NESTED_REGIONS, 1, 308, -1),
        ("reentered", LOOP_REENTERED_ARMS, 1, 408, -1),
        ("inner-latest", NESTED_INNER_LATEST, 2, 1010, -1),
        ("nested-recipe", NESTED_RECIPE_REGIONS, 2, 1410, 1),
        (
            "scalar-supersedes-recipe",
            SCALAR_SUPERSEDES_RECIPE,
            2,
            1610,
            0,
        ),
        ("merged-normal", MERGED_NORMAL_AFTER_CATCH, 1, 608, -1),
    ] {
        fs::write(
            directory.join(format!("{name}.wasm")),
            instrument_fixture(source),
        )
        .unwrap_or_else(|error| panic!("write {name} fixture: {error}"));
        fs::write(
            directory.join(format!("{name}.expect")),
            format!("{expected_selector} {expected_result} {expected_recipe}\n"),
        )
        .unwrap_or_else(|error| panic!("write {name} expectation: {error}"));
    }
    fs::write(
        directory.join("test.mjs"),
        r#"
import { readFileSync } from "node:fs";

function importsFor(module, role) {
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace = imports[descriptor.module] ??= {};
    switch (descriptor.kind) {
      case "table":
        namespace[descriptor.name] = new WebAssembly.Table({
          element: descriptor.name === "__wpk_fork_ref_gc_transit"
            ? "anyref"
            : "anyfunc",
          initial: 1024,
        });
        break;
      case "global":
        if (descriptor.name === "__wpk_fork_module_state_table_generation_addr") {
          namespace[descriptor.name] = new WebAssembly.Global(
            { value: "i64", mutable: false },
            0n,
          );
          break;
        }
        namespace[descriptor.name] = new WebAssembly.Global(
          { value: "i32", mutable: false },
          0,
        );
        break;
      case "tag":
        namespace[descriptor.name] = new WebAssembly.Tag({ parameters: [] });
        break;
      case "memory":
        throw new Error(`unexpected memory import ${descriptor.module}.${descriptor.name}`);
      case "function":
        namespace[descriptor.name] = (...args) => role.call(descriptor, args);
        break;
      default:
        throw new Error(`unexpected import kind ${descriptor.kind}`);
    }
  }
  return imports;
}

function captureAndReplay(
  path,
  expectedSelector,
  expectedResult,
  expectedRecipe,
) {
  const module = new WebAssembly.Module(readFileSync(path));
  const frames = [];
  const exceptionRecipes = new Map();
  const referenceVectors = new Map();
  const unhandled = Symbol("unhandled reference import");
  const root = 0x10000;
  let nextPayload = 0x30000;
  let nextExceptionRecipe = 1;
  let nextReferenceVector = 1;

  function referenceCalls(getInstance) {
    const exceptionIds = new WeakMap();
    const scratch = [];
    let scratchTop = 0x20000;
    const memory = () => getInstance().exports.memory;
    const thrownFromSlot = (slot) => {
      try {
        getInstance().exports.__wpk_fork_ref_exn_throw_slot(slot);
      } catch (value) {
        if (!(value instanceof WebAssembly.Exception)) throw value;
        return value;
      }
      throw new Error("exception scratch slot returned");
    };
    return (descriptor, args) => {
      switch (descriptor.name) {
        case "__wpk_fork_ref_vector_begin": {
          const id = nextReferenceVector++;
          referenceVectors.set(id, {
            expected: Number(args[0]),
            recipes: [],
          });
          return id;
        }
        case "__wpk_fork_ref_vector_append": {
          const vector = referenceVectors.get(Number(args[0]));
          if (!vector || vector.recipes.length >= vector.expected) {
            throw new Error("invalid reference-vector append");
          }
          vector.recipes.push(Number(args[1]));
          return 0;
        }
        case "__wpk_fork_ref_vector_finish": {
          const id = Number(args[0]);
          const vector = referenceVectors.get(id);
          if (!vector || vector.recipes.length !== vector.expected) {
            throw new Error("incomplete reference vector");
          }
          return id;
        }
        case "__wpk_fork_ref_vector_get": {
          const vector = referenceVectors.get(Number(args[0]));
          const index = Number(args[1]);
          if (!vector || vector.recipes.length !== vector.expected) {
            throw new Error("incomplete reference vector");
          }
          if (index < 0 || index >= vector.recipes.length) {
            throw new Error("reference-vector index out of range");
          }
          return vector.recipes[index];
        }
        case "__wpk_fork_ref_exn_lookup":
          return exceptionIds.get(thrownFromSlot(Number(args[0]))) ?? 0;
        case "__wpk_fork_ref_exn_claim": {
          const exception = thrownFromSlot(Number(args[0]));
          let id = exceptionIds.get(exception);
          if (id === undefined) {
            id = nextExceptionRecipe++;
            exceptionIds.set(exception, id);
          }
          return id;
        }
        case "__wpk_fork_ref_exn_define": {
          const [
            id, activation, tag, layout,
            scalarPointer, scalarLength, refsPointer, refCount,
          ] = args.map(Number);
          exceptionRecipes.set(id, {
            activation,
            tag,
            layout,
            scalars: new Uint8Array(
              memory().buffer,
              scalarPointer,
              scalarLength,
            ).slice(),
            refs: new Uint32Array(
              memory().buffer,
              refsPointer,
              refCount,
            ).slice(),
          });
          return 0;
        }
        case "__wpk_fork_ref_exn_load": {
          const [
            id, activation, tag, layout,
            scalarPointer, scalarLength, refsPointer, refCount,
          ] = args.map(Number);
          const recipe = exceptionRecipes.get(id);
          if (
            !recipe
            || recipe.activation !== activation
            || recipe.tag !== tag
            || recipe.layout !== layout
            || recipe.scalars.length !== scalarLength
            || recipe.refs.length !== refCount
          ) return 0;
          new Uint8Array(memory().buffer, scalarPointer, scalarLength)
            .set(recipe.scalars);
          new Uint32Array(memory().buffer, refsPointer, refCount)
            .set(recipe.refs);
          return 1;
        }
        case "__wpk_fork_ref_exn_route": {
          const recipe = exceptionRecipes.get(Number(args[0]));
          return recipe?.activation === Number(args[1])
            ? recipe.layout
            : -1;
        }
        case "__wpk_fork_ref_exn_cache_index":
          return Number(args[0]);
        case "__wpk_fork_ref_exn_broker_encode":
        case "__wpk_fork_ref_exn_broker_throw_recipe":
        case "__wpk_fork_ref_exn_ingress_throw":
          throw new Error("known local exception unexpectedly used broker routing");
        case "__wpk_fork_ref_scratch_reserve": {
          const size = Number(args[0]);
          const aligned = (size + 15) & ~15;
          const address = scratchTop;
          scratchTop += aligned;
          scratch.push({ address, size, aligned });
          new Uint8Array(memory().buffer, address, aligned).fill(0);
          return address;
        }
        case "__wpk_fork_ref_scratch_release": {
          const address = Number(args[0]);
          const size = Number(args[1]);
          const reservation = scratch.pop();
          if (
            !reservation
            || reservation.address !== address
            || reservation.size !== size
          ) throw new Error("non-LIFO exception scratch release");
          new Uint8Array(memory().buffer, address, reservation.aligned).fill(0);
          scratchTop = address;
          return 0;
        }
        default:
          return unhandled;
      }
    };
  }

  let parent;
  const parentReferenceCall = referenceCalls(() => parent);
  const parentRole = {
    call(descriptor, args) {
      if (descriptor.name === "__wpk_fork_frame_reserve") {
        const payload = nextPayload;
        nextPayload += (Number(args[0]) + 15) & ~15;
        frames.push({ payload, size: Number(args[0]) });
        return payload;
      }
      if (descriptor.name === "__wpk_fork_frame_commit") return;
      if (descriptor.name === "__wpk_fork_frame_next") {
        throw new Error("parent capture must not enter replay");
      }
      if (
        descriptor.module === "kernel"
        && descriptor.name === "kernel_fork"
      ) {
        parent.exports.wpk_fork_unwind_begin(root);
        return 0;
      }
      const referenceResult = parentReferenceCall(descriptor, args);
      if (referenceResult !== unhandled) return referenceResult;
      return 0;
    }
  };
  parent = new WebAssembly.Instance(module, importsFor(module, parentRole));
  try {
    parent.exports.run();
  } catch (error) {
    if (!(error instanceof WebAssembly.Exception)) throw error;
  }
  if (parent.exports.wpk_fork_state() !== 1) {
    throw new Error("fixture did not unwind from fork");
  }
  if (frames.length !== 1) {
    throw new Error(`expected one activation frame, got ${frames.length}`);
  }
  const parentMemory = parent.exports.memory;
  if (!(parentMemory instanceof WebAssembly.Memory)) {
    throw new Error("instrumented fixture did not export its staging memory");
  }
  const selector = new DataView(parentMemory.buffer)
    .getUint32(frames[0].payload + 8, true);
  if (selector !== expectedSelector) {
    throw new Error(
      `expected dynamically latest selector ${expectedSelector}, got ${selector}`,
    );
  }
  const vectorId = new DataView(parentMemory.buffer)
    .getUint32(frames[0].payload + 12, true);
  if (expectedRecipe < 0) {
    if (vectorId !== 0) {
      throw new Error(`unexpected reference vector ${vectorId}`);
    }
  } else {
    const vector = referenceVectors.get(vectorId);
    if (
      !vector
      || vector.expected !== 1
      || vector.recipes.length !== 1
    ) {
      throw new Error(
        `expected one pooled exception recipe, got ${
          JSON.stringify(vector ?? null)
        }`,
      );
    }
    const recipe = vector.recipes[0];
    if (expectedRecipe === 0 && recipe !== 0) {
      throw new Error(
        `scalar catch retained superseded exception recipe ${recipe}`,
      );
    }
    if (expectedRecipe > 0 && recipe === 0) {
      throw new Error("selected recipe catch encoded a null exception");
    }
  }
  parent.exports.wpk_fork_unwind_end();

  let child;
  const childReferenceCall = referenceCalls(() => child);
  let nextFrame = 0;
  const childRole = {
    call(descriptor, args) {
      if (descriptor.name === "__wpk_fork_frame_next") {
        const frame = frames[nextFrame++];
        if (!frame) throw new Error("child requested an unexpected frame");
        return frame.payload;
      }
      if (descriptor.name === "__wpk_fork_frame_reserve") {
        throw new Error("child replay must not reserve a continuation frame");
      }
      if (descriptor.name === "__wpk_fork_frame_commit") {
        throw new Error("child replay must not commit a continuation frame");
      }
      if (
        descriptor.module === "kernel"
        && descriptor.name === "kernel_fork"
      ) {
        if (child.exports.wpk_fork_state() !== 2) {
          throw new Error("child did not reach fork while replaying");
        }
        child.exports.wpk_fork_rewind_end();
        return 7;
      }
      const referenceResult = childReferenceCall(descriptor, args);
      if (referenceResult !== unhandled) return referenceResult;
      // Unused codecs and module-state helpers have no state in these
      // focused fixtures.
      return 0;
    }
  };
  child = new WebAssembly.Instance(module, importsFor(module, childRole));
  const childMemory = child.exports.memory;
  if (!(childMemory instanceof WebAssembly.Memory)) {
    throw new Error("fresh child did not export memory");
  }
  new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
  child.exports.wpk_fork_rewind_begin(root);
  child.exports.run();
  if (nextFrame !== frames.length) {
    throw new Error(`child consumed ${nextFrame}/${frames.length} frames`);
  }
  const replayResult = new DataView(childMemory.buffer).getInt32(4096, true);
  if (replayResult !== expectedResult) {
    throw new Error(
      `fresh child replay produced ${replayResult}, expected ${expectedResult}`,
    );
  }
}

for (const name of [
  "sequential",
  "nested",
  "reentered",
  // The selector deliberately remains nonzero in these two cases. Their fork
  // call is after the selected try_table has completed, so the structured
  // switch dispatcher must skip that obsolete throw stub in the fresh child.
  "inner-latest",
  "nested-recipe",
  "scalar-supersedes-recipe",
  "merged-normal",
]) {
  const [selector, result, recipe] = readFileSync(
    new URL(`./${name}.expect`, import.meta.url),
    "utf8",
  ).trim().split(/\s+/).map(Number);
  try {
    captureAndReplay(
      new URL(`./${name}.wasm`, import.meta.url),
      selector,
      result,
      recipe,
    );
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
"#,
    )
    .expect("write Node test");

    let output = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node catch-selector lifetime test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
