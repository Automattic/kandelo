// The externref CAPTURE seam, and the boundary that replaced the old gate.
//
// A live host externref has no type a guest codec can test, so it falls through
// every layout arm of `fork-instrument`'s `encode_anyref` to the module's
// cross-activation broker. That broker can only ask other activations' codecs,
// and none of them can ever claim a host reference -- so it refused, the
// guest appended recipe -1 into its reference vector, and the capture failed
// validation at seal, four layers from the cause (census section 188).
//
// It asks the host now: `__wpk_fork_host_externref_handle(externref) -> i32`,
// the exact reverse of `resolve_externref`. One direction brings a handle back
// to life in a child; the other says which handle names a live value so a
// parent can record it.
//
// WHY THIS TEST IS HERE RATHER THAN IN A FORKING PROGRAM. The refusal is
// real -- a reference the broker never minted answers 0 and is refused. Since
// the cross-worker host-import transport was removed, nothing mints broker
// handles for host values, so every raw host externref takes this path. The
// forking end-to-end tests that exercised the transport were deleted with it;
// stage E2 makes such a fork fail with EOPNOTSUPP on every host and will carry
// its own end-to-end test. This asserts the refusal at the seam itself.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { startChannelResponder } from "./fork-module-capture-fixture";

const EOPNOTSUPP = 95;
/** The channel base `fm_set_format` is handed: page 4, below the module. */
const CHANNEL_BASE = 4 * 65536;
/**
 * Where the responder hands out mappings from: above the module region at
 * 8 MiB (about 1.4 MiB) in a 16 MiB memory. WHY THERE IS A RESPONDER AT ALL:
 * interning a reference pushes onto a bump-backed set, and the bump heap has
 * no static floor any more -- its first allocation maps a chunk through this
 * channel, and `channel_syscall` parks in `memory_atomic_wait32` with no
 * deadline when nobody answers. This file hung the whole fork sweep that way
 * once. A harness that makes an ALLOCATING module call must have a responder.
 */
const MMAP_FLOOR = 12 * 1024 * 1024;
/** The staging slot `fork-instrument`'s codec encodes from. */
const CAPTURE_TRANSIT_SLOT = 0;

interface CaptureExports {
  fm_set_format: (...args: number[]) => void;
  fm_capture_begin: () => void;
  fm_last_errno: () => number;
  __wpk_fork_ref_gc_broker_encode: (slot: number) => number;
}

/**
 * A module with a capture open and one value staged where the guest's codec
 * would have left it, plus the host answer under test.
 */
function staged(
  value: unknown,
  handleFor: (value: unknown) => number,
): { x: CaptureExports; asked: unknown[] } {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const asked: unknown[] = [];
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory,
    ptrWidth: 4,
    reserve: () => 8 * 1024 * 1024,
    label: "externref capture seam",
    hostImports: {
      __wpk_fork_host_externref_handle: (asked_value: unknown) => {
        asked.push(asked_value);
        return handleFor(asked_value);
      },
    },
  });
  const x = fm.exports as unknown as CaptureExports;
  startChannelResponder({ memory, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR });
  x.fm_set_format(4, 0, 0, 0, CHANNEL_BASE);
  expect(x.fm_last_errno(), "the format seeds").toBe(0);
  // A capture must be OPEN for a recipe to be interned into anything.
  x.fm_capture_begin();
  expect(x.fm_last_errno(), "the capture opens").toBe(0);

  const transit = fm.gcTransitTable;
  if (transit.length < 1) transit.grow(1, null);
  transit.set(CAPTURE_TRANSIT_SLOT, value);
  return { x, asked };
}

describe("the externref capture seam", () => {
  it("interns a reference the host owns, asking for its handle exactly once", () => {
    const reference = { tag: "a host reference the broker minted" };
    const { x, asked } = staged(reference, () => 77);

    const recipe = x.__wpk_fork_ref_gc_broker_encode(CAPTURE_TRANSIT_SLOT);
    expect(x.fm_last_errno(), "the encode succeeds").toBe(0);
    expect(recipe, "and answers a real recipe").toBeGreaterThan(0);
    // The module must ask about the value the guest staged, not something it
    // manufactured: identity is the host's to answer and the module's to use.
    expect(asked).toEqual([reference]);
  });

  it("REFUSES a reference the host does not own, rather than inventing one", () => {
    const stranger = { tag: "never registered with the broker" };
    const { x, asked } = staged(stranger, () => 0);

    const recipe = x.__wpk_fork_ref_gc_broker_encode(CAPTURE_TRANSIT_SLOT);
    expect(recipe, "no recipe").toBe(-1);
    // EOPNOTSUPP, not EINVAL: this is a platform boundary -- the capture
    // cannot name this value -- not a malformed call. A recipe invented here
    // would decode in the child to something that was never the parent's.
    expect(x.fm_last_errno()).toBe(EOPNOTSUPP);
    expect(asked, "the host was asked").toEqual([stranger]);
  });

  it("answers 0 for an empty slot without asking the host at all", () => {
    // A cleared staging slot is one of the shapes "no host reference here"
    // takes, and asking the host to identify null would make it invent an
    // answer for a value that is not there.
    const { x, asked } = staged(null, () => {
      throw new Error("the host must not be asked about an empty slot");
    });

    expect(x.__wpk_fork_ref_gc_broker_encode(CAPTURE_TRANSIT_SLOT)).toBe(-1);
    expect(x.fm_last_errno()).toBe(EOPNOTSUPP);
    expect(asked).toEqual([]);
  });
});
