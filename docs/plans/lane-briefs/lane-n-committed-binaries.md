# Lane N — committed binaries without producers

Paste everything below into a fresh agent.

---

You are working **lane N (committed binaries)** of the Kandelo Rust-first
campaign. Always call it by its label, not just the letter.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-lane-n \
        -b brandonpayton/lane-n-committed-binaries brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-lane-n

Work **only** in that worktree, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger.

## Your gate

`committedBinariesWithoutProducer` **15 → 0**.

The surface counts two things, and you must keep both working: binaries with
no entry in `docs/committed-binaries.json`, **and** declared producers that no
longer exist on disk. The second half is what stops the register rotting into
a list of promises.

## The policy this enforces

The maintainer's standing words: *"I don't want any binaries committed to the
repo unless we hand-compiled them. Everything else should be generated since
it needs to change along with the project source code."*

Lane L applied that once and took the repository from **58 committed binaries
to 15**. This lane makes it enforceable rather than a thing someone remembers.

## What the 15 are, measured 2026-09-14

- **13 under `crates/fork-codec/testdata/`** — not 14; lane L already removed
  `reference-recipes-wasm32.bin`. Twelve have a `gen-<name>-fixture.mts`
  producer.
- **2 orphans with no live producer**: `dylink-archive-wasm32.bin` and
  `rtfs-v3-lazy.bin`.

The characterization that proposed this lane had the count wrong **twice**.
Re-measure before you plan; do not trust the prose, including this brief.

## Sequencing that avoids a conflict of interest

N1–N3 — classify each artifact and declare its producer — touch `docs/` and
`scripts/` almost exclusively and collide with nobody.

**N4 is the fate of the two orphans, and it goes last.** Agree it with lanes
F (fork inversion), V (VFS / one SFFS) and Y (image builders, now closed)
before acting: those fixtures guard code those lanes are removing. This lane
is deliberately **not** lane F's for exactly that reason — F would be deciding
the fate of fixtures guarding the code it deletes.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root
  form fetches an unpinned vitest.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
- **Perturb every new guard until you have seen it fail** and quote the failure
  text. For this lane the perturbations that matter are: delete a declared
  producer from disk (must fail), and add an undeclared binary (must fail).
  A register that cannot fail is a document, not a gate.
- Guest fixtures are built from source, not committed. If you find yourself
  writing a `.bin` into the tree, you are on the wrong side of this lane.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- **Deferrals are the maintainer's call.** Land the safe part, then stop and
  argue it — what, why, cost, follow-up — and ask. Never self-defer.

## Provisioning gotchas, learned the hard way 2026-09-14

- Export `CARGO_NET_OFFLINE=true` for `./run.sh setup`.
- **Gate on exit codes, never on piped output.** `./run.sh setup | tail` hands
  you `tail`'s status and will report success for a failed build.
- The build is GREEN as of 2026-09-15: `./run.sh setup` reaches real exit
  code 0 and `"outcome":"succeeded"`, and the browser suite runs to
  completion at 164 passed / 14 failed — all fourteen on the documented
  pre-existing list. If you see a build failure, it is probably yours.
  Three blockers were cleared today and each hid the next: B40 (a GNU
  redirector serving 404s, fixed by a mirror list), B43 (the Xcode
  licence), and B44 (Xcode 27's `libSystem.tbd` being unreadable by the
  pinned LLVM, fixed by building SpiderMonkey's host tools inside Nix).

## When you have something to merge

Write a merge handoff into the master plan naming: the exact SHA and branch,
the conflicts you hit and the resolution you **tested**, the suites you ran
with their numbers, and what you did **not** establish.
