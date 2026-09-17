# The tier twin is the only kernel that isn't key-addressed

**Status: proposal, 2026-09-17.** Written, then rewritten twice, each time
because checking something the previous draft listed as unchecked changed what
it should say. The scope shrank at every step: from "invent a keyed route", to
"stop special-casing the kernel", to what is below — **one copy, in one
directory, is the exception, and the project already refuses that exception
everywhere else.**

The drafts are in the git history. The process is the point: each rewrite was
paid for by one `ls -l`.

## The answer to the question that prompted this

> *"Why is there a kernel.wasm that isn't named or addressed by cache key at
> all?"*

**In the main checkout, there isn't.** `/Users/brandon/src/kandelo/
local-binaries/kernel.wasm` is a **symlink** into
`.kandelo-local-generations/wasm32/kernel/<cache-key>/…/kandelo-kernel.wasm`.
Every ordinary package mirror is the same shape:
`local-binaries/programs/wasm32/gzip.wasm` is a symlink into
`.kandelo-local-generations/wasm32/gzip/<cache-key>/…/gzip.wasm`.

And the project **enforces** it. `scripts/pack-ci-test-workspace.sh` refuses to
pack a workspace whose `local-binaries/kernel.wasm` is a regular file, in these
words:

> *"these compatibility paths are package-owned mirrors, not anonymous scalar
> byte slots. Accepting a regular file would let a stale or concurrently
> replaced kernel artifact enter the portable workspace without a cache identity
> or publication claim."*

That is the thesis of this document, already written down, already enforced, a
year of commits before I asked the question.

**The exception is the tier twin.** `local-binaries/source-only-v1/kernel.wasm`
is a *copy*, not a link — 1,430,838 bytes of regular file with the key stamped
inside it as a `kandelo.build.key` custom section. It is the artifact that goes
stale, the one that needs an internal stamp, and the only reason
`verify_fresh_kernel_artifact` has to exist.

## Measured, 2026-09-17

| artifact | shape | key recorded as | freshness |
|---|---|---|---|
| `local-binaries/programs/wasm32/gzip.wasm` | symlink → generation | the directory it points into | structural |
| `local-binaries/kernel.wasm` (main checkout) | symlink → generation | the directory it points into | structural |
| `local-binaries/kernel.wasm` (both worktrees) | **absent**, and a kernel build does not create it | — | — |
| `~/.cache/kandelo/source-only/…/programs/kernel-0.1.0-rev1-wasm32-<key>/` | directory | **the directory name** | structural |
| `local-binaries/source-only-v1/kernel.wasm` | **copy** out of that cache | `kandelo.build.key`, inside the bytes | a stamp comparison |
| `local-binaries/fork_module32.wasm` | copy | `.build-key` **sidecar** | a third form; does not survive a copy |

**There are TWO key-addressed stores, not one**, and this document's earlier
drafts saw only the first. Packages live in the per-worktree generation store;
source-built artifacts like the kernel live in the **machine-wide source-only
cache**, whose paths are `kernel-0.1.0-rev1-wasm32-<key>` — key-addressed
already. Verified 2026-09-17 by building the kernel and watching it install to
`…/programs/.kernel-0.1.0-rev1-wasm32-ea67b4c3…`, the exact key the tree
resolves to.

**So the copy is a PROJECTION out of a keyed store, not an original.** That is
the whole finding in one line: the bytes are key-addressed where they are built
and stop being key-addressed where they are read.

Generations are live: bzip2, git, nginx, redis, vim, wget and less all have
directories written on Sep 16. The kernel's 21 are all dated `2026-09-12
10:53:36` — and **a successful `./run.sh build kernel` on 2026-09-17 added
none**. It published into the machine-wide source cache and projected a copy
into the tier, leaving both the generation store and the root mirror untouched.
So the kernel is not "missing from" the generation scheme in these worktrees; it
does not participate in it here at all.

A detail worth keeping: inside those stored generations, **no directory name
matches the stamp in its own artifact** (`aded8633…` holds one stamped
`0c2a0675…`; three more sampled the same way; one has no stamp at all). The
directory is a package cache-identity key; the stamp is the SourceOnlyV1 cache
key. Two derivations of `manifest_cache_key_sha_for_policy` under different
`ResolvePolicy` values, in one place, with nothing reconciling them — which is
what an internal stamp buys you.

## Why the exception is the expensive one

**1. Two copies of one kernel have broken the build in BOTH directions, and
`local_build.rs` records each.**

* **2026-09-09 — the tier copy fresh, the root mirror stale.** A `./run.sh
  rebuild kernel` refreshed the SourceOnlyV1 projection and left the ambient
  `local-binaries/kernel.wasm` three days behind. `verify-fresh` was green,
  because it checked only the tier copy, while every host-native test failed on
  an import-type mismatch — `crates/host-native/src/lib.rs` loads the ambient
  path directly. The fix was to teach the gate about both names.
* **The other direction — the root mirror stale and SHADOWING the fresh tier
  copy.** A seven-hour-old symlink at `local-binaries/kernel.wasm` won over the
  freshly written `source-only-v1/kernel.wasm`, and `cargo test -p host-native`
  failed **39 of 53 against a tree where the build had just succeeded**. That
  one is recorded beside `source_only_output_root`, and its stated cause is that
  the writer and the two readers disagreed about which tier is authoritative.

**The failure is not "a copy goes stale". It is that whichever copy is stale
WINS, depending on which one the reader consults** — and the reader varies by
host, by test binary and by tier. One artifact reachable by one path cannot
produce either incident.

**2. The cheap provisioning path and the gate contradict each other**, and
`build_deps.rs` says so. Only the engine stamps `kandelo.build.key`, so an
artifact placed by `build-deps install-local-artifact` carries none, the gate
refuses it, and it points at the expensive path the reader was told to avoid.
The installer is right to refuse to stamp — its source is caller-supplied.
**The contradiction is a consequence of provenance living inside the bytes**,
and it does not arise for a link, where the claim is the path.

**3. It is stale here, now**, which is what blocks the browser cycle. No package
mirror is in that state, because a package mirror cannot be.

## The proposal

**Make the tier projection an indirection, exactly as the root mirror already
is**, and the stamp and its gate become unnecessary rather than improved.

1. `source-only-v1/kernel.wasm` resolves INTO the keyed store it is currently
   copied out of — the machine-wide source cache for the kernel, the generation
   store for packages — instead of copying. The store already exists and is
   already keyed; only the last hop copies.
2. `kandelo.build.key` and the `.build-key` sidecars stop being read for
   freshness. `verify_fresh_kernel_artifact`'s stamp comparison goes; its
   ABI-version check is independent and stays.
3. A worktree that has no kernel generation gets a **miss**, which the build
   fills — rather than a stale copy plus a gate that must notice.
4. `build-deps install-local-artifact` writes to an explicitly unkeyed slot used
   only under an opt-in flag, so the gate reports a *place* rather than a
   missing stamp, and the cheap path stops contradicting it.

**Symlink or index file — the one real design question.** The root mirror uses
symlinks and the packing script depends on that. The tier probably copies for a
reason: it is the namespace that gets packed and shipped, and a symlink farm may
be exactly wrong there. If so the answer is an index file (`<tier>/index.json`,
name → key) for the tier and symlinks for the root mirror, and **the difference
should be stated rather than inherited.** My earlier draft argued against
symlinks on portability grounds without noticing the project already relies on
them; that argument is withdrawn, and survives only as the narrower question of
whether a *packable* tier can hold links.

## What "packable" actually means

> **DEPRIORITIZED by the maintainer, 2026-09-17: *"Forget packability for now.
> We aren't even running CI right now."*** Everything below is accurate and was
> traced from the code, but it is not a live constraint today — the packing
> script only binds a workspace that CI actually packs. Recorded so a later
> reader does not treat it as blocking, and so whoever turns CI back on knows
> the constraint exists and where it is enforced.
>
> The practical effect: **while CI is not packing, a tier could link wherever it
> likes**, and the "index plus copy-on-pack" branch this document worried about
> is not currently needed at all.


`scripts/pack-ci-test-workspace.sh` copies `local-binaries/` into a staging
directory and ships it as a **self-contained CI workspace**. It then walks every
symlink under the staged tree and enforces three things:

* the target must resolve **inside `local-binaries/`** — the source root, the
  staged root, or a `.kandelo-local-generations/` namespace under one of them;
* absolute targets are **rewritten to relative** as they are packed;
* anything else is refused: *"staged local resolver link retains an external
  absolute target"*.

So packable means **the workspace survives being copied elsewhere and used
there**. Symlinks are not merely tolerated — the same script REQUIRES
`local-binaries/kernel.wasm` to be one and refuses a regular file in its place.

**THE CONSTRAINT IS WHERE THE STORE LIVES, NOT WHETHER THE TIER COPIES.**

| store | inside `local-binaries/`? | can a packable tier link into it? |
|---|---|---|
| `.kandelo-local-generations/` | yes | **yes** — it is packed along with the links |
| `~/.cache/kandelo/source-only/` | no | **no** — refused as an external absolute target |

**Which redirects the fix.** It is not "make the tier link" — for the kernel that
would point at the machine-wide source cache and be refused. It is **publish the
kernel into the in-repo generation store the way packages already are**, after
which the tier can link to it exactly as `local-binaries/kernel.wasm` already
does in the main checkout.

**STILL OPEN, and narrower than before:** the tier copies EVERYTHING, not just
the kernel. `source-only-v1/programs/wasm32/gzip.wasm` is a regular file while
`local-binaries/programs/wasm32/gzip.wasm` is a symlink into the store — so the
tier is a deliberately materialized namespace, and the reason for that is not in
the packing script. Until that reason is known, step 1 should not be rewritten
around links: a materialized tier may be load-bearing for provenance pinning in
a way this document has not established.

## Why this simplifies testing and releasing

- A test cannot get a stale kernel by accident: wrong key, different path,
  unreachable. The property every package mirror already has.
- The stamp comparison leaves test setup; a suite asks the resolver and gets an
  artifact or a miss.
- A release becomes a selection of keys. Provenance is the path, so it survives
  a copy — unlike a sidecar, which does not, and unlike a stamp, which needs a
  wasm parser to read.
- The 2026-09-09 class of bug cannot recur: there is one kernel, and it is
  wherever the link points.

## Costs

- **A consumer census is the first step.** `crates/host-native/src/lib.rs`,
  `scripts/build-rootfs.sh`, the browser build's `@binaries/` alias, and
  whatever else reads a tier path directly.
- **The store needs a prune policy** once it is load-bearing.
- **An index, if the tier needs one, must be written in the same atomic publish
  as the generation**, or it becomes a fourth thing that can disagree.
- **The existing kernel generations should be discarded, not migrated.** Their
  directory names do not match their stamps and one has no stamp.

## What I did not check

- ~~Whether the tier copies deliberately because it must be packable.~~
  **Answered from the code, 2026-09-17 — see "What packable actually means"
  below. The framing was wrong: packability constrains WHERE a link may point,
  not whether links are allowed.** What remains open is narrower and is stated
  there.
- ~~Why these two worktrees have no root kernel mirror, and whether the lane's
  stale kernel therefore has a cheap fix.~~ **Checked, and the answer is no.**
  The absence is if anything PROTECTIVE — with no root mirror there is nothing
  to shadow the tier copy, which is the second incident above. And the lane's
  kernel is stale for real rather than mislocated: the key its tree resolves to,
  `ea67b4c3…`, exists in no generation on this machine, so it has to be built.
  `./run.sh setup` remains the fix, as the campaign plan already said.
- **The full consumer census.**
