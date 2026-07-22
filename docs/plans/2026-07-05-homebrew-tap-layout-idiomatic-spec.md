# Homebrew-Idiomatic Tap Layout Spec (Track A0)

- Date: 2026-07-05
- Status: **DRAFT for Brandon review** (gate: report before proceeding to A1).
- Scope: the layout, formula shape, and shared-support contract for
  `Automattic/kandelo-homebrew` under the 2026-07-05 "real from-source tap"
  decision. This is the acceptance artifact for **Track A0** in
  `2026-07-05-homebrew-handoff-record-and-execution-plan.md`.
- Supersedes (in part): `2026-06-27-homebrew-tap-layout-metadata-schema-design.md`,
  and the sidecar/link-manifest portions of
  `2026-06-30-homebrew-registry-replacement-model.md` /
  `2026-06-28-homebrew-all-package-inventory-plan.md`. See §7 for exactly what
  changes.

## 1. Governing principle

Fidelity to Homebrew. A Kandelo formula must read like a **real from-source
Homebrew formula** a Homebrew maintainer would recognize: `desc`/`homepage`/
`url`/`sha256`/`license`/`depends_on`, a `bottle do` block, an `install` that
**builds from source**, and a `test do`. Everything Kandelo-specific — SDK
activation, the wasm cross-compile target, fork instrumentation, running a
`.wasm` under the kernel for `test` — lives behind a **`KandeloFormulaSupport`**
mixin, so the formula body stays idiomatic. Each place we cannot stay idiomatic
is called out as an explicit, documented **deviation** (§6).

## 2. Where we are today (the starting point A0 must move off)

- The **tap** (`Automattic/kandelo-homebrew`) holds only `Formula/hello.rb` +
  `Kandelo/` schemas/examples. `hello.rb`'s `install` activates the SDK, sets
  `WASM_POSIX_DEP_*`, then **shells out to
  `packages/registry/hello/build-hello.sh`**. That is a *bridge*, not
  build-in-`install`.
- **PR #814**'s `ruby.rb` is one step further: it `include`s a
  `KandeloPackageFormula` mixin (referenced as
  `Kandelo/formula_support/kandelo_package`) exposing
  `kandelo_build_package` / `kandelo_install_bin` / `kandelo_run_wasm`. But
  `kandelo_build_package("ruby", "build-ruby.sh", …)` **still shells out to the
  registry `build-ruby.sh`** (49 KB of porting logic). **That mixin does not
  exist in the fixture or the tap yet** — landing it is part of A0/A1.
- The real recipe content lives in `packages/registry/<name>/`:
  `package.toml` (identity/source/license/deps/outputs),
  `build.toml` (script path, cache-invalidation inputs, provenance/revision,
  binary index url), `build-<name>.sh` (the actual build), `patches/`, `demo/`
  or `test/`.
