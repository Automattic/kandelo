# Runtime workaround registry

Kandelo runs on runtimes it does not control: the browser engines
(WebKit/JavaScriptCore, Chromium/V8, Firefox/SpiderMonkey), Node.js and Bun.
It is built with toolchains it does not control either: LLVM/Clang, wasm-ld,
Binaryen's wasm-opt and Rust. Below, "runtime" covers both. When one of them
is wrong or incomplete, Kandelo sometimes has to behave differently or do
extra work until the runtime is fixed. This directory is the one place that
lists every such workaround, keeps the evidence that the runtime (and not
Kandelo) is at fault, and re-checks that evidence with the test suites.

The registry exists for two reasons:

- **Honest blame.** Saying "WebKit has a bug" is a claim about someone
  else's software. The registry only accepts that claim when a small
  reproduction that contains no Kandelo code shows the defect and reports
  the result on its own. Until then the defect is only *suspected*, and the
  first job is to find out whether the fault is actually Kandelo's.
- **Workarounds that can be removed.** Each entry records how to tell that
  the runtime has been fixed. The reproductions run with the suites, so when
  a runtime release fixes a defect, a run notices and the workaround can be
  retired.

The maintainer files upstream bug reports by hand, roughly weekly. The
`list` command below prepares that session.

## What gets an entry

An entry is a place where Kandelo behaves differently, or does extra work,
**because an outside runtime or toolchain is wrong or incomplete, and the
difference is meant to go away.** There are two kinds:

- **bug**: the runtime violates a specification or its own documented
  behavior. Examples: a JavaScriptCore worker that `terminate()` does not
  reclaim; a WebKit AudioWorklet thread that outlives its closed context.
- **gap**: the runtime has not yet shipped a specified or announced feature
  that Kandelo will use when it does, such as a WebAssembly proposal one
  engine has not shipped. The reproduction for a gap is a feature probe.

These do **not** get an entry:

- Kandelo's own gaps and temporary hacks. Those belong in
  `docs/posix-status.md` and ordinary issues.
- Runtime features that are absent and not planned, such as raw sockets in
  browsers. Those are documented boundaries in `docs/browser-support.md`.
- Defects in test tooling (Playwright) or in ported packages. Packages
  follow their own patch rules (`docs/agent-guidance/packages-and-builds.md`),
  and test tooling is not something Kandelo or its users run on.
- Deliberate runtime design choices that Kandelo is built around and that
  are not expected to change, such as JavaScriptCore charging a shared
  memory's declared maximum up front. Those are boundaries documented in
  `docs/browser-support.md` and `CLAUDE.md`. They become entries only if the
  runtime announces a change.

## Statuses

| Status | Meaning | The entry must have |
|---|---|---|
| `suspected` | Kandelo works around something believed to be a runtime defect, but no standalone reproduction judges it yet. | The evidence so far, what is still unknown, what would tell a Kandelo bug from a runtime bug, and the code sites. Docs and comments must call it "suspected". It never appears in the filing list. |
| `confirmed` | A standalone reproduction judges itself and reproduces the defect on named runtime versions, so it runs in the suite. | At least one self-judging `[[repro]]`, and an `observed` record with `reproduced = true` for one of that repro's targets. |
| `reported` | Filed upstream. | Everything `confirmed` needs, plus `upstream` records (URL, date, who filed). |
| `fixed-upstream` | The reproduction no longer reproduces on a released runtime version. | An `observed` record for one of the entry's `runtimes` with `released = true` and `reproduced = false`, and in `entry.md` what still needs the workaround (older supported versions). |
| `retired` | The workaround is gone from the code. | `retired_reason`, and `retired_commit` when there is one. The entry stays so the history is searchable; its tag must no longer appear in code. |

A `suspected` entry whose investigation shows the fault is Kandelo's is
closed as `retired` with `retired_reason = "Kandelo defect: ..."` and a link
to the fix or issue.

