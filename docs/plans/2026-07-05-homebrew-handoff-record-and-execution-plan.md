# Homebrew on Kandelo — Work Record & Forward Execution Plan (Handoff)

- Date: 2026-07-05 (state snapshots are point-in-time; re-verify PR/bead status at execution).
- Purpose: a **standalone handoff** so this work can be driven **directly with Claude**, outside Gas City mayor-routing, with reliable oversight.
- Companion (design rationale, the "why"): `docs/plans/2026-07-05-homebrew-bottle-publishing-design-checkpoint.md`.
- Prior research (to be corrected): `docs/plans/2026-07-01-homebrew-builtin-vs-custom-bottle-publishing-research.md` (PR #823).

## 0. How to use this / oversight model

- This doc is the single source of truth for the Homebrew bottle-publishing + tap-migration + brew-in-Kandelo work.
- **Execution model built for oversight:** every work item below is scoped to a **single reviewable PR** with explicit acceptance. Drive them one at a time with Claude; you review each PR before merge. No mayor routing required.
- **Beads (optional):** if you want tracking, create/own beads yourself as a personal checklist — you don't have to route through the mayor. Each §5 work item maps to one bead.
- **Two GitHub repos:** `Automattic/kandelo` (the platform) and `Automattic/kandelo-homebrew` (the tap). Formula/package work targets the **tap**; platform work targets **main**.

## 1. Goal & governing principle

Publish and consume Kandelo packages as **first-class Homebrew citizens**: hosted where Homebrew hosts (GHCR/OCI), published with Homebrew's own tooling, resolvable by a stock guest `brew` like `homebrew/core`. **Real Homebrew runs inside Kandelo** (the kernel sandbox is the trust boundary) to install packages at VFS build time and at runtime. End-state: **the tap is a real Homebrew tap of real from-source formulae; `Automattic/kandelo` is the platform they build on.**

## 2. Locked decisions (rationale in the checkpoint)

- **Hosting:** GHCR/OCI at exact Homebrew parity; publish with **`skopeo` via `brew pr-upload`/`pr-pull`** (Homebrew's own uploader). GH Releases retired for bottles. `packages:write` token is provisioned.
- **Repo boundary:** the tap `Automattic/kandelo-homebrew` owns **full package definitions** (Formula + build recipe) + `bottle do` + provenance + **GHCR images**. Main owns the platform (kernel, host/VFS, SDK, CI). **No binaries in git** (bytes → GHCR).
- **Permission split:** bottle publish rides Kandelo's existing **PR→merge→release** model, in the **tap's** CI (unprivileged build/validate on PR; privileged `skopeo` publish + tap commit on merge). `pr-upload --upload-only` = privileged seed/maintenance hatch.
- **Tags/ABI:** synthetic `:kandelo` system; `{wasm32,wasm64}_kandelo` tags; **kernel-ABI generation encoded in the platform tag** (ABI ≈ macOS version); `:any` relocatable (cheap — everything targets the single fixed prefix `/home/linuxbrew/.linuxbrew`).
- **Bottle self-describing:** extrinsic identity → `bottle do`; intrinsic pour data (`link_manifest`/`fork_instrumentation`/`cache_key_sha`) → an in-keg `.kandelo/` receipt; browser smoke → a publish **gate**, not a stored field.
- **Pour model:** **real Homebrew inside Kandelo** — build-time (host runs Kandelo → brew installs → `saveImage()`), runtime (guest `brew install`). The committed host-side link-manifest *replay* (`tools/xtask/src/homebrew_vfs_build.rs`) is being **replaced**.
- **Lazy files:** materialize VFS files on demand **from the published bottle**. **Option 3** — extend the lazy-*archive* path to fetch+extract the whole **tar.gz bottle** on first access. **Option 2** (a per-file/zip representation *derived* from the tar.gz bottle) is the documented restore path if whole-bottle fetch is too heavy.
- **Formulae + recipes → tap (whole-move):** fork recipes into the tap; **whole-move** package PRs (recipe+formula co-locate ⇒ no split). Platform PRs that only incidentally touch formulae stay in main and shed those edits. Retire the main `homebrew/kandelo-homebrew/` fixture.
- **Tap layout → Homebrew-idiomatic (2026-07-05):** build logic lives in the formula's **`install` method** (real from-source formula), with Kandelo specifics (SDK activation, wasm cross-compile, fork-instrument) in the **`Kandelo/KandeloFormulaSupport`** mixin — *not* a separate `build-<name>.sh`. Deviate only on genuine Homebrew-idiom friction, and call each deviation out.
- **Sync → main pulls from the tap (2026-07-05):** no maintained subtree/vendored copy. Main **taps and builds from** the tap on demand; `packages/registry` copies retire once brew-in-Kandelo consumption lands.
- **Rollout:** publish bottles is no-regret. **kd-yuef waits for brew-in-Kandelo** (no transitional link-manifest unblock).

## 3. Current state (the RECORD) — snapshot 2026-07-05

### Repos
- **`Automattic/kandelo`** — platform + (today) the `homebrew/kandelo-homebrew/` *fixture* holding most formulae, plus `packages/registry/<name>/` build recipes. These are what migrate/retire.
- **`Automattic/kandelo-homebrew`** — the real tap. **Currently near-empty: `Formula/` has only `hello.rb`.** `Kandelo/` has the support infra (schemas: `formula.schema.json`, `link-manifest.schema.json`, `metadata.schema.json`, `provenance.schema.json`; `examples`, `reports`). So the migration is largely **greenfield** on the tap side.

### brew-in-Kandelo (the critical path)
- **Ruby foundation is MERGED**, not pending: PR **#718** (Ruby 4 + `wasm-local-root-spill` GC root visibility) merged 2026-06-24; URI/RubyGems GC traps fixed; psych/YAML works at runtime (psych 5.3.1, libyaml 0.2.5); brew-config Ruby traps closed (kd-e8g/kd-xmh/kd-9jd/kd-nfr/kd-drt.13/kd-v8m/kd-bsj).
- **Guest brew is an in-progress experiment, not shipped:** a real upstream Homebrew has been staged + booted inside a Kandelo guest (`target/kd-sqw-homebrew/` probe image). Live work has been happening in **sibling worktrees** outside the main checkout. **True end-to-end state of `brew install`/`doctor`/`tap` inside Kandelo is unassessed** — this is the #1 unknown and the gate for everything downstream.

### Open PR landscape (categorized; ~50 open PRs — re-verify)
- **Ruby:** #718 **MERGED**; **#814** (psych/YAML formula) OPEN → **redirect to tap** as migration instance #1 (do not merge to main).
- **Package waves (formula + recipe → whole-move to tap):** #810 (language runtimes), #808 (JS/DB/service), #815 (ncurses/bash/nethack/curl), #818 (cpython stdlib), #820 (erlang), #821/#822/#827/#829/#833 (perl), #839 (php), #792/#793/#794 (dependency roots / CLI waves), #809 (spidermonkey).
- **Platform/CI PRs (stay in main; shed formula edits):** #819/#817/#816 (framebuffer + browser-smoke harness), #811 (rootfs/shell sidecars), #812 (VFS dir links + dinit), #795 (generic browser smoke).
- **Registry-reshaping drafts (RECONCILE with this plan — overlapping prior work):** #806 (Homebrew package inventory + migration plan), #805 (registry replacement model), #804 (move runtime platform artifacts out of registry bridge), #799–#803, #800–#802 (registry cleanup/classification).
- **SQLite/PHP platform fixes (normal main work, mostly not formula):** #756/#757/#758, #760–#784, #798, etc.
- **Research/docs:** #823 (this design research — to be corrected), #831 (GHCR blob-vs-native OCI doc), #834 (fork-instrument size eval).

### Key beads
- **kd-1mr** — umbrella convoy (homebrew-all). **kd-1i0u** — this design (closed; PR #823; worktree holds these docs). **kd-yuef** (P1, blocked) — VFS-critical cpython/perl/erlang sidecars; **now waits for brew-in-Kandelo**. **kd-p3hr** — worktree with the uncommitted/authored language formulae. **kd-v3fs** — composite VFS packages (downstream of kd-yuef). **kd-egn1** (P2, open) — ruby psych/YAML (PR #814); **kd-9oou/kd-dsft** (P3) — ruby CI/build follow-ups.

### Worktrees
- Design/docs: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-1i0u-bottle-publishing-research` (branch `gascity/kd-1mr/kd-1i0u-bottle-publishing-research`) — holds this doc + the checkpoint.
- Live guest-brew work: **sibling worktrees** (locate before assuming state).

## 4. Open questions / risks

1. **brew-in-Kandelo end-to-end state is unassessed** — the gate for kd-yuef and for main-consumes-from-tap. Resolve first (Phase 2).
2. **Reconcile with in-flight registry-reshaping PRs (#804/#805/#806, #799–#803).** They already touch the registry→homebrew boundary; the tap-migration must absorb or supersede them, not collide.
3. **Homebrew-idiom friction points** (call out as found): wasm cross-compile, fork-instrument, SDK activation, the `:kandelo` synthetic tag, ABI-in-tag — where these don't map to Homebrew idioms, they live in `KandeloFormulaSupport` and are documented.
4. **Owed upstream `brew`-source verification:** `skopeo`/`github_packages.rb`; `pr-upload`/`pr-pull` standalone + synthetic-tag handling; GHCR path derivation for the tap; whether `brew bottle` has non-tar.gz flexibility (settles lazy option 2).
5. **Lazy granularity:** option 3 now; measure whole-bottle fetch cost → option 2 if too heavy.

## 5. Forward execution plan (bead-ready work items)

Tracks A/C/D can proceed in parallel; **Track B (brew-in-Kandelo) is the long pole** and gates kd-yuef + retiring `packages/registry`.

### Track A — Tap migration (greenfield; parallelizable)
- **A0. Tap layout spec.** Decide the Homebrew-idiomatic layout: formula `install` builds from source via `KandeloFormulaSupport`; where `package.toml`/`build.toml` data and demos land (fold into formula attrs / a Kandelo-namespaced sidecar / tap `test`). Write it into the tap `README`/`Kandelo/`. *Accept:* a documented layout + one converted exemplar formula. **Reconcile with #806/#805 first.**
- **A1. Convert `ruby.rb` (instance #1).** Whole-move PR #814's `ruby.rb` + `packages/registry/ruby/` into a real from-source tap formula; open a **tap PR**; close/redirect #814. *Accept:* `brew install ruby` formula builds ruby.wasm from source under the tap's CI (Node smoke: psych/YAML round-trip); nothing ruby lands in main.
- **A2. Migrate the package waves.** Convert the remaining fixture formulae + recipes (perl, cpython, erlang, php, the CLI/dependency-root waves) to tap formulae; one tap PR per package (or per small wave). *Accept:* each builds from source under tap CI + Node smoke; main fixture entry removed.
- **A3. Wire "main pulls from the tap."** Make main's rootfs/VFS/CI builds fetch+build from the tap instead of `packages/registry`. *Accept:* rootfs + a language VFS image build green while sourcing the tap; begin retiring `packages/registry` copies. (Full retire gated on Track B.)
- **A4. Platform PRs shed formulae.** Rebase #819/#817/#816/#811/#812/#795 to drop formula-file edits (now tap-owned); keep their platform/CI content. *Accept:* those PRs touch no `Formula/*.rb`.

### Track B — brew-in-Kandelo integration (the critical path)
- **B1. Gap analysis (assess-first).** Determine the true state of `brew --version/config/doctor/tap/install` inside Kandelo (Node + browser), from the `target/kd-sqw-homebrew/` probe + sibling worktrees. *Accept:* an evidence-backed ledger of what works/fails + the single hardest blocker with a reproducer. **Use the Appendix prompt.**
- **B2. Drive `brew install <formula>` end-to-end.** Root-cause the blockers from B1. *Accept:* guest `brew install <formula>` succeeds in Kandelo on Node (browser status recorded), reviewable PR.
- **B3. VFS-build-via-brew-in-Kandelo.** Replace the link-manifest replay: host runs Kandelo → brew installs into the canonical prefix → `saveImage()` (heavy files as lazy refs to the published bottle). *Accept:* one demo VFS image built this way, boots on Node + browser.

### Track C — Publish pipeline (GHCR parity; parallel to B)
- **C1. Tap CI: build → skopeo/pr-upload publish → tap commit,** on the PR→merge split (`pr-upload --upload-only` seed hatch). *Accept:* one formula's bottle published to `ghcr.io/automattic/kandelo-homebrew/...` from tap CI; remote-policy patrol pass.
- **C2. Tag/ABI + `:any` + in-keg `.kandelo/` receipt** wired into `brew bottle` output. *Accept:* a wasm32_kandelo (ABI-tagged) bottle with the receipt; guest-resolution **spike** green (or the exact tag fix identified).
- **C3. Lazy option-3 consumption** — lazy-archive fetch+extract of the published tar.gz bottle. *Accept:* a lazy VFS file materializes from a published bottle at runtime.

### Track D — Cleanup
- **D1. kd-yuef unblock** (gated on B + C): publish cpython/perl/erlang bottles; composites (kd-v3fs) go green. *Accept:* python/perl/erlang-vfs pass.
- **D2. Doc-correction:** fix PR #823 doc + the kd-1i0u note to match all §2 decisions (guest install in-scope; `:any`; GHCR parity; supersede "don't adopt test-bot/pr-pull"; pour = brew-in-Kandelo; lazy option 3; tap-owns-packages). *Accept:* doc merged/updated.

**Suggested order:** B1 (assess) + A0/A1 (tap layout + ruby) in parallel → A2/A3 + C1/C2 → B2/B3 → D1 → D2.

## 6. Appendix — brew-in-Kandelo assessment prompt (paste into a fresh worktree agent)

> You are driving brew-in-Kandelo to a usable end-to-end state — the critical path for Kandelo's Homebrew plan. Real upstream Homebrew runs INSIDE Kandelo (the kernel sandbox is the trust boundary) to install packages at VFS build time and at runtime. READ FIRST: /Users/brandon/src/kandelo/CLAUDE.md; docs/plans/2026-07-05-homebrew-handoff-record-and-execution-plan.md; docs/plans/2026-07-05-homebrew-bottle-publishing-design-checkpoint.md; docs/plans/2026-06-18-homebrew-runtime-bringup-design.md; docs/plans/2026-06-18-homebrew-portable-ruby-strategy.md. Follow the worktree policy, verification gates, and fork-instrument path (no Asyncify). KNOWN-GOOD (do not re-litigate): Ruby GC root-visibility merged (PR #718); psych/YAML works (PR #814); brew-config Ruby traps closed. A guest-brew boot probe exists at target/kd-sqw-homebrew/; live work is in sibling worktrees — find and read the latest before assuming. PHASE 1 (deliver before changing code): exercise `brew --version/config/doctor/tap` and `brew install <formula>` end-to-end on Node and (as feasible) browser; produce an evidence-backed ledger of what works/fails (reproducers + artifacts) and the exact remaining work, plus whether VFS-build-via-brew-in-Kandelo is prototyped anywhere. PHASE 2: root-cause the highest-value blockers (no demo shortcuts, no masking). ACCEPTANCE: EITHER guest `brew install <formula>` works end-to-end on Node (browser status recorded) with a reviewable PR to Automattic/kandelo, OR a precise gap analysis with the hardest blocker isolated by a minimal reproducer.

## 7. Pointers

- Design rationale: `docs/plans/2026-07-05-homebrew-bottle-publishing-design-checkpoint.md`.
- Runtime/pour design: `docs/plans/2026-06-18-homebrew-runtime-bringup-design.md`, `2026-06-18-homebrew-portable-ruby-strategy.md`, `2026-06-19-ruby-wasm-gc-root-visibility-design.md`, `2026-06-18-homebrew-vfs-builder-design.md` (Open Q #1 = link-manifest generator, obsoleted by brew-in-Kandelo).
- Lazy files: `docs/architecture.md` §Lazy Files/§VFS Images; `docs/package-management.md` §Rootfs lazy binary manifests.
- Code: `tools/xtask/src/homebrew_vfs_build.rs` (link-manifest replay, being replaced), `tools/xtask/src/homebrew_vfs_plan.rs` (`DEFAULT_PREFIX`), `tools/mkrootfs/`, `packages/registry/<name>/` (recipes → migrate to tap), memfs lazy files in `host/src/*`.
- Repos: `Automattic/kandelo` (platform), `Automattic/kandelo-homebrew` (tap; currently `Formula/hello.rb` + `Kandelo/` support).
- Prior research: PR #823. Merged Ruby: PR #718. Redirect: PR #814.
