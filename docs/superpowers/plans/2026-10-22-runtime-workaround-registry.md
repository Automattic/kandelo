# Runtime Workaround Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track every Kandelo workaround for a defect or gap in an outside runtime or toolchain with one comment tag, one registry entry, and a standalone self-judging reproduction that runs with the suites, and give the maintainer a weekly filing report.

**Architecture:** Entries live in `tests/runtime-workarounds/<ID>/` (`entry.toml`, `entry.md`, `repro/`). A Rust xtask module (`runtime-workarounds check|list|run`) parses entries, scans tracked files for tags, validates consistency, prints the weekly report, and runs reproductions through a small Node driver (`tests/runtime-workarounds/driver.mjs`) that serves pages to Playwright engines or runs Node/Bun/toolchain scripts and prints one JSON verdict. An agent skill drives the weekly pass.

**Tech Stack:** Rust (xtask; `toml`, `serde`, `serde_json`, `regex` already in `tools/xtask/Cargo.toml`; `tempfile` dev-dep), Node ESM with Playwright from `apps/browser-demos/node_modules/@playwright/test`, Bun and the toolchain from the dev shell, Bash suite runner.

**Spec:** `docs/superpowers/specs/2026-10-22-runtime-workaround-registry-design.md`

## Global Constraints

- Scope: defects and planned-but-unshipped features in outside runtimes (WebKit/JSC, Chromium/V8, Firefox/SpiderMonkey, Node, Bun) and toolchains (LLVM/Clang, wasm-ld, Binaryen wasm-opt, Rust). Not Playwright/test tooling, not ported packages, not Kandelo's own gaps, not unplanned absent features, not deliberate runtime design.
- Tag form, exactly: `[RUNTIME-WORKAROUND: <ID>]`; ID matches `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$`.
- Statuses, exactly: `suspected`, `confirmed`, `reported`, `fixed-upstream`, `retired`.
- `confirmed` and later require a self-judging repro; a repro needing a manual observation keeps the entry `suspected`.
- Repros import nothing from Kandelo and need no Kandelo build or image.
- `observed` records are keyed by runtime/tool, version, and host OS; `fixed-upstream` needs a released runtime/tool version observed not reproducing.
- Agents never file, comment on, or vote on upstream trackers unless the entry has `reports = "agents-allowed"` with a named channel.
- Repo rules: document *why* in comments and docs; new tooling in Rust; commit subjects `Area: Purpose`; run builds/suites under `scripts/dev-shell.sh` (set env vars inside `bash -c`); runs over 10 minutes via `scripts/agent-job`.
- Touching `libc/glue/` re-keys every package: only Task 0 edits it.

## Review Focus

1. Example tags in docs and the registry itself (the spec, `tests/runtime-workarounds/README.md`, `entry.md`) must not count as code sites — `check` would otherwise see phantom sites (Task 1 test `ignores_registry_and_design_docs`).
2. Non-UTF-8 or binary tracked files must be skipped, not crash the scan (Task 1 test `skips_binary_files`).
3. A host OS with no `observed` record for a runtime (a Linux runner when only macOS was recorded) must report "unrecorded" and not fail the suite (Task 3 test `unrecorded_os_is_not_a_failure`).
4. A repro that never reports, busy-loops, or crashes the browser must end in `inconclusive` (or `reproduced` only if it declares a crash means reproduced) within its timeout, never hang the suite (Task 3 tests: fixtures `never-reports` and `busy-loop`; `aggregate` unit cases for crashes).
5. Near-miss tags (`[RUNTIME-WORKAROUND:x]`, lower-case IDs, missing bracket) must be reported as malformed, and two tags on one line must both count (Task 1 tests `reports_malformed_tags`, `counts_two_tags_on_one_line`).

---

### Task 0: Finish the tag and wording changes on the #1562 branch

Done on branch `brandonpayton/pasted-text-file-v2` because `libc/glue/channel_syscall.c` re-keys every package and that branch already rebuilds everything for ABI 52.

**Files:**
- Modify: `libc/glue/channel_syscall.c` (the heap-safepoint comment near `kernel_heap_safepoint`; the `[JSC-TERMINATE-ATOMICS-WAIT-LEAK]` comment near line 747)
- Modify: `host/src/heap-safepoint.ts`, `host/src/worker-main.ts`, `host/src/constants.ts`, `crates/shared/src/lib.rs` (comments only), `docs/browser-support.md`, `docs/abi-versioning.md`, `docs/architecture.md`