A reproduction that does not reproduce on a Playwright build or another
development runtime only makes an entry *possibly retirable*. Only a
released runtime version (Safari, Bun, Node.js, a stable Chrome or Firefox,
or a released toolchain) that no longer reproduces supports
`fixed-upstream`.

## Layout

```
tests/runtime-workarounds/
  README.md          this guide
  driver.mjs         runs one reproduction on one target (used by `run`)
  driver.test.mjs    tests for the driver
  _fixtures/         driver test fixtures (directories starting with _ are not entries)
  _template/         copy this to start an entry
  <ID>/
    entry.toml       machine-readable fields, checked by `check`
    entry.md         the explanation, evidence and draft upstream report
    repro/           standalone reproduction (no Kandelo code)
```

The reproductions are tests run with the suites, which is why the registry
lives under `tests/`.

**IDs** are upper case and hyphenated, and start with the runtime, engine or
tool: `JSC-`, `WEBKIT-`, `V8-`, `CHROMIUM-`, `FIREFOX-`, `NODE-`, `BUN-`,
`LLVM-`, `WASM-LD-`, `BINARYEN-`, `RUST-`. The directory name must equal the
`id`.

### `entry.toml`

The schema is strict: an unknown field is an error, so a misspelled field
cannot silently drop a claim. `_template/entry.toml` lists every field with
a comment. In short:

