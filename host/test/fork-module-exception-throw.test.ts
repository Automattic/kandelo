import { describe, expect, it } from "vitest";

import { FORK_ACTIVATION_DRIVE_BINDINGS } from "../src/fork-module-backend";
import {
  CAPTURE_KIND_EXNREF,
  INTERN_KIND_I31,
  captureGraph,
  fixture,
  saveSlotThunk,
} from "./fork-module-capture-fixture";

/**
 * The cross-activation exception throw, driven end to end.
 *
 * `__wpk_fork_ref_exn_broker_throw_recipe` was the last member of the host
 * floor. A guest replaying an `exnref` whose tag it does not own asks for the
 * exception to be raised; only the activation whose codec DECLARED that tag can
 * raise it with the right tag, and neither the module nor a JavaScript import
 * can do it for them -- a JS `throw` crosses back as a foreign exception the
 * guest's `try_table` will not catch. Neither has to throw, though: both can
 * CALL a guest export that throws. The module does it through a drive slot.
 *
 * Census 192 recorded this path as ARGUED BUT UNEXERCISED. Its refusals were
 * gated against the real artifact and its slot arithmetic exhaustively in
 * `fork-module-inject`, but nothing drove a SUCCESSFUL throw: no fixture built
 * a sealed graph with a second activation owning an exnref recipe. This is that
 * fixture.
 *
 * The thrower doubles are `(i32) -> ()` wasm functions over a JavaScript body,
 * the same shape the drive table already holds for save and unwind. What they
 * raise is a JavaScript error rather than a tagged wasm exception -- a real
 * guest's `__wpk_fork_ref_exn_throw_recipe` raises the tag -- and the
 * difference does not touch what is under test here: WHICH activation the
 * module calls, with WHAT recipe, and whether the raise propagates out of the
 * module's frame instead of being swallowed.
 */

const PID = 8181;
const OWNER = 1;
const PAYLOAD_I31 = 44;

const THROW_SLOT = FORK_ACTIVATION_DRIVE_BINDINGS.find(
  (binding) => binding.name === "__wpk_fork_ref_exn_throw_recipe",
)?.slot;

/** Bind one activation's thrower, recording every call it receives. */
function bindThrower(
  f: ReturnType<typeof fixture>,
  activation: number,
  raise: boolean,
): number[] {
  const calls: number[] = [];
  const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
  const thunk = saveSlotThunk((recipe) => {
    calls.push(recipe);
    if (raise) throw new Error(`activation ${activation} raised ${recipe}`);
  });
  f.instance.driveTable.set(base + THROW_SLOT!, thunk as never);
  return calls;
}

describe("the module raises an exception inside the activation that owns it", () => {
  it("binds the thrower at the slot the drive table assigns it", () => {
    // Read from the binding table rather than written as 15: the slot is the
    // one number that makes the module call a plausible WRONG guest export
    // with an argument of the right type, and nothing traps when it does.
    expect(THROW_SLOT, "the drive table must bind a thrower").toBeTypeOf("number");
  });

  it("calls the OWNING activation's thrower, with the recipe, and lets it out", () => {
    const f = fixture();
    const x = f.x as Record<string, (...a: number[]) => number>;

    // An exnref captured by activation 1, in a worker where activation 0 also
    // has a thrower bound. Activation 0 is the one a module that ignored the
    // owner would reach: it is the primary, and its slice is first in the
    // drive table.
    const { root, aggregateRecipes } = captureGraph(
      f,
      [[INTERN_KIND_I31, PAYLOAD_I31, 0]],
      [
        {
          kind: CAPTURE_KIND_EXNREF,
          activation: OWNER,
          typeOrdinal: 0,
          layoutId: 0,
          edges: ({ leaves }) => [leaves[0]!],
        },
      ],
      { sideActivations: [OWNER] },
    );
    const recipe = aggregateRecipes[0]!;

    const wrongActivation = bindThrower(f, 0, true);
    const owningActivation = bindThrower(f, OWNER, true);

    x.fm_begin_reference_replay(root, PID);
    expect(f.errno(), "the replay begins").toBe(0);

    // THE RAISE PROPAGATES. A module that swallowed it would let the guest
    // continue past an exception it never delivered, which is the silent
    // corruption this whole path exists to prevent.
    expect(() => x.__wpk_fork_ref_exn_broker_throw_recipe(recipe)).toThrow(
      new RegExp(`activation ${OWNER} raised ${recipe}`),
    );

    expect(owningActivation, "the owner's thrower ran, with this recipe").toEqual([
      recipe,
    ]);
    expect(
      wrongActivation,
      "and no other activation's thrower was called",
    ).toEqual([]);
  });

  it("fails loud when the owner's thrower RETURNS instead of raising", () => {
    // A replay that continues past an exception it never delivered is silent
    // corruption, so returning normally is a defect rather than a no-op. The
    // module traps, having set EINVAL first -- there is no return value to
    // carry an error, because `fork-instrument` emits `unreachable` after this
    // call and the import is declared never to come back.
    const f = fixture();
    const x = f.x as Record<string, (...a: number[]) => number>;
    const { root, aggregateRecipes } = captureGraph(
      f,
      [[INTERN_KIND_I31, PAYLOAD_I31, 0]],
      [
        {
          kind: CAPTURE_KIND_EXNREF,
          activation: OWNER,
          typeOrdinal: 0,
          layoutId: 0,
          edges: ({ leaves }) => [leaves[0]!],
        },
      ],
      { sideActivations: [OWNER] },
    );
    const recipe = aggregateRecipes[0]!;
    const calls = bindThrower(f, OWNER, false); // returns instead of raising

    x.fm_begin_reference_replay(root, PID);
    expect(f.errno()).toBe(0);

    expect(() => x.__wpk_fork_ref_exn_broker_throw_recipe(recipe)).toThrow(
      WebAssembly.RuntimeError,
    );
    expect(calls, "the thrower was reached").toEqual([recipe]);
    expect(x.fm_last_errno(), "and the refusal says why").toBe(22);
  });
});