- [ ] **Step 1:** `git switch brandonpayton/pasted-text-file-v2`.
- [ ] **Step 2:** Tag sites: `[RUNTIME-WORKAROUND: JSC-BLOCKED-WAIT-GC-STARVATION]` on the bounded wait in `channel_syscall.c`, the module comment in `heap-safepoint.ts`, and the `kernel_heap_safepoint` entry in `worker-main.ts`; `[RUNTIME-WORKAROUND: WEBKIT-TEXTDECODER-WRAPPER-CRASH]` on `WASM_NAME_DECODER` (`constants.ts`) and `EXPORT_NAME_DECODER` (`worker-main.ts`); rewrite the bare `[JSC-TERMINATE-ATOMICS-WAIT-LEAK]` in `channel_syscall.c` to `[RUNTIME-WORKAROUND: JSC-TERMINATE-ATOMICS-WAIT-LEAK]`.
- [ ] **Step 3:** Reword both #1562 explanations from engine-bug claims to "suspected" in every file listed above. The GC deadlock is suspected because its standalone page proves helper pinning only through stack samples; the TextDecoder crash because it has no standalone reduction. Keep the measured evidence; state that each becomes a confirmed WebKit defect only with a self-judging standalone repro. In `docs/browser-support.md` the section titles stay (anchors are linked), the bodies change.
- [ ] **Step 4:** Rebuild: `scripts/agent-job start -- "$HOME/.cache/kandelo-heavy.sh 'port-moresby: #1562 comment rekey' bash -c 'scripts/dev-shell.sh bash scripts/build-musl.sh --ensure && ./run.sh setup && scripts/dev-shell.sh bash scripts/build-programs.sh'"`, then `scripts/agent-job wait <id>` until it reports succeeded.
- [ ] **Step 5:** Re-validate: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/heap-safepoint.test.ts test/kernel-reservation-export-contract.test.ts'` → all pass; with `./run.sh browser --host 127.0.0.1 --port <free> --strictPort` running, `scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=<port> npx playwright test test/php-web-image-cli.spec.ts --project=webkit --repeat-each=2 --workers=1 --reporter=list'` → `6 passed`. Stop the server afterwards.
- [ ] **Step 6:** Commit `Host: Tag the #1562 workarounds and mark their causes suspected`; then `git switch brandonpayton/runtime-workaround-registry && git rebase brandonpayton/pasted-text-file-v2`.

### Task 1: Entry model, tag scan, and `check`

**Files:**
- Create: `tools/xtask/src/runtime_workarounds/mod.rs`, `entry.rs`, `scan.rs`, `check.rs`
- Modify: `tools/xtask/src/main.rs` (add `mod runtime_workarounds;`, dispatch `"runtime-workarounds" => runtime_workarounds::run(rest)`, add the name to the usage list)

**Interfaces:**
- Produces (`entry.rs`):
  - `pub enum Kind { Bug, Gap }`, `pub enum Status { Suspected, Confirmed, Reported, FixedUpstream, Retired }` (serde kebab-case), `pub enum ReportPolicy { HumanOnly, AgentsAllowed }` (serde `human-only`/`agents-allowed`), `pub enum ReproKind { BrowserPage, Script }` (serde `browser-page`/`script`), `pub enum Verdict { Reproduced, NotReproduced, Inconclusive }` (serde kebab-case).
  - `pub struct Repro { kind: ReproKind, entry: String, targets: Vec<String>, self_judging: bool, attempts: u32 /*default 1*/, min_reproduced: u32 /*default 1*/, timeout_seconds: u32 /*default 120*/, crash_is_reproduced: bool /*default false*/ }`
  - `pub struct Observation { runtime: String, version: String, os: String, reproduced: bool, date: toml::value::Datetime, source: String /*"suite"|"manual"*/, released: bool }`
  - `pub struct Upstream { project: String, url: String, filed: toml::value::Datetime, filed_by: String }`
  - `pub struct SiteWithoutTag { path: String, note: String }`
  - `pub struct Entry { id, kind, status, runtimes: Vec<String>, summary: String, reports: ReportPolicy /*default HumanOnly*/, reports_channel: Option<String>, retired_reason: Option<String>, retired_commit: Option<String>, repro: Option<Repro>, observed: Vec<Observation>, upstream: Vec<Upstream>, sites_without_tags: Vec<SiteWithoutTag> }` with `#[serde(deny_unknown_fields)]`.
  - `pub fn load_entries(registry: &Path) -> Result<Vec<(String /*dir name*/, Entry)>, String>` — every subdirectory containing `entry.toml`; directories starting with `_` are fixtures and skipped.
  - `pub const TARGETS: &[&str] = &["chromium","firefox","webkit","node","bun","clang","wasm-ld","wasm-opt","rustc"];`
