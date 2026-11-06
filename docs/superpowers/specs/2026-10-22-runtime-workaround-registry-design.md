# Runtime workaround registry — design

Date: 2026-10-22. Status: approved by the maintainer 2026-10-22.

## Intent

Kandelo works around defects and missing features in the runtimes it runs
on — browser engines (WebKit/JavaScriptCore, Chromium/V8, Firefox/SpiderMonkey),
Node.js and Bun — and in the toolchains it builds with (LLVM/Clang, wasm-ld,
Binaryen's wasm-opt, Rust). "Runtime" in the names below covers both. Today those workarounds are scattered: two ad-hoc comment tags
(`[JSC-TERMINATE-ATOMICS-WAIT-LEAK]`, `[WEBKIT-AUDIOWORKLET-CLOSE-LEAK]`), one
dedicated doc (`docs/jsc-terminate-atomics-wait-workaround.md`), notes in
`docs/browser-support.md`, and untagged comments. Nobody can list them, nobody
re-checks whether the underlying bug still exists, and upstream reports depend
on someone remembering.

The maintainer wants to stop roughly weekly and file upstream bug reports by
hand. This registry makes that session fast and honest:

- every workaround is listed in one place and found from its code sites;
- every claim that a runtime is at fault is backed by a **minimal, standalone
  reproduction** that runs without Kandelo;
- those reproductions run regularly with the test suites, so the claim stays
  checked, and so we learn when a runtime fix makes a workaround removable.

The minimal-repro rule exists to keep conclusions honest. Until a defect
reproduces without Kandelo, it is only *suspected*, and the first job is to
find out whether the fault is actually Kandelo's.

## Goals

1. One greppable tag at every code site of a runtime workaround.
2. One entry per workaround, holding everything needed to understand it, file
   it, and retire it, including sites where an inline comment is impossible.
3. A standalone reproduction per confirmed entry, usable both as the upstream
   bug's test case and as a regularly-run check.
4. A command that collects all workarounds and reports which are ready to file,
   which need a reproduction, which are filed, and which may be retirable.
5. A check that keeps tags and entries consistent.
6. An agent skill that prepares the weekly pass and keeps entries honest.
7. Documentation of all of the above in the repo's normal guidance.

## Non-goals

- Filing reports automatically. Reports are filed by a person, with a
  reproducible test case, unless an entry records that the upstream project
  accepts automated or agent reports through a sanctioned channel.
- Tracking Kandelo's own gaps or temporary hacks. Those stay in
  `docs/posix-status.md` and ordinary issues.
- Tracking runtime features that are absent and not planned (for example raw
  sockets in browsers). Those remain documented boundaries in
  `docs/browser-support.md`.
- Test-tooling or ported-package defects (Playwright, upstream packages).
  *My call*: out of scope; packages have their own patch rules, and test
  tooling is not something Kandelo or its users run on. Toolchain defects
  are in scope (maintainer's decision).
- Deliberate runtime design choices that Kandelo is built around and that are
  not expected to change, such as JavaScriptCore charging a shared memory's
  declared maximum up front. *My call*: these are boundaries documented in
  `docs/browser-support.md` and `CLAUDE.md`, not entries. They become entries
  only if the runtime announces a change.

## Anti-goals (would make this a failure even if it "works")

- An entry that blames a runtime without a reproduction that excludes Kandelo.
- A reproduction that quietly depends on Kandelo code, builds, or images.
- A check that can pass while a tagged site has no entry, or an entry has no
  site.
- Agents filing or commenting on upstream trackers on their own.
- Reproductions whose result changes and nobody notices.

## Scope: what gets an entry

An entry is a place where Kandelo behaves differently, or does extra work,
**because an outside runtime or toolchain is wrong or incomplete, and the
difference is meant to go away**. Two kinds:

- **bug** — the runtime violates a specification or its own documented
  behaviour (the JSC GC-helper deadlock, the JSC `terminate()` leak, the WebKit
  AudioWorklet close leak).
- **gap** — the runtime has not yet shipped a specified or announced feature
  that Kandelo will use when it does (for example a WebAssembly proposal one
  engine has not shipped). The "repro" for a gap is a feature probe.

## Entry lifecycle

| Status | Meaning | Required |
|---|---|---|
| `suspected` | We work around something we believe is a runtime defect, but it does not yet reproduce without Kandelo. | Evidence so far; what would distinguish a Kandelo bug from a runtime bug; code sites. Never appears in the filing list. Docs and comments must say "suspected". |
| `confirmed` | A standalone repro **judges itself** and reproduces it on named runtime versions, so it runs in the suite. | Repro; observed versions. Appears in the filing list. |
| `reported` | Filed upstream. | Upstream URL(s), date, who filed. |
| `fixed-upstream` | The repro no longer reproduces on some released runtime version. | Version(s) where fixed; what still needs the workaround (older supported versions). |
| `retired` | The workaround is removed. | Removal commit. The entry stays, so the history is searchable; its tag no longer appears in code. |

A `suspected` entry whose investigation shows the fault is Kandelo's is closed
(status `retired`, reason "Kandelo defect", with the fix or issue link).

**Starting statuses come from evidence at migration time, not from earlier
prose.** Each migrated entry's repro is run during the migration and its
`observed` records filled from that run; the status follows the table above.
Known facts that bear on this:

- WebKit `TextDecoder` crash (#1562) — no standalone reduction: `suspected`.
  Its docs and comments are reworded from "WebKit bug" to "suspected WebKit
  defect".
- WebKit AudioWorklet close leak — the maintainer's notes record that a
  reduced page did not reproduce it: `suspected` unless a reduction succeeds.
- JSC terminate leak — the maintainer's notes record that it stopped
  reproducing on Playwright WebKit build 2336; Bun and released Safari are
  unrecorded. Its status is decided by running its repro on each target (see
  "Versions"), and it may enter as a retirement candidate. *My call*: its
  draft upstream report, now outside the repo in the maintainer's notes, is
  copied into `entry.md`.
- JSC blocked-worker GC starvation (#1562) — the standalone page reproduces
  the pinned helper threads, but only a stack sample shows it, and the page
  does not freeze on its own. It enters `suspected` with that page as
  evidence, and becomes `confirmed` only if a self-judging signal is found
  (for example a collection or `FinalizationRegistry` callback in another
  worker that never completes while the helpers are pinned). Its #1562 docs
  and comments are reworded to "suspected" accordingly.

## Layout

```
tests/runtime-workarounds/
  README.md                        how the registry works (human + agent guide)
  <ID>/
    entry.md                       the entry (template below)
    entry.toml                     machine-readable fields
    repro/                         standalone reproduction (no Kandelo imports)
      ...                          e.g. repro.html + worker.js, or repro.mjs
```

`tests/` is used because the reproductions are tests run with the suites.

**IDs.** Upper-case, hyphenated, prefixed by the runtime, engine or tool
(`LLVM-`, `WASM-LD-`, `BINARYEN-`, `RUST-` for toolchains):
`JSC-BLOCKED-WAIT-GC-STARVATION`, `JSC-TERMINATE-ATOMICS-WAIT-LEAK`,
`WEBKIT-AUDIOWORKLET-CLOSE-LEAK`, `WEBKIT-TEXTDECODER-WRAPPER-CRASH`. Existing
IDs are kept.

**`entry.toml`** (the exact schema is the builder's; these fields are required):

- `id`, `kind` (`bug`/`gap`), `status`, `runtimes` (affected engines/runtimes),
- `summary` (one line),
- `observed` — list of `{ runtime, version, reproduced: bool, date }`,
- `upstream` — list of `{ project, url, filed, filed_by }` (empty until filed),
- `reports` — `human-only` (default) or `agents-allowed` with the sanctioned
  channel named,
- `repro` — how to run it (runner kind and target runtimes), absent only while
  `suspected`,
- `sites_without_tags` — non-comment locations (build flags, generated files,
  JSON, binary fixtures), each with a sentence on what it does.

**`entry.md`** sections: the defect in plain words; why Kandelo is affected; the
workaround and its cost; evidence (measurements, samples); how we know it is
not Kandelo's fault (or, if suspected, what is still unknown); the draft
upstream report (title, summary, steps, expected/actual, attachments = the
repro); removal criteria.

## The tag

Inline, in whatever comment syntax the file uses:

```
// [RUNTIME-WORKAROUND: JSC-BLOCKED-WAIT-GC-STARVATION] <why this line exists>
```

One literal prefix, `RUNTIME-WORKAROUND:`, so a single search finds every site
in every language. The surrounding comment still explains *why* (repo rule:
document why). Existing bare tags (`[JSC-TERMINATE-ATOMICS-WAIT-LEAK]`,
`[WEBKIT-AUDIOWORKLET-CLOSE-LEAK]`) are rewritten to this form.

Sites where a comment is impossible are listed in `sites_without_tags`.

## Reproductions

- **Standalone.** A reproduction imports nothing from the Kandelo tree and needs
  no Kandelo build or image. Third-party test tooling (Playwright) runs it but
  is not part of it. Someone at an upstream project can run it from the
  directory alone, so it can be attached to a bug report as is.
- **Minimal.** The smallest program that still shows the defect. When the
  minimal form needs a large input (for example a big Wasm module), it is
  generated by the repro, not copied from Kandelo artifacts.
- **Self-judging (maintainer's decision).** A repro that needs a manual
  observation step, such as taking a stack sample, keeps its entry
  `suspected`: it is kept in `repro/` as evidence, but it neither qualifies
  the entry for filing nor runs in the suite. Only a self-judging repro makes
  an entry `confirmed`. The repro reports a machine-readable verdict:
  `reproduced` (defect present), `not-reproduced`, or `inconclusive`
  (e.g. timed out before the condition could be observed), with details.
  Probabilistic defects declare attempts and a threshold.
- **Targets.** A repro declares the runtimes it applies to: Playwright engines
  (`chromium`, `firefox`, `webkit`), `node`, `bun`, or a toolchain tool
  (`clang`, `wasm-ld`, `wasm-opt`, `rustc`). A toolchain repro is a small
  input plus the exact command, run with the dev shell's pinned tool; its
  verdict comes from the tool's output or from running the result. Its
  `observed` version is the tool's version. Native Safari / iOS are not
  automated; their results are recorded by hand in `observed`.
- **Versions.** *My call*: an `observed` record is keyed by runtime or tool,
  its version or build, **and host OS** (Playwright's WebKit differs between macOS
  and Linux, and a defect can be OS-specific). The suite compares a run only
  with records for the same runtime and OS. A `not-reproduced` result on a
  Playwright build or a development runtime only flags an entry as *possibly
  retirable*; `fixed-upstream` requires a released runtime version (Safari,
  Bun, Node, a stable Chrome or Firefox, or a released toolchain version)
  observed not reproducing, recorded by
  the suite or by hand.
- **Gaps** use a feature probe as the repro: `reproduced` means "still missing".

The GC-starvation page under `.context/webkit-gc-repro/` (outside git; it
must be copied in) currently proves its point only through stack samples. The
builder makes a bounded attempt to give it a self-judging signal; if none is
found, the entry stays `suspected` and the attempt is recorded in `entry.md`.

The JSC terminate leak's existing page
(`apps/browser-demos/public/terminate-atomics-test.html`, also used by an app
test) moves or is copied into its entry's `repro/`; the builder decides which
without breaking that app test.

## Running reproductions with the suites

A new suite runs every non-suspected repro on each declared runtime and compares
the verdict with the entry's expectation:

- verdict matches the latest `observed` record for that runtime → pass;
- a `confirmed`/`reported` bug **no longer reproduces** → the run fails with a
  plain message ("JSC-…: no longer reproduces on webkit 2360; update the entry
  — candidate for fixed-upstream/retirement"). *My call*: fail rather than warn,
  because the registry is only honest if someone records the change; the
  failure is fixed by editing the entry, not the code.
- `inconclusive` → reported, not a failure.

It is exposed as a group of the existing runner
(`bash scripts/ci-run-test-suite.sh runtime-workarounds`) and documented in
`docs/agent-guidance/validation.md`'s suite table. It runs locally like the
other suites; whether it also runs in hosted CI follows the repo's current CI
policy and is not decided here.

## Collecting and checking

A Rust xtask command (repo default for new tools):

- `cargo xtask runtime-workarounds list` — the weekly report, grouped:
  1. **Ready to file**: `confirmed`, repro present, not yet reported (draft
     report path, repro path, observed versions);
  2. **Filed**: `reported`, with URLs, and whether the last suite run still
     reproduced;
  3. **Possibly retirable**: `fixed-upstream`, or reported bugs whose last run
     did not reproduce;
  4. **Needs reduction**: `suspected`, with what is unknown;
  5. **Gaps**: by runtime.
- `cargo xtask runtime-workarounds check` — runs in the always-run
  `cargo-xtask` suite group, so a mismatch blocks merges wherever that suite
  does (*my call*). It fails when: a tag names an unknown
  ID; a non-retired entry has neither a tag nor a `sites_without_tags` item; a
  retired entry still has tags; a `confirmed`+ entry has no repro; required
  fields are missing; an untagged legacy form of a known ID (`[ID]` without the
  prefix) remains. This runs with the existing source checks.

Whether `list` reads the last suite results from a file the suite writes, or
only from `observed`, is the builder's call.

## Agent skill

`.claude/skills/tracking-runtime-workarounds/SKILL.md` (with the
`.agents/skills/` link the repo uses). Triggers: adding or changing code that
works around a runtime; claiming in docs, comments or a PR that a runtime is at
fault; preparing the weekly upstream pass.

It tells the agent to:

- open an entry and tag the sites whenever it adds a runtime workaround; start
  at `suspected` unless it has a standalone repro;
- try first to show the fault is Kandelo's before concluding otherwise, and
  word anything unreduced as "suspected";
- for the weekly pass: run `check`, the repro suite and `list`; attempt
  reductions for `suspected` entries; refresh draft reports; flag possible
  retirements; **never** file, comment on, or vote on upstream trackers unless
  the entry says `agents-allowed`; hand the maintainer the list.

Per `evals/agent-skills/README.md`, the skill is kept only if it wins its eval:
add tasks for it to `tasks.json` and its name to `SKILLS` in `run.py`, and the
skill must pass `.claude/skills/tests/test_skills.py`. If it does not win, the
README and xtask stand on their own and the skill is dropped.

## Documentation changes

- `tests/runtime-workarounds/README.md` — the authoritative how-to.
- `CLAUDE.md` Platform Values / Debugging contract: one rule — a runtime
  workaround needs a registry entry and tag, and blame needs a standalone
  repro; link the README.
- `docs/agent-guidance/debugging-and-posix.md` (and host-runtime where
  relevant): how to tell a runtime defect from a Kandelo defect, pointing to
  the registry.
- `docs/agent-guidance/validation.md`: the new suite.
- `docs/browser-support.md` and `docs/jsc-terminate-atomics-wait-workaround.md`:
  keep user-facing explanations, link to entries; the latter's upstream and
  removal details move into its entry (builder decides whether the old doc
  stays as a redirect).

## Migration (part of this project)

1. `JSC-TERMINATE-ATOMICS-WAIT-LEAK` — confirmed/reported? (doc names WebKit
   bugs 278866 and 250569 as related, and a draft report not yet filed).
2. `WEBKIT-AUDIOWORKLET-CLOSE-LEAK` — needs a standalone repro; status per
   what exists.
3. `JSC-BLOCKED-WAIT-GC-STARVATION` — the #1562 hang (confirmed).
4. `WEBKIT-TEXTDECODER-WRAPPER-CRASH` — the #1562 crash (suspected); reword
   its docs and comments.
5. An audit of the ~50 other "workaround" mentions in source: each is either
   tagged into an entry (if in scope), or left alone; the audit result is a
   short list in the PR, not silent edits.

## Sequencing (my call)

Two of the tags live in `libc/glue/channel_syscall.c`, whose contents are part
of every package's cache key: rewriting even a comment there rebuilds every
package and image. The #1562 branch (ABI 52) already rebuilds everything, so
the `channel_syscall.c` tag rewrite goes into that branch before it is
validated and merged, and the registry work lands as a follow-up PR stacked on
it. Making cache keys ignore comments is out of scope.

## Constraints

- Repo contracts in `CLAUDE.md` apply: document why; honest failure; Node/browser
  parity; Rust for new tooling; `Area: Purpose` commit subjects.
- Reproductions must run with tools already declared in the dev shell.
- Building or running repros must not require network access beyond what
  Playwright browsers already need locally.

## Left to the builder

- Exact `entry.toml` schema and the xtask's internal design.
- How each repro judges itself and how the runner drives each runtime.
- Whether `list` consumes saved suite results.
- Whether old docs remain as redirects.
- Sequencing of the migration commits.
