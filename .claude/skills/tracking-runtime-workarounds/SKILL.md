---
name: tracking-runtime-workarounds
description: Use when adding or changing code that works around a browser engine, JavaScript runtime, or toolchain defect; when claiming a runtime is at fault in code, docs, or a PR; or when preparing the weekly upstream bug-filing pass.
---

# Tracking Runtime Workarounds

## Overview

Saying "WebKit has a bug" blames someone else's software. Kandelo only makes that claim when a small reproduction with no Kandelo code shows it and judges itself. Until then the defect is *suspected*, and the first job is to find out whether the fault is Kandelo's. Every workaround gets one registry entry under `tests/runtime-workarounds/`, so it can be found, re-checked, and removed. The authoritative guide is `tests/runtime-workarounds/README.md`; read the section you need by heading (`rg -n '^#'`, then those lines), not the whole file.

## When you add a workaround

1. Ask whether it belongs in the registry: README "What gets an entry". Kandelo's own gaps, unplanned runtime features, test-tooling defects and package defects do not.
2. Try to show the fault is Kandelo's before blaming a runtime: README "Runtime defect or Kandelo defect?". Syscall semantics, host lifetime and ownership, ABI drift and stale artifacts come first.
3. Copy `tests/runtime-workarounds/_template/` to `tests/runtime-workarounds/<ID>/` (IDs start with the runtime or tool, such as `JSC-`). See README "Adding an entry".
4. Start the entry at `suspected`. Only a standalone, self-judging reproduction that has actually reproduced the defect on a named runtime version supports `confirmed` (README "Statuses"). A reproduction that only fails inside Kandelo is evidence, not a reproduction.
5. Tag every code site in a comment, in the file's own comment syntax, with exactly `[RUNTIME-WORKAROUND: <ID>]` followed by why the line exists. Sites that cannot hold a comment go in `sites_without_tags`. Show the tag in this exact form only, since `check` rejects other bracketed variants (README "The tag").
6. Word anything unreduced as "suspected" in code comments, docs and PR text. Do not write "WebKit bug" or "the engine leaks" for a suspected entry.
7. If the reproduction creates shared memory or Wasm instances (`new WebAssembly.Memory({ shared: true })`, `new WebAssembly.Instance`, `WebAssembly.instantiate`), the kernel-memory ownership audit in `host/test/kernel-scratch-contract.test.ts` reports each such line as an unreviewed finding, because it audits every runtime source in the tree, reproductions included. Add one reviewed entry per line to `auditAllowances` there, like the existing `tests/runtime-workarounds/` entries: `disposition: "non-kernel"`, `authorityOwner: "shared-memory"`, and a `why` that says the reproduction contains no Kandelo code. Print the exact keys with `KANDELO_DEBUG_SCRATCH_AUDIT=keys` (README "Adding an entry").
8. Run `check` (and `run --id <ID>` for an entry past `suspected`), then link the entry from the user-facing explanation, usually `docs/browser-support.md`.

## Commands

Run from the repository root:

```bash
scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- runtime-workarounds check'
scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- runtime-workarounds list'
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh runtime-workarounds
```

`run` takes `--id` and `--target`; the suite wraps `run` plus the driver tests. Details: README "Commands".

## The weekly pass

README "The weekly pass" is the procedure. In short:

1. Run `check`, the `runtime-workarounds` suite, then `list`.
2. For each *Ready to file* entry, reread the draft report in `entry.md` against the latest run and refresh the observed versions.
3. For each *Needs reduction* entry, try once more to reduce it, or to show the fault is Kandelo's.
4. For each *Possibly retirable* entry, flag it. Only a released runtime version that no longer reproduces supports `fixed-upstream`.
5. Hand the maintainer the `list` output with the refreshed drafts.

**Never file, comment on, or vote on upstream trackers** unless the entry has `reports = "agents-allowed"` with a named `reports_channel`. Otherwise a person files, with a reproduction they have run, and then records the `upstream` entry.

## Feedback

End your final report with one line, so maintainers can see where this skill helped or misled:
`Skill feedback (tracking-runtime-workarounds): used <what>; wrong: <what or none>; missing: <what or none>`