- Produces (`scan.rs`): `pub struct TagSite { pub path: PathBuf, pub line: usize, pub id: String }`; `pub struct Scan { pub tags: Vec<TagSite>, pub legacy: Vec<TagSite>, pub malformed: Vec<TagSite> }`; `pub fn scan(repo: &Path, known_ids: &BTreeSet<String>) -> Result<Scan, String>` over `git ls-files`, excluding `tests/runtime-workarounds/` and `docs/superpowers/`; strict tag regex `\[RUNTIME-WORKAROUND: ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]`; a line containing `RUNTIME-WORKAROUND` with no strict match is malformed; legacy = `[<known id>]` without the prefix.
- Produces (`check.rs`): `pub fn problems(repo: &Path) -> Result<Vec<String>, String>`.
- Produces (`mod.rs`): `pub(crate) fn run(args: Vec<String>) -> Result<(), String>` dispatching `check`, `list`, `run`; `pub fn registry(repo: &Path) -> PathBuf` = `repo/tests/runtime-workarounds`.

`problems` reports, one message each: entry dir name ≠ `id`; tag naming an unknown ID; malformed tag; legacy tag; non-`retired` entry with no tag and no `sites_without_tags`; `retired` entry with tags or without `retired_reason`; `confirmed`/`reported`/`fixed-upstream` entry without `repro`, with `self_judging = false`, or with no `observed` record having `reproduced = true`; `reported`/`fixed-upstream` without `upstream`; `fixed-upstream` without an `observed` record with `released = true` and `reproduced = false`; `agents-allowed` without `reports_channel`; a target not in `TARGETS`; `repro.entry` file missing under `repro/`; `sites_without_tags` path not tracked; missing `entry.md`.

- [ ] **Step 1: Write the failing tests** in `check.rs` (`#[cfg(test)]`, temp git repos built with `tempfile` + `git init`/`git add`):
  - `clean_registry_has_no_problems` — one `confirmed` entry with a self-judging repro, a reproduced observation, and a tagged `.ts` site → `problems == []`.
  - `unknown_tag_id_is_reported` — tag `[RUNTIME-WORKAROUND: NOPE-THING]` → a problem containing `NOPE-THING`.
  - `untagged_entry_is_reported` and `sites_without_tags_satisfies_untagged_entry`.
  - `retired_entry_must_not_keep_tags`.
  - `confirmed_requires_self_judging_repro` — `self_judging = false` → problem containing `self-judging`.
  - `reports_malformed_tags` — `[RUNTIME-WORKAROUND:x]` and `[RUNTIME-WORKAROUND: lower-case]` → two malformed problems.
  - `counts_two_tags_on_one_line` — `scan` returns 2 `TagSite`s for one line.
  - `reports_legacy_bare_tags` — `[KNOWN-ID]` with `KNOWN-ID` registered → legacy problem.
  - `ignores_registry_and_design_docs` — tags inside `tests/runtime-workarounds/X/entry.md` and `docs/superpowers/specs/a.md` are not sites.
  - `skips_binary_files` — a tracked file with invalid UTF-8 → no error.
  - `fixed_upstream_needs_released_not_reproduced_observation`.
  - `registry_in_repo_is_consistent` — `problems(&crate::repo_root())` is empty (this makes `cargo test -p xtask`, the always-run `cargo-xtask` suite, enforce the registry).
- [ ] **Step 2:** `scripts/dev-shell.sh bash -c 'cargo test -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" -- runtime_workarounds'` → fails to compile / tests fail.
- [ ] **Step 3:** Implement `entry.rs`, `scan.rs`, `check.rs`, `mod.rs` (`check` prints each problem and returns `Err` with the count when any exist; prints `runtime-workarounds: N entries, M tag sites, consistent` otherwise).
- [ ] **Step 4:** Same command → all `runtime_workarounds` tests pass except `registry_in_repo_is_consistent`, which passes only after Task 4; mark it `#[ignore = "enabled in Task 4 after migration"]` for now.
- [ ] **Step 5:** Commit `Tools: Check runtime workaround tags against their registry`.