- Inventory (from #806): **73 packages** — 65 program, 7 library, 1 source;
  66 wasm32-only, 7 dual-arch. Sidecars are **additive** (never required for
  `brew install`).

So A0 is greenfield on the tap but has two concrete precedents to unify
(`hello.rb` bridge, `ruby.rb` mixin-bridge) and one metadata surface
(`package.toml`/`build.toml`) that needs a new idiomatic home.

## 3. Tap layout

```text
Automattic/kandelo-homebrew/
  README.md                         # real tap usage + the Kandelo boundary note
  Formula/
    <name>.rb                       # real from-source formula (build-in-install)
  Kandelo/
    formula_support/
      kandelo_formula_support.rb    # THE mixin (SDK/wasm/fork-instrument/test)
    patches/
      <name>/*.patch                # porting patches, applied idiomatically
    metadata.json                   # additive package-status index (generated)
    reports/<bottle>.provenance.json# additive provenance/validation evidence
    demo/<name>/*                   # optional Kandelo demo assets (see §5.3)
  .github/workflows/                # tap CI (Track C): build → publish → commit
```

Retired vs. the 06-27 scaffold: the `Kandelo/link/` link-manifest tree and
`link-manifest.schema.json` are **removed** — the pour is now real
brew-in-Kandelo, so there is no host-side link-manifest to replay (§7).
`Kandelo/metadata.json` (status index) and `provenance.json` survive as
**additive status/gallery/provenance** metadata only.

## 4. Formula shape (the contract)

Every formula:

1. `require_relative "../Kandelo/formula_support/kandelo_formula_support"` and
   `include KandeloFormulaSupport`.
2. Declares upstream identity idiomatically: `desc`, `homepage`, `url`,
   `sha256`, `license`, `depends_on "automattic/kandelo-homebrew/<dep>"`.
3. **No hand-written `bottle do` block pre-publish.** Bottle blocks are
   machine-generated on publish (Track C) via `brew bottle` / `pr-pull`, exactly
   as upstream Homebrew does — a hand-written placeholder sha256 makes a default
   `brew install` try to pour a nonexistent GHCR bottle and *fail* instead of
   building from source (decided during PR #1 review, 2026-07-07). When Track C
   publishes, CI injects `bottle do` with `root_url
   "https://ghcr.io/v2/automattic/kandelo-homebrew"` and `wasm32_kandelo` /
   `wasm64_kandelo` sha256 lines (`:any` per the 2026-07-05 tag decision;
   `hello.rb`'s `:any_skip_relocation` normalizes to `:any` in Track C2).
4. `def install` **builds from source** (§4.1), using mixin helpers only for
   the Kandelo-specific mechanics.
5. `test do` runs the built artifact **through the kernel** via
   `kandelo_run_wasm` and asserts real behavior.

### 4.1 build-in-`install`: the two tiers

**Tier 1 — idiomatic (default, target for the ~65 autotools/CMake packages).**
The formula's `install` uses standard Homebrew steps; the mixin only supplies
the cross-compile *environment* and a post-build fork-instrument hook:

```ruby
def install
  kandelo_wasm_build do            # mixin: activates SDK, sets CC/AR/CFLAGS/…
    system "./configure", *kandelo_std_configure_args   # --prefix=#{prefix}, host/target triple
    system "make"
    system "make", "install"
  end
  kandelo_fork_instrument_dir(bin) # mixin: run scripts/run-wasm-fork-instrument.sh on wasm outputs
end
```

No `build-<name>.sh`. Patches use idiomatic `patch do`/`resource`. This is what
"real from-source formula" means and where we default.

**Tier 2 — ported-source escape hatch (only where Tier 1 genuinely cannot express
the port).** Some packages (ruby, perl, cpython, php) carry hundreds/thousands
of lines of Kandelo-specific build logic in `build-<name>.sh` that is not a
clean `configure && make`. For these the **recommended** end-state is: migrate
that logic into the formula's `install` as explicit Ruby steps (staged
`resource`s, `patch do`, ordered `system` calls) calling the same mixin
environment — **decompose the script, don't wrap it**. Where a bounded chunk of
that logic is truly not reducible to idiomatic steps in the first pass, it is a
**documented deviation** (§6), not the silent default. **This is the sharpest
open decision for Brandon — see §8.Q1.**

### 4.2 `KandeloFormulaSupport` mixin contract

Single file, `Kandelo/formula_support/kandelo_formula_support.rb`. Replaces the
ad-hoc `KandeloPackageFormula` name from #814 (rename; same role). Public API:

| Helper | Responsibility |
|---|---|
| `kandelo_wasm_build(&blk)` | Resolve the Kandelo checkout (`HOMEBREW_KANDELO_ROOT`), prepend `sdk/bin`/node/LLVM to `PATH`, export the wasm cross-compile env (`WASM_POSIX_*`, CC/AR/RANLIB/CFLAGS, target arch from `HOMEBREW_KANDELO_ARCH`), run the block, restore env. The single place SDK/toolchain activation lives. |
| `kandelo_std_configure_args` | Homebrew-idiomatic configure args pinned to the wasm target + `--prefix=#{prefix}`. |
| `kandelo_fork_instrument_dir(dir)` / `_file(f)` | Run `scripts/run-wasm-fork-instrument.sh` on produced `.wasm` (no Asyncify). No-op for `fork_instrumentation = "disabled"` packages (e.g. hello). |
| `kandelo_install_bin(out, wasm, name)` | Install a `.wasm` as an executable `bin/<name>` (mode 0755). |
| `kandelo_run_wasm(bin, argv, env:)` | Run a built `.wasm` under the Node kernel host for `test do` (the `examples/run-example.ts` path today; browser via the Track-C smoke harness). |
| `kandelo_build_package(...)` *(transitional)* | The current shell-out bridge (wraps `build-<name>.sh`). **Deprecated by design**; kept only so Tier-2 formulae can land before their `install` is fully decomposed. Every use is a tracked §6 deviation. |

The mixin is the *only* Kandelo-aware code in the tap's Ruby; formula bodies
call it and otherwise look like `homebrew/core` formulae.

## 5. Where the `package.toml` / `build.toml` / demo data lands

The registry carries three kinds of data; each gets an idiomatic home:

### 5.1 Data Homebrew already owns → **Formula attributes** (drop the duplicate)

- `package.toml` `version`/`[source].url`/`sha256`/`[license]` → `url`/`sha256`/
  `version`/`license`.
- `depends_on` → `depends_on "automattic/kandelo-homebrew/<dep>"`.
- `[[outputs]]` install layout → the `install` method's `bin.install` /
  `lib.install` steps.
- `[build].script_path` → the `install` body (Tier 1) or a §6 deviation (Tier 2).

### 5.2 Kandelo build/publish state Homebrew has no native slot for → **additive `Kandelo/` metadata**

- `kernel_abi` → encoded in the **bottle tag / release** (ABI-in-tag, 2026-07-05),
  surfaced in `Kandelo/metadata.json` status index, not a formula field.
- `fork_instrumentation` (`enabled`/`disabled`) → a small formula-visible signal
  the mixin reads (class const or DSL helper), because `install` needs it; also
  recorded in provenance.
- `cache_key_sha` / `build.toml` provenance/revision / cache-invalidation
  `inputs` → **provenance sidecar** (`Kandelo/reports/…provenance.json`) +
  in-keg `.kandelo/` receipt (2026-07-05 "bottle self-describing"). Not in the
  formula.
- `binary [index_url]` → obsoleted for Homebrew packages by GHCR bottle
  resolution (Track C). Kept only for any package still served by the legacy
  binary index during migration.

**Guiding rule (from #806/#805, preserved):** sidecars are *additive*. A stock
guest `brew install <formula>` must succeed reading **only** Formula Ruby +
`bottle do`; no `Kandelo/` file is on the install path.

### 5.3 Demos / smokes → `Kandelo/demo/<name>/` (tap) or `test do` (Homebrew)

- Behavioral smoke that proves the package works (ruby's YAML round-trip) →
  **`test do`** via `kandelo_run_wasm` (idiomatic; runs on `brew test`). This is
  the primary correctness gate and travels with the formula.
- Richer demo assets (the current `demo/serve.ts`, `demo/yaml-smoke.ts`) →
  `Kandelo/demo/<name>/` in the tap, as Kandelo-namespaced extras (not on the
  `brew` path). **Open Q §8.Q3:** do demos live in the tap at all, or stay in
  main under `apps/browser-demos` and reference the tap-built artifact?

## 6. Deviations register (fill as we migrate)

Every non-idiomatic choice gets one row: *what*, *why it can't be idiomatic*,
*the boundary it belongs to*, *exit criteria*. Seeds:

| Deviation | Why | Boundary | Exit |
|---|---|---|---|
| `HOMEBREW_KANDELO_ROOT` env points `install` at a Kandelo checkout | The SDK/toolchain is worktree-local, not a brew dep yet | Build-env plumbing | SDK becomes a real tap formula/bottle dep |
| Tier-2 `kandelo_build_package` shell-out for ruby/perl/cpython/php | Large ported build not yet decomposed to idiomatic steps | Porting friction | `install` rewritten to Tier-1-style steps |
| `wasm32_kandelo`/`:any` synthetic tag | Homebrew has no wasm/Kandelo platform | Tag/ABI model | none — this is the product |
| Fork instrumentation post-build pass | wasm has no native fork; no Asyncify | Platform ABI | none — required |
| Formulae `require_relative` the mixin → Homebrew's untrusted-tap gate fires (`brew info`/install refuse until `brew tap`+trust) | `hello.rb` avoided it by inlining everything; a shared mixin can't be inlined | Homebrew tap-trust model | document a `brew trust`/tap-install consumer step, or sign the tap (A1 finding, PR #1) |
| Mixin file needs `# typed: strict` for Homebrew rubocop, but calls Formula methods it doesn't define (would fail real `srb tc`) | Homebrew's audit runs Sorbet-sigil rubocop; support code isn't a Formula | Homebrew audit tooling | tap `.rubocop.yml` relaxing Sorbet sigils for `Kandelo/`, or commit to real `sig` blocks (A1 finding, PR #1) |

## 7. What this supersedes (reconciliation)

- **06-27 scaffold:** keep `Formula/` + `Kandelo/` top-level split, the
  provenance/metadata *status* schemas, and the "sidecars don't gate install"
  rule. **Drop** the `Kandelo/link/` link-manifest tree +
  `link-manifest.schema.json` and the "never evaluate Formula Ruby to learn
  layout" premise — under brew-in-Kandelo the pour **is** real `brew` running in
  the sandbox (2026-07-05), so there is no host-side manifest replay to feed.
- **06-30 registry-replacement / 06-28 inventory:** their "Formulae
  authoritative, sidecars additive, failures visible, Node+browser required"
  contracts are **kept**. Their retained `Kandelo/link/*` pour-plan sidecar is
  **superseded** by brew-in-Kandelo pour. Their "keep Kandelo's custom GHCR
  upload adapter (kd-uqyg)" note is **superseded** by the 2026-07-05 decision to
  publish with `skopeo` via `brew pr-upload`/`pr-pull` (a **Track C** concern,
  flagged here for consistency).

## 8. Open decisions for Brandon (blocking A0 sign-off)

- **Q1 (sharpest).** For Tier-2 packages (ruby/perl/cpython/php), do we commit to
  **decomposing** the big `build-<name>.sh` into idiomatic `install` steps as the
  bar for "migrated" (higher fidelity, more work per formula), or accept a
  **documented `kandelo_build_package` shell-out** as a standing bounded
  deviation for these heavy ports (faster migration, less idiomatic)? A0's
  recommendation: **decompose as the target, allow the shell-out as an explicit,
  registered §6 deviation for the first landing of each heavy formula**, with an
  exit criterion — so migration isn't blocked but the debt is visible. Confirm.
- **Q2.** Mixin name/home: `Kandelo/formula_support/kandelo_formula_support.rb`
  with module `KandeloFormulaSupport` (renaming #814's `KandeloPackageFormula`).
  OK, or keep #814's name?
- **Q3.** Do Kandelo demos live in the **tap** (`Kandelo/demo/`) or stay in
  **main** (`apps/browser-demos`) referencing tap-built artifacts? (The handoff
  doc lists both as candidates.)
- **Q4.** SDK/toolchain dependency: keep the `HOMEBREW_KANDELO_ROOT` env bridge
  for now (recommended — matches `hello.rb`), or design the SDK-as-tap-dep shape
  in A0? Recommend: env bridge now, SDK-as-dep as a later item.

## 9. A1 exemplar (ruby, once A0 signs off)

Convert PR #814's `ruby.rb` into the first real tap formula: add
`Kandelo/formula_support/kandelo_formula_support.rb`, port `ruby.rb` to
`include KandeloFormulaSupport`, keep the psych/YAML round-trip as the `test do`
gate, whole-move `packages/registry/ruby/` build logic per the Q1 decision, open
a **tap PR**, and redirect/close #814 (do not merge ruby to main). Acceptance:
`brew install ruby` builds ruby.wasm from source under tap CI; Node smoke
(YAML round-trip) green; nothing ruby lands in main.

## 10. Acceptance for A0

A documented layout (this doc) + one converted exemplar formula (ruby, §9 / A1).
This doc is the layout half; A1 delivers the exemplar. Sign-off = Brandon
resolves §8 and approves the tap-side landing.
