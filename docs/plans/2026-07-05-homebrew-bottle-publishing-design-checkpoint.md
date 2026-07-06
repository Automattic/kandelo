# Homebrew Bottle-Publishing Design — In-Progress Checkpoint

- Date: 2026-07-05
- Status: **IN-PROGRESS design discussion** (Brandon @brandon ↔ designer). Living document — update as the discussion continues so it always reflects latest state.
- Purpose: durable capture so little is lost if the session resets. This **supersedes several conclusions** of the prior research doc (`docs/plans/2026-07-01-homebrew-builtin-vs-custom-bottle-publishing-research.md`, PR #823); that doc still needs correcting (see §6).
- Mode: deliberate, facet-by-facet, discuss-first-then-implement. No implementation started yet.

## 1. Goal and scope

Design how Kandelo **publishes and consumes Homebrew-style packages (bottles)**.

**Governing principle (locked, Brandon): fidelity to Homebrew.** Kandelo packages are first-class Homebrew citizens — hosted where Homebrew hosts (GHCR/OCI), published with Homebrew's own tooling, and resolvable by a stock guest `brew` identically to `homebrew/core`. "Use the real thing, the real way; Kandelo's sandbox is what makes running real brew safe."

Scope: bottle format/tags/cellar, GHCR hosting, the publish permission model, the VFS build/pour model (build-time + runtime), lazy on-demand materialization, and the near-term unblock of **kd-yuef** (VFS-critical language sidecars: cpython/perl/erlang).

Non-goals: not reviving the custom `oras` blob path; not a TS/Rust reimplementation of `brew` pour; not changing the fork/ABI machinery.

## 2. Facets and status

| # | Facet | Status | Decision |
|---|-------|--------|----------|
| 1 | wasm32 tag/cellar fit | ✅ done | Tags collapse arch×OS → `{wasm32,wasm64}_kandelo`. Corrections folded: two consumers both honor pour semantics; trust rationale for not running Formula Ruby in the raw host/browser; **`:any`** relocatable (not `:any_skip_relocation`). |
| 2 | kd-yuef blocked operationally, not architecturally | ✅ done | Block = permissions/plumbing (privileged manual publish + uncommitted formulae + `TAP_SOURCE` bug), **not** custom-vs-builtin tooling. |
| 3 | Build/publish permission split | ✅ done | = bring bottle publish into Kandelo's **existing PR→merge→release model**. The current `workflow_dispatch`-only publish is the **outlier = kd-yuef root cause**. |
| a | GHCR vs GitHub Releases | ✅ resolved | **GHCR-native, exact Homebrew parity.** GH Releases = legacy *present*, retired for bottles. |
| b | Split-now vs hand-crank | ✅ resolved | **b2′: seed-then-automate** — publish bottles now (no-regret), one-time privileged seed, automate the split next. |
| c | wasm64 asymmetry / `:any` cost | ✅ resolved | Kernel is wasm32 but **runs wasm64 binaries as processes** → `wasm64_kandelo` is a co-equal live tag. Both `:any`. `:any` cost ≈ 0 today (fixed prefix ⇒ no relocation). |
| d | Open thread | ✅ empty | Nothing further from Brandon. |
| — | Pour model | ✅ corrected | **Real Homebrew inside Kandelo does the pour.** Link-manifest replay is *replaced*, not preserved. Gated on Ruby. (See §3.) |
| — | Lazy files | ✅ decided | Materialize VFS files on demand **from the published bottle**. **Option 3** (whole tar.gz archive lazy fetch) now; **option 2** (derived per-file/zip rep) documented as the restore path. (See §3.) |
| R | Recommendation | 🟡 in progress | Synthesized below (§5); final pending the sequencing decision. |
| D | Doc-correction | ⬜ pending | Fix PR #823 doc + kd-1i0u note (§6). |

## 3. Decisions locked

**Hosting & repo boundary**
- Bottles/packages → **GHCR/OCI**, exact Homebrew parity, guest-`brew`-resolvable like `homebrew/core`.
- Packages + live tap state (Formulae, `bottle do` blocks, provenance) + **GHCR images** → **`Automattic/kandelo-homebrew`** (the tap). The main repo **`Automattic/kandelo`** owns only tooling (schemas, validators, workflow generator, tap fixture/template).
- GHCR namespace mirrors the tap (≈ `ghcr.io/automattic/kandelo-homebrew/<formula>`; exact path = owed source-verification).
- **No binaries in git.** Bottle *bytes* → GHCR; only bottle *blocks* (text DSL) + Formulae → the tap git repo. This is exactly what Homebrew does.

**Formulae + recipes → the tap; whole-move package PRs (2026-07-05, Brandon)**
- The tap is the **sole home and sole edit point** for full package definitions: `Formula/<name>.rb` **plus** the build recipe (`packages/registry/<name>/` — build script, `package.toml`, `build.toml`, demos). The main-repo `homebrew/kandelo-homebrew/` fixture is **retired**; formulae stop landing there. Parity end-state: the tap is a real Homebrew tap of real from-source formulae; `Automattic/kandelo` is the platform they build on.
- **Mechanics:** fork the recipes into the tap now; **whole-move** package-definition PRs to the tap (recipe+formula co-locate ⇒ no split). The few *platform* PRs that only incidentally touch formulae (framebuffer/browser-smoke #819/#817/#816) stay in main and **shed** their formula edits.
- **Transition discipline (avoids drift):** tap = single edit point; main keeps a **synced/referenced** copy of the recipes (subtree or generated sync, mechanism TBD) so main's rootfs/VFS/CI builds keep working — `packages/registry` is load-bearing for those today. **Retire main's copy only when brew-in-Kandelo lets main consume packages from the tap.**
- **Open design points:** tap layout for recipes relative to `Formula/`; the tap→main SDK/xtask dependency wiring (correct parity shape); the sync mechanism.
- **First instance:** #814 (`ruby.rb` + `packages/registry/ruby/`) whole-moves to the tap (must NOT merge to `Automattic/kandelo`).

**Tooling**
- Produce bytes with `brew … --build-bottle` + `brew bottle`.
- Publish to GHCR with **`skopeo`** via `brew pr-upload` / `pr-pull` (Homebrew's own uploader — `Homebrew/brew` `github_packages.rb`). `skopeo` is a **publish-side** dep only (install side = plain OCI HTTP).
- `pr-upload --upload-only` = privileged **maintenance/seed** hatch (first-bottle seeding, bulk ABI re-bottle). PR→merge→`pr-pull` = steady-state contributor path.

**Permission split**
- = Kandelo's existing **PR→merge→release** model, run in the **tap repo's** CI: unprivileged build/validate on the PR; privileged `skopeo` publish + tap commit on maintainer merge.
- `packages:write` token now **provisioned by Brandon**.

**Tag / ABI model**
- Synthetic `:kandelo` Homebrew system; tags `{wasm32,wasm64}_kandelo`.
- **Kernel ABI generation is encoded in the platform tag** (kernel ABI ≈ macOS version: both say "which platform generation is this binary compatible with"). Multiple ABIs coexist as distinct tags. Not `rebuild`, not per-ABI taps.
- **`:any`** relocatable for both arches (normalized; the wasm64 fixture's absolute cellar was an inconsistency). Cheap because everything targets the single fixed prefix.

**Bottle self-description (sidecar decomposition)**
- Extrinsic identity (`url`/`sha256`/`cellar`/`rebuild`) → brew's `bottle do` (stop duplicating in a sidecar).
- Intrinsic pour data (`link_manifest`/`fork_instrumentation`/`cache_key_sha`) → an in-keg `.kandelo/` receipt (ships inside the bottle; keeps git text-light).
- Status (`browser_compatible`) → a **publish gate** in the test phase, not a stored field.

**Pour model (corrected)**
- **One implementation: real Homebrew running inside Kandelo** (the sandbox is the trust boundary, so this is safe even in the browser).
  - **Build-time VFS:** host runs Kandelo → brew-in-Kandelo installs the packages → **save the resulting VFS image** (`saveImage()`), preserving heavy files as lazy references.
  - **Runtime:** guest `brew` installs on demand, in Kandelo.
- The committed host-side Rust **link-manifest replay** (`tools/xtask/src/homebrew_vfs_build.rs`) is the mechanism being **replaced**, not preserved. It exists today and works without brew; the target routes through brew-in-Kandelo.
- **Gated on Ruby** (see §4).

**Lazy materialization**
- Lazy files/archives are a first-class, already-built VFS feature (`docs/architecture.md` §Lazy Files/§VFS Images; memfs; mkrootfs manifest; `docs/package-management.md` §Rootfs lazy binary manifests). VFS image format carries a lazy-entries section (`{ino,path,url,size}`); `saveImage()` preserves URL refs or `materializeAll`.
- Lazy files materialize **from the published bottle**. **Decision: option 3** — extend the lazy-*archive* path (zip-only today) to fetch+extract a **whole tar.gz bottle** on first access to any member, for Homebrew-sourced files (coexists with, does not remove, the existing per-file lazy path for other sources).
- **Document clearly:** option 2 (a per-file/zip representation *derived* from the canonical tar.gz bottle — the bottle stays tar.gz) is the sanctioned way to **restore per-file lookup**. Reconsideration trigger: whole-bottle fetch measured too heavy for the browser on large kegs. (Homebrew bottles are canonically tar.gz — a gzip stream with no random access; zip is not a supported bottle format. tar.gz ⇒ whole-archive; zip ⇒ per-file.)

**Rollout**
- **b2′**: publish the cpython/perl/erlang bottles now (needed under both the current consumer and the target lazy source — no-regret); seed via one-time privileged `pr-upload --upload-only`; automate the split next. Reject b1 (block P1 on the automation lift) and old-`oras` hand-crank (non-parity throwaway).

## 4. Open questions in flight

1. **Sequencing — RESOLVED (2026-07-05, Brandon): wait for brew-in-Kandelo.** kd-yuef does **not** take the transitional link-manifest unblock; the link-manifest replay path is abandoned, not kept alive. kd-yuef's unblock now depends on brew-in-Kandelo being usable.
2. **Ruby status — CORRECTED (bead ground truth; the earlier committed-checkout snapshot was stale).** The GC root-visibility / `wasm-local-root-spill` work is **DONE and MERGED** — PR #718 merged to main 2026-06-24 (kd-drt.2/kd-drt.9/kd-26r closed); URI/RubyGems GC traps fixed. Psych/YAML **works at runtime** (psych 5.3.1, libyaml 0.2.5, YAML round-trip verified on Node via kd-egn1; psych on main via #774); **PR #814 (open, non-draft, base=main)** adds the psych/YAML `ruby.rb` formula, reconciled with #810, held open only on the kd-yuef bottle/browser gate. brew-config Ruby traps closed (kd-e8g/kd-xmh/kd-9jd/kd-nfr/kd-drt.13/kd-v8m/kd-bsj). **So Ruby is NOT a distant long-pole.** The real remaining critical path is the **brew-in-Kandelo *integration*** (guest `brew install`/doctor/tap end-to-end + driving the VFS build via brew-in-Kandelo) — the in-progress experiment (`target/kd-sqw-homebrew/` boot probe + sibling worktrees), whose exact state needs assessment. A dedicated agent prompt for this was produced (assess-first, then drive).
3. **Lazy granularity.** Option 3 now; option 2 (per-file/zip derived rep) if whole-bottle fetch too heavy — needs measurement.
4. **Link-manifest generator** (design Open Q #1 in `docs/plans/2026-06-18-homebrew-vfs-builder-design.md`): **unbuilt** (only synthetic test fixtures). Under the target it becomes brew-in-Kandelo's output; near-term for kd-yuef it may need a stopgap generator.
5. **Owed verification against `Homebrew/brew` source:** `github_packages.rb`/`skopeo`; `pr-upload`/`pr-pull` standalone + synthetic-tag handling; GHCR path derivation for the tap; whether `brew bottle` has any non-tar.gz format flexibility (settles option 2's "zip").
6. **Transitional consumer:** keep the link-manifest replay path alive until brew-in-Kandelo lands, or not?

## 5. In-progress Recommendation

Parity-first, native-only publish + brew-in-Kandelo consume:

1. **Publish** cpython/perl/erlang bottles to GHCR under `Automattic/kandelo-homebrew` via `brew bottle` + `skopeo`/`pr-upload`. No `oras`, single native layout.
2. **Split** the publish along Kandelo's existing PR→merge→release model in the tap repo (unprivileged build on PR; privileged publish on merge). `--upload-only` for seeding/maintenance.
3. **Tags:** `{wasm32,wasm64}_kandelo`, ABI generation in the platform tag, `:any`.
4. **Bottle self-describing:** `bottle do` + in-keg `.kandelo/` receipt; browser smoke as a publish gate.
5. **Pour:** real Homebrew inside Kandelo — build-time install→`saveImage()`, runtime guest install. Replace the link-manifest replay.
6. **Lazy:** option 3 (whole tar.gz archive) now; option 2 documented as the per-file restore path.
7. **Rollout:** b2′ seed-then-automate.

**Publish track = no-regret (do now). Consume/pour track = gated on Ruby.** Final recommendation pending the §4.1 sequencing decision.

## 6. Next steps

1. **Migrate Formulae + build recipes → the tap** (Brandon-confirmed 2026-07-05): design tap layout + sync mechanism; fork recipes; whole-move package PRs starting with #814; retire the main fixture; coordinate with mayor (convoy-owned PRs). See §3. *(Sequencing is RESOLVED — wait for brew-in-Kandelo; see §4.)*
2. Consolidate the **Recommendation** facet.
3. **Doc-correction:** fix `docs/plans/2026-07-01-homebrew-builtin-vs-custom-bottle-publishing-research.md` + the kd-1i0u note — guest `brew install` is **in-scope** (not "VFS builder is terminal consumer"); `:any` (not `:any_skip_relocation`); **native GHCR/parity**; supersede "do not adopt `test-bot`/`pr-pull`" (adopt the PR→merge→`pr-pull` split); pour = brew-in-Kandelo; lazy = option 3.
4. **Verification pass** against `Homebrew/brew` source (§4.5).
5. Stand up **implementation beads** with dependency edges: b2′ seed (kd-p3hr formula checkpoint = long-pole), tap-repo PR→merge automation, synthetic-`:kandelo`-tag spike, and the Ruby GC/YAML track linkage (kd-5mb + the `wasm-local-root-spill` work).

## 7. Pointers

- **PR #823** (draft, Automattic/kandelo): the prior research doc — being corrected.
- **Ruby/brew PRs:** PR #718 (Ruby 4 + wasm-local-root-spill) **MERGED** 2026-06-24; PR #814 (ruby psych/YAML formula) **OPEN/non-draft**, code-done, gated on kd-yuef; PR #810 (language runtime formulas) OPEN, reconciled to not touch Ruby.
- **brew-in-Kandelo:** guest-brew boot probe `target/kd-sqw-homebrew/`; runtime-bringup design `docs/plans/2026-06-18-homebrew-runtime-bringup-design.md`; live work in sibling worktrees. This integration — not the Ruby runtime — is the remaining critical path for the "wait for brew-in-Kandelo" decision.
- **kd-1i0u** (closed): research bead; `github_pr` = #823; worktree = this one.
- **kd-yuef** (P1, blocked): VFS-critical language sidecars (cpython/perl/erlang).
- **kd-1mr**: umbrella convoy (homebrew-all).
- **kd-p3hr**: worktree holding the uncommitted cpython/perl/erlang Formulae (checkpoint long-pole for b2′).
- **kd-v3fs**: composite VFS packages (downstream of kd-yuef).
- **kd-5mb**: libyaml/Psych fix (Ruby gate).
- Ruby: `packages/registry/ruby/` (4.0.5, ABI-15, fork-instrumented). GC design: `docs/plans/2026-06-19-ruby-wasm-gc-root-visibility-design.md`.
- Code: `tools/xtask/src/homebrew_vfs_build.rs` (current link-manifest builder), `tools/xtask/src/homebrew_vfs_plan.rs` (`LinkManifest`; `DEFAULT_PREFIX="/home/linuxbrew/.linuxbrew"`), `tools/mkrootfs/` (VFS serialization), memfs lazy files in `host/src/*`.
- Docs: `docs/architecture.md` §Lazy Files/§VFS Images; `docs/package-management.md` §Rootfs lazy binary manifests; `docs/plans/2026-06-18-homebrew-vfs-builder-design.md` (Open Q #1 = link-manifest generator); `docs/plans/2026-06-18-homebrew-runtime-bringup-design.md`; `docs/plans/2026-06-18-homebrew-portable-ruby-strategy.md`.
- Guest-brew probe evidence (in-progress experiment, not shipped): `target/kd-sqw-homebrew/` (booted upstream Homebrew image); live work in sibling worktrees outside the main checkout.