### Task 2: `list` — the weekly report

**Files:**
- Create: `tools/xtask/src/runtime_workarounds/report.rs`
- Modify: `mod.rs` (dispatch `list [--json]`)

**Interfaces:**
- Consumes: `load_entries`, `Entry`, `Status`, `Verdict` (Task 1); `LastRun` (Task 3 — read as optional, so define the struct here and have Task 3 write it).
- Produces: `pub struct LastRunRecord { pub id: String, pub target: String, pub os: String, pub version: String, pub verdict: Verdict, pub details: String }`; `pub struct LastRun { pub finished: String, pub records: Vec<LastRunRecord> }`; `pub fn last_run_path(repo: &Path) -> PathBuf` = `repo/target/runtime-workarounds/last-run.json`; `pub fn render(entries: &[(String, Entry)], last: Option<&LastRun>) -> String`.

Groups, in this order and with these exact headings: `Ready to file` (status `confirmed`, `upstream` empty), `Filed` (`reported`), `Possibly retirable` (`fixed-upstream`, or `confirmed`/`reported` whose last-run record for any target is `not-reproduced`), `Needs reduction` (`suspected`), `Gaps` (kind `gap`, any non-retired status, grouped by runtime). Each item shows ID, summary, runtimes, latest observation per runtime+OS, upstream URLs, repro path, and `entry.md` path. Retired entries are omitted. `--json` prints the same grouping as JSON.

- [ ] **Step 1: Write the failing tests** in `report.rs`: `ready_to_file_lists_confirmed_unreported`; `filed_shows_upstream_urls`; `not_reproduced_last_run_marks_possibly_retirable`; `suspected_goes_to_needs_reduction_never_ready`; `retired_is_omitted`; `gap_listed_under_gaps`. Assert on the exact headings above and the presence of IDs under them.
- [ ] **Step 2:** Run the Task 1 command → new tests fail.
- [ ] **Step 3:** Implement `render` and the `list` subcommand (reads `last_run_path` if present).
- [ ] **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `Tools: Report runtime workarounds for the weekly filing pass`.

### Task 3: Reproduction driver, `run`, and the suite group

**Files:**
- Create: `tests/runtime-workarounds/driver.mjs`, `tests/runtime-workarounds/driver.test.mjs`, fixture repros `tests/runtime-workarounds/_fixtures/{reports-reproduced,reports-not-reproduced,never-reports,busy-loop,node-script}/` (repro files only; the `_` prefix keeps them out of `load_entries`)
- Create: `tools/xtask/src/runtime_workarounds/run.rs`
- Modify: `mod.rs` (dispatch `run [--id ID]... [--target T]...`), `scripts/ci-run-test-suite.sh` (new suite `runtime-workarounds`), `docs/agent-guidance/validation.md` (suite table row)

**Interfaces:**
- Driver CLI (xtask passes the `[repro]` fields as flags, so the driver needs no TOML parser): `node tests/runtime-workarounds/driver.mjs --dir <repro-dir> --kind browser-page|script --entry <file> --target <t> --attempts N --min-reproduced N --timeout-seconds N --crash-is-reproduced 0|1`. Prints exactly one final stdout line: `{"verdict":"reproduced|not-reproduced|inconclusive","version":"…","os":"macos|linux|windows","details":"…"}`; exit 0 whenever it produced a verdict.
- Repro protocols: browser page sets `window.__reproVerdict = { verdict, details }`; scripts print a line `REPRO-VERDICT {"verdict":…,"details":…}`. `script` + `node` runs `node <entry>`; `bun` runs `bun <entry>`; toolchain targets run `bash <entry>` (the script invokes its tool).
- Versions: Playwright `browser.version()` prefixed with the engine name; `process.version` for node; `bun --version`; first line of `<tool> --version` for toolchains.
- Pages are served from the repro dir by an ephemeral `node:http` server with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; Playwright is imported from `apps/browser-demos/node_modules/@playwright/test/index.mjs`.
- Produces (`run.rs`): `pub enum Outcome { Match, Changed(String), Unrecorded, Inconclusive }`; `pub fn compare(entry: &Entry, record: &LastRunRecord) -> Outcome` — finds the latest `observed` with the same `runtime` (= target) and `os`; none → `Unrecorded`; verdict inconclusive → `Inconclusive`; equal reproduced flag → `Match`; otherwise `Changed("<ID>: no longer reproduces on <target> <version> (<os>); update entry.toml — candidate for fixed-upstream or retirement")` or `Changed("<ID>: reproduces on <target> <version> (<os>) where the last record says it does not; update entry.toml")`.
- Driver exports `aggregate(attempts: Array<"reproduced"|"not-reproduced"|"inconclusive"|"crashed">, minReproduced: number, crashIsReproduced: boolean): "reproduced"|"not-reproduced"|"inconclusive"`.
- `run` executes every entry with status `confirmed|reported|fixed-upstream` (narrowed by `--id`/`--target`), for each declared target present on this host (skip a toolchain or bun target whose binary is not on PATH, reporting it), writes `last-run.json`, prints one line per record with its outcome, and returns `Err` iff any outcome is `Changed`.