- `id`, `kind` (`bug` or `gap`), `status`, `runtimes` (affected engines,
  runtimes or tools; see [Names](#names)), `summary` (one line).
- `reports`: `human-only` (the default) or `agents-allowed`, which also needs
  `reports_channel` naming the channel the upstream project sanctions for
  automated or agent reports.
- `[[repro]]`, one table per reproduction: `kind` (`browser-page` or
  `script`), `entry` (file under `repro/`), `targets`, `self_judging`, and
  optionally `attempts`, `min_reproduced`, `timeout_seconds`,
  `crash_is_reproduced`. An entry can have several, because a script
  cannot run in a browser and a page cannot run in Bun or Node; no two may
  declare the same target. A repro with `self_judging = false` is an
  evidence page; the suite never runs it.
- `[[observed]]`: one record per run that matters, keyed by `runtime`,
  `version` **and** `os` (Playwright's WebKit differs between macOS and
  Linux, and a defect can be specific to one OS), with `reproduced`, `date`,
  `source` (`suite` when the driver produced it, `manual` otherwise) and
  `released`. `runtime` and `os` use the names below. Record only the
  affected runtimes (those in `runtimes`) here.
  Results on control runtimes that never had the defect go in `entry.md`:
  they are useful evidence, but a control's "not reproduced" says nothing
  about a fix.
- `[[upstream]]`: `project`, `url`, `filed`, `filed_by`. Empty until filed.
- `[[sites_without_tags]]`: `path` and `note` for places that cannot hold a
  comment (build flags, generated files, JSON, binary fixtures). It may also
  list a site that could hold a comment but whose file is a cache-key input
  (for example a package build script), where a comment would force an
  unneeded rebuild; the note says so. Prose in docs is listed the same way.
- `retired_reason`, `retired_commit` for retired entries.

### Names

`check` accepts only these names, so `run` and `list` can match records by
name:

- **`os`**: `macos`, `linux` or `windows` (what the driver reports).
- **Repro `targets`**: the Playwright engines `chromium`, `firefox` and
  `webkit`; the JavaScript hosts `node` and `bun`; the toolchain tools
  `clang`, `wasm-ld`, `wasm-opt` and `rustc`.
- **`runtimes` and `observed.runtime`**: any target name, or a released
  browser that is not automated here: `safari`, `ios-safari`, `chrome`,
  `firefox-stable`. Playwright builds are development builds, so native
  Safari is recorded by hand as `safari` with `released = true`, never as
  `webkit`; `run` then never compares a Playwright verdict with a Safari
  result.
- **Toolchain entries** name the tool that misbehaves (`clang`,
  `wasm-opt`), not the project (`llvm`, `binaryen`).

### `entry.md`

Start from `_template/entry.md`. Its sections:

1. **Defect**: what the runtime does wrong, in plain words.
2. **Why Kandelo is affected**: which Kandelo behavior meets the defect.
3. **Workaround and its cost**: what the code does instead, and what that
   costs (time, memory, complexity, lost behavior).
4. **Evidence**: measurements, stack samples, crash reports, and the
   results of every reproduction attempt, including the ones that failed.
5. **Why this is not a Kandelo defect**, or for a `suspected` entry, what is
   still unknown and what would decide it.
6. **Draft upstream report**: title, summary, steps, expected and actual
   results; the attachment is the `repro/` directory.
7. **Removal criteria**: what has to be true before the workaround goes,
   and what to delete.

## The tag

Every code site that exists because of a workaround carries the tag in a
comment, in whatever comment syntax the file uses:

```
// [RUNTIME-WORKAROUND: <ID>] <why this line exists>
```

The literal prefix `RUNTIME-WORKAROUND:` lets one search find every site in
every language:

```
git grep -n "RUNTIME-WORKAROUND: "
```

The comment around the tag still explains why the code exists; the tag
only links it to its entry. A site that cannot hold a comment goes in
`sites_without_tags` instead. `check` rejects a bracketed tag that is not
exactly of this form, and the older bare form `[<ID>]` for a registered ID.

## Reproductions

A reproduction is both the test case attached to the upstream report and
the check the suite runs. It must be:

- **Standalone.** It imports nothing from the Kandelo tree and needs no
  Kandelo build, package or VFS image. Someone at the upstream project must
  be able to run it from the `repro/` directory alone. Playwright may drive
  it but is not part of it. If the defect needs a large input (for example a
  big Wasm module), the reproduction generates it; it never copies a Kandelo
  artifact.
- **Minimal.** The smallest program that still shows the defect.
- **Self-judging.** It decides on its own whether the defect is present and
  reports a verdict: `reproduced`, `not-reproduced`, or `inconclusive` (it
  could not tell, for example because a sanity check failed). A
  reproduction that needs a person to observe something, such as reading a
  stack sample or a thread count, keeps its entry `suspected`. It stays in
  `repro/` as evidence with `self_judging = false`, and the suite does not
  run it. When a defect is probabilistic, declare `attempts` and
  `min_reproduced`; when the defect is a crash the page cannot report, set
  `crash_is_reproduced = true`.
- **Built with declared tools.** It runs with the tools the dev shell
  provides (`scripts/dev-shell.sh`) and the Playwright browsers
  `apps/browser-demos` installs, without network access beyond that.

Whenever possible a reproduction includes a sanity check that shows its
signal can fire at all, and the entry records a control runtime where the
defect is absent. A probe that would report "reproduced" on every engine is
measuring something other than the defect.

### Verdict protocols

`driver.mjs` launches one reproduction on one target and prints one JSON
line: `{"verdict": ..., "version": ..., "os": ..., "details": ...}`.

- **`browser-page`**: the driver serves `repro/` on `127.0.0.1` with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (so `SharedArrayBuffer` and
  shared `WebAssembly.Memory` work), opens `entry` in headless Playwright
  `chromium`, `firefox` or `webkit` (Chromium uses the `chromium` channel,
  matching the product gate rather than the legacy headless shell), and polls until the page sets
  `window.__reproVerdict = { verdict, details }`. A page crash counts as
  `reproduced` only with `crash_is_reproduced = true`. No verdict before
  `timeout_seconds` is `inconclusive`.
- **`script`**: the driver runs `entry` with `node`, `bun`, or (for
  toolchain targets `clang`, `wasm-ld`, `wasm-opt`, `rustc`) `bash`, in the
  `repro/` directory, and reads the last stdout line of the form
  `REPRO-VERDICT {"verdict": ..., "details": ...}`. A toolchain script runs
  the dev shell's pinned tool on a small input and judges the tool's output
  or the program it built.

With several attempts, the result is `reproduced` when at least
`min_reproduced` attempts reproduced, `not-reproduced` when every attempt
said so, and `inconclusive` otherwise.

The driver exits 0 whenever it printed a verdict, including
`inconclusive`, which is the reproduction's own answer. When the harness
itself fails, so the reproduction never ran, it exits 3, prints a
`driver: harness failure: ...` message on stderr and **no** verdict line:
Playwright could not be imported (run `npm install` in
`apps/browser-demos`), the browser would not launch, or the script runtime
(for example `bun`) could not be started. Exit 2 is a bad argument and 1 an
unexpected driver error. A broken harness is not evidence about a runtime,
so `run` treats any non-zero exit, or output without a verdict line, as a
failure of the run.

### Versions

`version` is what the runtime reports about itself: `browser.version()` for
Playwright engines (for example `26.6`), the runtime's `--version` output
for scripts. Write down which Playwright build a version came from in
`entry.md` when it matters (for example `webkit-2359`), because the version
string alone does not identify a build. Playwright builds are development
builds: record them with `released = false`. Native Safari and iOS are not
automated; record results there by hand as `safari` or `ios-safari` with
`source = "manual"` and `released = true`.

## Commands

All three run from the repository root inside the dev shell:

```
scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- runtime-workarounds check'
scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- runtime-workarounds run'
scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- runtime-workarounds list'
```

`run` also takes `--id <ID>` and `--target <target>` (each repeatable) to
narrow the run; `list` takes `--json`.

- **`runtime-workarounds check`** keeps the tags and the entries consistent.
  It fails when a tag names an unknown ID, a bracketed tag is malformed, a
  bare legacy `[<ID>]` remains, a non-retired entry has neither a tag nor a
  `sites_without_tags` item, a retired entry still has tags, an entry past
  `suspected` lacks a self-judging repro with a reproducing observation on
  one of that repro's targets, two repros declare the same target, a
  `reported` entry has no upstream record, a `fixed-upstream` entry has no
  released, non-reproducing record for one of its `runtimes`, or a field
  is missing or unknown. It runs in the `cargo-xtask` suite (the
  `registry_in_repo_is_consistent` test).
- **`runtime-workarounds run [--id ID]... [--target T]...`** runs every
  self-judging `[[repro]]` of a `confirmed`, `reported` or
  `fixed-upstream` entry on each target it declares that is installed
  here (evidence repros with `self_judging = false` never run), and
  compares each verdict with the newest `observed` record for that runtime
  and OS. A verdict that differs fails the run with a message such as
  "no longer reproduces on bun 1.4.0 (macos); update entry.toml". Fix that
  by recording the new observation and, if it holds, changing the status;
  not by changing the reproduction. `inconclusive` is reported, not
  failed. A harness failure (the driver exits non-zero or prints no
  verdict line) also fails the run, with a message naming the entry, the
  target and the end of the driver's stderr; the other jobs still run, and
  nothing is recorded for the failed one. The results are saved to
  `target/runtime-workarounds/last-run.json` for `list`. A narrowed run
  replaces only the records it produced, so each record keeps its own
  `recorded` time (`finished` is the time of the latest run), and `list`
  shows that time on every `last run:` line. A record for an (entry,
  target) pair that no self-judging repro of the entry declares any more
  (the entry, the repro or the target was removed) is dropped when `run`
  writes the file and ignored by `list`. The suite form is
  `bash scripts/ci-run-test-suite.sh runtime-workarounds`.
- **`runtime-workarounds list [--json]`** prints the weekly report:
  1. *Ready to file*: confirmed, not yet reported, with the draft report
     and reproduction paths and the observed versions;
  2. *Filed*: reported, with URLs and the last run's result;
  3. *Possibly retirable*: fixed upstream, or confirmed/reported entries
     whose last run gave a verdict on every target and reproduced on none.
     When some targets still reproduce, or some were inconclusive, the
     entry stays in its group with a `note:` line naming the targets and
     versions that did not reproduce (an inconclusive run counts as
     neither);
  4. *Needs reduction*: suspected entries;
  5. *Gaps*, by runtime.

To run a reproduction by hand, for example a `suspected` entry's evidence
page or a variant with different query parameters:

```
scripts/dev-shell.sh bash -c 'node tests/runtime-workarounds/driver.mjs \
  --dir "$PWD/tests/runtime-workarounds/<ID>/repro" --kind browser-page \
  --entry repro.html --target webkit --attempts 1 --min-reproduced 1 \
  --timeout-seconds 120 --crash-is-reproduced 0'
```

`--dir` must be absolute. When an `observed` record comes from such a run,
it is still `source = "suite"`.

## The weekly pass

1. Run `check`, then `run`, then `list`.
2. For each *Ready to file* entry, reread `entry.md`'s draft report against
   the latest run, and refresh the observed versions.
3. For each *Needs reduction* entry, try once more to reduce it, or to show
   that the fault is Kandelo's.
4. For each *Possibly retirable* entry, confirm on a released runtime and
   flag it to the maintainer as a possible retirement, citing its removal
   criteria. Removing a workaround is a separate change the maintainer
   approves; the weekly pass does not remove code.
5. Hand the maintainer the list.

**Agents never file, comment on, or vote on upstream trackers unless the
entry has `reports = "agents-allowed"` with a named channel**
(`reports_channel`, the channel the upstream project sanctions for
automated or agent reports). Otherwise reports are filed by a person, with
a reproduction they have run. After filing, record the
`upstream` entry and set `status = "reported"`.

## Runtime defect or Kandelo defect?

Most failures that look like runtime bugs are Kandelo bugs. Before writing
"the runtime is wrong", rule out Kandelo:

- **Syscall and POSIX semantics.** Does the failure follow from a syscall
  returning the wrong value, blocking when it should not, or a lost wakeup?
  Trace the syscall path first (`docs/agent-guidance/debugging-and-posix.md`).
- **Host lifetime and ownership.** Does Kandelo keep a worker, a
  `WebAssembly.Memory`, a `SharedArrayBuffer`, a pending `Atomics.waitAsync`
  or an audio node alive longer than it thinks? Leaks that look like engine
  leaks are often references Kandelo still holds
  (`docs/agent-guidance/host-runtime.md`).
- **ABI drift and stale artifacts.** Is a program, package or VFS image
  built against another kernel ABI, or an older glue? Rebuild through the
  normal path before blaming anything (`docs/agent-guidance/abi.md`).
- **One engine only?** A failure on one engine is a clue, not proof: Kandelo
  may depend on behavior the specification leaves open.

Then reproduce the defect **without Kandelo**. Write the smallest page or
script that does what Kandelo does, in plain JavaScript, Wasm bytes or a
small C file built with the pinned tool. If it reproduces and judges itself,
the entry can be `confirmed`. If only Kandelo shows it, the entry stays
`suspected`, `entry.md` says what is still unknown, and the docs and code
comments say "suspected".

## Adding an entry

1. Copy `_template/` to `<ID>/` and fill in `entry.toml` and `entry.md`.
2. Tag every code site with the `RUNTIME-WORKAROUND` tag form shown above
   (`[RUNTIME-WORKAROUND: <ID>]`), or list it in `sites_without_tags`.
3. Put the reproduction in `repro/` and run it with the driver on every
   target it declares that this machine has; record each result in
   `observed`.
4. Choose the status the evidence supports (see the table above).
5. Run `check`, and `run --id <ID>` for an entry past `suspected`.
6. Link the entry from the user-facing explanation, usually a section of
   `docs/browser-support.md`.
