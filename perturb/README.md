# Mutation trials

Specs for `xtask perturb`, which applies a source mutation, runs a verifier,
reverts, and reports. Run one with:

```sh
cargo run -q -p xtask -- perturb perturb/<spec>.json
```

## What a spec is for

Hazard H-2 says a guard that cannot fail is not a guard. These are the trials
that proved each guard in lane Y's image-builder work can fail — kept so the
proof survives the session that produced it, and so a future change that
quietly removes a guard is noticed rather than discovered later by a wrong
image.

A surviving mutant fails the run, because nearly always it means a missing
test. **Every trial here is expected to be KILLED**; a green run is the
contract.

## Accepted survivors are NOT encoded here

Three mutations in this work survive for reasons no test can remove, and they
are documented in the source next to the code rather than as always-red trials:

- `sm_alloc` dropping its `max(len, 1)` — the mutation is undefined behaviour
  that produces no observable wrong value.
- `sm_write_file` treating any `Ok` as success — the short-write branch is
  unreachable because `rootfs::write` never returns a short count; it defends a
  contract rather than an input.
- `chown` dropping its `-1` → `0xffff_ffff` mapping — behaviourally identical,
  because JavaScript coerces arguments to a wasm `u32` with ToInt32.

Encoding them here would make a committed spec permanently red, which teaches
people to ignore the gate. Keeping the reason beside the code keeps it where
the next reader already is.