Driver decisions: attempts run sequentially in fresh browser instances; `reproduced` iff at least `min_reproduced` attempts reproduced; else `not-reproduced` iff every attempt reported `not-reproduced`; else `inconclusive`. A page crash counts as reproduced only with `--crash-is-reproduced 1`, else inconclusive. A missing verdict at timeout is inconclusive.

- [ ] **Step 1: Write the failing tests.** `driver.test.mjs` (`node --test`), running the driver on the fixtures with target `chromium`: `reports-reproduced` → `reproduced`; `reports-not-reproduced` → `not-reproduced`; `never-reports` and `busy-loop` (a page that runs `while (true) {}`), each with `--timeout-seconds 3` → `inconclusive` in under 15 s; target `node`: `node-script` → `reproduced` and `version` starts with `v`. `aggregate` cases: `(["crashed"],1,true)` → `reproduced`; `(["crashed"],1,false)` → `inconclusive`; `(["reproduced","not-reproduced"],1,false)` → `reproduced`; `(["not-reproduced","not-reproduced"],1,false)` → `not-reproduced`; `(["not-reproduced","inconclusive"],1,false)` → `inconclusive`. `run.rs` tests: `unrecorded_os_is_not_a_failure`; `matching_record_is_match`; `stopped_reproducing_is_changed_with_message` (assert the exact message format above); `inconclusive_is_not_a_failure`.
- [ ] **Step 2:** `scripts/dev-shell.sh bash -c 'node --test tests/runtime-workarounds/driver.test.mjs'` and the cargo test command → fail.
- [ ] **Step 3:** Implement `driver.mjs` and `run.rs`; xtask spawns `node` with the driver path and parses its last stdout line.
- [ ] **Step 4:** Add suite `runtime-workarounds` to `scripts/ci-run-test-suite.sh`: `install_node_deps`, `node --test tests/runtime-workarounds/driver.test.mjs`, then `cargo run -p xtask --target "$(host_target)" --quiet -- runtime-workarounds run`. Add a row to the suite table in `docs/agent-guidance/validation.md`: `| Runtime workaround repros | bash scripts/ci-run-test-suite.sh runtime-workarounds | Whether each confirmed outside defect still reproduces (registry: tests/runtime-workarounds/) |`.
- [ ] **Step 5:** Run both test commands → pass; run `scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh runtime-workarounds` → exits 0 with "0 entries" (registry still empty).
- [ ] **Step 6:** Commit `Tests: Run runtime workaround reproductions as a suite`.

### Task 4: Registry guide, documentation, and migration of known workarounds

**Files:**
- Create: `tests/runtime-workarounds/README.md`, `tests/runtime-workarounds/_template/{entry.toml,entry.md}`
- Create: `tests/runtime-workarounds/JSC-BLOCKED-WAIT-GC-STARVATION/`, `WEBKIT-TEXTDECODER-WRAPPER-CRASH/`, `JSC-TERMINATE-ATOMICS-WAIT-LEAK/`, `WEBKIT-AUDIOWORKLET-CLOSE-LEAK/` (each `entry.toml`, `entry.md`, `repro/`)
- Modify: every file with a bare `[JSC-TERMINATE-ATOMICS-WAIT-LEAK]` or `[WEBKIT-AUDIOWORKLET-CLOSE-LEAK]` tag outside `libc/glue/` (find with `git grep -n "\[JSC-TERMINATE-ATOMICS-WAIT-LEAK\]\|\[WEBKIT-AUDIOWORKLET-CLOSE-LEAK\]"`); `docs/jsc-terminate-atomics-wait-workaround.md`; `docs/browser-support.md`; `CLAUDE.md`; `docs/agent-guidance/debugging-and-posix.md`; `tools/xtask/src/runtime_workarounds/check.rs` (remove the `#[ignore]` from `registry_in_repo_is_consistent`)

`README.md` is the authoritative guide: scope (spec "Scope" + "Non-goals"), statuses table, layout, tag form, repro rules (standalone, minimal, self-judging, protocols from Task 3), versions rule, the three commands, the weekly pass, the never-file-without-permission rule, and how to tell a Kandelo defect from a runtime defect (check syscall semantics, host lifetime/ownership, ABI drift; reproduce without Kandelo before blaming). `entry.md` template sections: Defect, Why Kandelo is affected, Workaround and its cost, Evidence, Why this is not a Kandelo defect (or what is still unknown), Draft upstream report, Removal criteria.

Migration rules: run each entry's repro on every target available here (`cargo run -p xtask … runtime-workarounds run --id <ID>`, or the driver directly for suspected entries) and record `observed` from that run (source `suite`, `released = false` for Playwright builds); status follows the spec's table.

- [ ] **Step 1:** Write README, template, `CLAUDE.md` rule (one paragraph in "Debugging And POSIX Contract": a runtime or toolchain workaround needs a `[RUNTIME-WORKAROUND: <ID>]` tag and a registry entry; blaming a runtime needs a standalone self-judging repro, otherwise it is "suspected"; link the README), and a `debugging-and-posix.md` section "Runtime defects versus Kandelo defects" pointing to the README.
- [ ] **Step 2:** `JSC-BLOCKED-WAIT-GC-STARVATION`: copy `.context/webkit-gc-repro/repro.html` into `repro/`, add the `__reproVerdict` protocol. Spend at most a bounded effort (≤ 2 h) seeking a self-judging signal (for example a `FinalizationRegistry` callback or an `Atomics.waitAsync`-driven collection in another worker that never completes while helpers are pinned, compared with mode C); if found, set `self_judging = true` and let the run decide the status; if not, `status = "suspected"`, `self_judging = false`, and record the attempt and the stack-sample evidence in `entry.md`. Sites come from Task 0.
- [ ] **Step 3:** `WEBKIT-TEXTDECODER-WRAPPER-CRASH`: `status = "suspected"`; copy `.context/webkit-gc-repro/textdecoder.html` as evidence with `crash_is_reproduced = true`; `entry.md` carries the boot-crash rates and the failed reductions from `.context/webkit-bug-draft-textdecoder.md`.
- [ ] **Step 4:** `JSC-TERMINATE-ATOMICS-WAIT-LEAK`: rewrite the bare tags; build a self-judging repro from `apps/browser-demos/public/terminate-atomics-test.html` (copy; the app test that uses the original keeps working); copy the draft report from `~/notes/Agent-logs/2026-07-09-webkit-atomics-wait-terminate-leak.md` and the upstream links (WebKit 278866, 250569) into `entry.md`; run on `webkit` and `bun`; status from the result (Playwright not reproducing → not `fixed-upstream`, which needs a released runtime). Shrink `docs/jsc-terminate-atomics-wait-workaround.md` to the mechanism description plus a link to the entry (many files link to it; keep the file).
- [ ] **Step 5:** `WEBKIT-AUDIOWORKLET-CLOSE-LEAK`: rewrite the bare tags; `status = "suspected"` unless a self-judging reduction reproduces; record the earlier failed reduction.
- [ ] **Step 6:** In `docs/browser-support.md`, link each of the four sections to its entry.
- [ ] **Step 7:** Remove the `#[ignore]` from `registry_in_repo_is_consistent`; run `cargo run -p xtask … runtime-workarounds check` → `consistent`; the cargo test command → pass; `bash scripts/ci-run-test-suite.sh runtime-workarounds` → exit 0.
- [ ] **Step 8:** Commit `Docs: Register the known runtime workarounds`.

### Task 5: Audit untagged workarounds

**Files:**
- Modify: source files found by the audit; new entries under `tests/runtime-workarounds/`

- [ ] **Step 1:** List candidates: `git grep -niE "workaround|work around|engine bug|webkit bug|chromium bug|firefox bug|v8 bug|bun bug|node bug|llvm bug|wasm-ld bug|binaryen|crbug|bugs\.webkit|bugzilla" -- ':!tests/runtime-workarounds' ':!docs/superpowers' ':!*.json' ':!*.lock'` into `.context/workaround-audit.md`.
- [ ] **Step 2:** Classify each hit: in scope (outside runtime/toolchain defect or planned gap that Kandelo works around) → tag + entry (default `suspected`); out of scope (Kandelo gap, package patch, test tooling, unplanned absence, deliberate runtime design) → leave unchanged. Any `libc/glue/` hit in scope goes back to Task 0's branch instead.
- [ ] **Step 3:** `runtime-workarounds check` → consistent; cargo test → pass.
- [ ] **Step 4:** Commit `Docs: Register runtime workarounds found by the audit`; keep the classification table for the PR description.

### Task 6: Agent skill and its eval

**Files:**
- Create: `.claude/skills/tracking-runtime-workarounds/SKILL.md`; symlink `.agents/skills/tracking-runtime-workarounds -> ../../.claude/skills/tracking-runtime-workarounds`
- Modify: `.claude/skills/tests/test_skills.py` (check every skill's `.agents/skills/<name>` link, not only the porting skill's), `evals/agent-skills/tasks.json` (two tasks), `evals/agent-skills/run.py` (`SKILLS` gains `"tracking-runtime-workarounds"`)

SKILL.md frontmatter `description`: `Use when adding or changing code that works around a browser engine, JavaScript runtime, or toolchain defect; when claiming a runtime is at fault in code, docs, or a PR; or when preparing the weekly upstream bug-filing pass.` Body: route to `tests/runtime-workarounds/README.md`; rules from the spec's "Agent skill" section verbatim in substance (start `suspected`, try to prove Kandelo's fault first, word unreduced claims as suspected, weekly pass = `check` + suite + `list` + reduction attempts + draft refresh + retirement flags, never file unless `agents-allowed`); end-of-task `Skill feedback (tracking-runtime-workarounds): used …; wrong: …; missing: …` line like the porting skill.

Eval tasks (read-only prompts, regex checks):
- `register-runtime-workaround`: "You just added a 100 ms bounded wait in libc glue to avoid a WebKit garbage-collector stall that you reproduced only inside Kandelo. What must you add to the repo, what status does it get, and how should code comments describe the cause?" Checks: `RUNTIME-WORKAROUND:`, `tests/runtime-workarounds`, `suspected`, `standalone|without Kandelo`.
- `weekly-filing-pass`: "Prepare this week's upstream bug-filing pass. What do you run, what do you hand the maintainer, and what must you not do?" Checks: `runtime-workarounds list`, `runtime-workarounds check`, `ci-run-test-suite\.sh runtime-workarounds`, `(do not|never) file|human`.

- [ ] **Step 1:** Generalize the link check in `test_skills.py` to every `.claude/skills/*/SKILL.md`, then write SKILL.md without the symlink; `python3 .claude/skills/tests/test_skills.py` → FAIL naming `.agents/skills/tracking-runtime-workarounds`.
- [ ] **Step 2:** Create the symlink; same command → `0 failures`.
- [ ] **Step 3:** Add eval tasks and the `SKILLS` entry; run `python3 evals/agent-skills/run.py --reps 1` and read the saved answers. Keep the skill only if skills-on beats skills-off on these tasks without regressing the porting tasks; otherwise delete the skill and its eval tasks and note that in the PR.
- [ ] **Step 4:** Commit `Agents: Add a skill for tracking runtime workarounds` (or `Docs: Record why the workaround skill was dropped`).

### Task 7: Branch validation and PR draft

- [ ] **Step 1:** `scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-xtask` → pass (includes `registry_in_repo_is_consistent`).
- [ ] **Step 2:** `scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh runtime-workarounds` → exit 0; save output.
- [ ] **Step 3:** `cargo run -p xtask … runtime-workarounds list` → save output for the PR.
- [ ] **Step 4:** `bash scripts/test-agent-skills.sh` → pass.
- [ ] **Step 5:** Write `.context/pr-body-runtime-workarounds.md` (`## Why` first, junior-readable, one line per paragraph, audit table, list output, what ran and what did not). Do not push or open the PR without the maintainer's go-ahead.
