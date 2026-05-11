# Phase D — Decoupled Package Builds, deferred follow-ups

> **Status:** logged, not started.
> **Parent design:** `docs/plans/2026-05-05-decoupled-package-builds-design.md` (§8 "Phase D").
> **Predecessors:** Phases A, A-bis, B-1, B-2, C all landed.

Phase C completed the resolver cutover and retired the legacy publish pipeline. The remaining work in §8 was explicitly deferred — none of it blocks the v7 release flow, but each track unblocks a distinct user-facing capability. This doc captures the three tracks, their acceptance criteria, and the design questions that still need answers, so they can be picked up independently.

The three tracks are **independent**: any can be done first. They are listed in the order that seems most useful to land, but there is no hard sequencing.

---

## Track 1 — Fork-PR staging support

### Why

Today, a PR from a contributor's fork goes through `staging-build.yml`'s `preflight` job, which short-circuits with `if: github.event.pull_request.head.repo.full_name == github.repository`. Fork PRs therefore produce no staging archives; the resolver on the merge-target branch falls through to source-build for every changed package. That's slow for the contributor and surprising for the reviewer (CI looks like it's "doing nothing").

The underlying constraint is permissions. The matrix flow's `amend-package-toml` step needs write access to push a bot branch and open the bot PR. `GITHUB_TOKEN` issued on a `pull_request` event from a fork has read-only scope, and the staging flow's `c2 pre-merge amend` shape (rewrite `package.toml`, push, open PR) can't be performed under it.

### Two viable shapes

**Shape A — bot PR retargets `main` instead of amending the fork branch.**
The bot PR's HEAD is a branch on the upstream repo (already what we do for same-repo PRs). The bot PR's BASE stays `main`. The only thing that changes is who owns the changes: the contributor's original PR remains untouched, and the bot PR squash-merges onto main in addition to (not instead of) the original PR. The contributor's PR closes as merged via the squash-merge resolution. Minor wiring: drop the `head.repo.full_name == github.repository` gate, route the bot-branch push through the upstream token (which is the default), confirm `gh pr create` from `pull_request` event context works against fork-base PRs.

**Shape B — `pull_request_target` event + PAT.**
`pull_request_target` runs in the upstream repo's context, so its `GITHUB_TOKEN` has write scope even for fork PRs. The catch: the workflow file that runs is the one on `main`, not the one in the fork's branch. So fork contributors can't change the workflow at the same time as they change package recipes. This is a security boundary, not a bug — but it has surprising UX (a fork PR that edits both `.github/workflows/*.yml` and `examples/libs/*/build-*.sh` would silently use main's workflow).

Plus a PAT (or fine-grained app token) with write scope on the upstream repo, stored as a secret. That's another moving piece to maintain.

### Recommended choice

**Shape A**, by elimination. Shape B's PAT and workflow-shadowing make it strictly more complex for the same benefit. The audit is just: confirm `gh pr create --head <bot-branch>` works when the original PR is from a fork; confirm the `merge-gate` status post on the bot PR's HEAD SHA still satisfies branch protection on `main`.

### Acceptance criteria

- A fork PR triggers `staging-build.yml` and produces archives in `pr-<N>-staging` exactly as same-repo PRs do.
- Applying `ready-to-ship` on a fork PR triggers `prepare-merge.yml` and opens the bot PR.
- The bot PR's merge auto-closes the contributor's fork PR via the squash-merge resolution (GitHub does this automatically when the bot PR's commits supersede the fork PR's diff).
- Branch protection on `main` continues to gate on `merge-gate=success`.

### Open questions

- Does `gh pr create --head <upstream-branch>` work cleanly from a `pull_request` event whose context is a fork PR? If the API rejects the cross-PR shape, fall back to opening the bot PR via `gh api /repos/.../pulls`.
- The contributor doesn't author the bot PR — they may want acknowledgement (commit `Co-Authored-By` line, comment on their PR linking to the bot PR, etc.). Decide before shipping.

### Estimated scope

One PR. ~200 lines of workflow YAML changes (drop the `head.repo.full_name` gate from `preflight`, `gate`, and any downstream check; add a guard against running secrets-bearing steps in fork context). Test by raising a fork PR against the repo from a throwaway account.

---

## Track 2 — `wasm-posix-pkg` CLI: source management

### Why

The infrastructure for third-party software sources already exists (`xtask build-index` emits `index.toml`, archives are content-addressed under stable URLs, the resolver parses URL-addressable archives). What's missing is the consumer-side CLI: a user who wants to install Doom from a fun-pack should be able to do

```bash
wasm-posix-pkg sources add https://github.com/<owner>/<repo>/releases/download/<tag>/index.toml
wasm-posix-pkg search doom
wasm-posix-pkg add doom@1.10
```

…without editing any TOML by hand. Today the resolver only walks `examples/libs/*/package.toml` in the in-tree registry. There is no API for "add an external source" or "search across registered sources".

### Architecture sketch

A new CLI binary, probably under `sdk/bin/wasm-posix-pkg` (mirrors the existing `wasm32posix-cc` etc. layout). The CLI maintains a per-user state file — likely `$XDG_CONFIG_HOME/wasm-posix-pkg/sources.toml`, falling back to `~/.config/wasm-posix-pkg/sources.toml`. The state file lists registered `index.toml` URLs:

```toml
[[source]]
name = "wasm-posix-fun-pack"
url = "https://github.com/<owner>/wasm-posix-fun-pack/releases/download/binaries-abi-v7/index.toml"
priority = 100  # higher wins on name conflict
```

The CLI resolves a package name by querying each source's `index.toml` (with a local cache keyed by `(source-url, ETag)`) and merging the results, with `priority` and explicit per-source qualifiers (`fun-pack:doom`) as tie-breakers. `wasm-posix-pkg add` produces an updated `package.toml` somewhere consumer-visible — exact landing spot is a design question (a local `vendor/` dir, a project-scoped `wasm-posix-pkg.toml`, etc.).

### Subcommands (minimal v1)

- `sources add <url>` — register an `index.toml`.
- `sources list` — print registered sources + their last-fetched timestamp.
- `sources remove <name>` — drop a source.
- `sources refresh [<name>]` — re-fetch `index.toml` and update the cache.
- `search <name>` — fuzzy search across registered sources; print `(source, name@version, arches)`.
- `add <source:name@version>` — resolve, fetch archive, install into the active project's package directory or a shared cache.

### Acceptance criteria

- `sources add` validates the `index.toml` URL (HTTP HEAD + parse) before persisting.
- `search` correctly surfaces packages from a synthetic in-tree test source.
- `add` produces a working install that the resolver consumes without further config.
- `sources list` survives a corrupt cache file (the CLI re-fetches; no panic).
- A user can install a non-first-party package without editing any TOML by hand.

### Open questions

- Where do consumed packages land? Same `examples/libs/<name>/package.toml` registry as first-party? A separate `vendor/<name>/package.toml`? Project-scoped vs. user-scoped?
- Sources without a manifest signature — what's the trust story? `archive_sha256` in `index.toml` is the integrity root, but the source URL itself isn't authenticated (HTTPS gives transport, not source identity). Defer signing to "Future work" but document the gap.
- Per-source `priority` semantics: highest-wins or first-match? Strongly recommend highest-wins (matches every other package manager).
- Multi-source name collision UX: error and require explicit `<source>:<name>`, or silently pick the highest-priority? Pick the latter with a warning, mirror apt's behavior.

### Estimated scope

Two PRs minimum: (a) state file + `sources` subcommands (read/write/refresh, no consume), (b) `search` + `add`. CLI infra is mostly straightforward Rust; the design questions on landing-spot and trust are the slow parts. ~1000 lines + tests.

---

## Track 3 — `wasm-posix-fun-pack` repo bring-up

### Why

Goal (c) of the parent design is "third-party software sources are first-class." The way to validate it is to bring up a real, separate-repo software source consuming the same `index.toml` flow first-party uses. Doom / NetHack / ScummVM are the canonical "fun-pack" candidates: they exercise the same matrix-build / publish / index-emit shape, but in an unrelated org/repo with no shared infra.

### Architecture sketch

A new repo, probably `<owner>/wasm-posix-fun-pack`, containing:

- `examples/libs/<game>/package.toml` for each ported game.
- A `.github/workflows/staging-build.yml` derived from the parent repo's, retargeting its own release tag (e.g. `fun-pack-abi-v7` instead of `binaries-abi-v7`).
- A `flake.nix` (or equivalent) reproducing the toolchain.
- An `index.toml` published as a release asset alongside each archive.

Critically, the fun-pack repo must NOT vendor the kernel or sysroot. It depends on `wasm-posix-kernel`'s SDK as an external toolchain. The flake pins the SDK version; the CLI's `sources add` picks up the fun-pack's `index.toml` like any other.

### Acceptance criteria

- The fun-pack repo's own `staging-build.yml` runs the per-package matrix and uploads to its own release.
- An `index.toml` is published per release.
- A consumer with the fun-pack source registered can `wasm-posix-pkg add fbdoom` and get a working install.
- Updates to `wasm-posix-kernel`'s ABI don't silently break the fun-pack (the fun-pack's `kernel_abi` field is the floor).

### Open questions

- Repo ownership: where does it live? Same GitHub org, separate user account, a community-owned `wasm-posix-pkg` org? Affects discoverability and bus factor.
- Toolchain sync: how does the fun-pack know when the parent kernel's `ABI_VERSION` bumps? A scheduled GHA that polls the parent's `crates/shared/src/lib.rs`? A webhook? Manual?
- License compatibility: fbDOOM, NetHack, ScummVM all have permissive-ish licenses but the fun-pack must surface them correctly in `[license]` blocks.

### Estimated scope

Multi-PR effort across two repos. Probably 2-3 weeks of part-time work. Best done after Track 2 (CLI) lands so the fun-pack has a real consumer to test against.

---

## Other future work (not Phase D)

Listed for completeness; tracked separately in `docs/package-management-future-work.md`:

- **Package signing** — cryptographic authenticity for `index.toml` and archives. `archive_sha256` is the integrity root today; signing extends to source identity.
- **Auto-update flow** — resolver detects newer versions and prompts the user.
- **Archive GC** — old archives accumulate forever; need a retention policy.
- **`kernel_abi` range/set declaration** — only relevant if a stable user-facing sub-ABI is introduced. Today the kernel ABI surface is too coupled to user binaries to support compatibility ranges safely.
- **Reproducibility-audit automation** — Phase B-1 ran the audit by hand for zlib + bash; the rest of the registry has no continuous verification.

---

## Picking the first track

If asked "which one first," **Track 1 (fork-PR support)** has the cleanest scope and the most concrete acceptance criterion (one fork PR runs the matrix end-to-end). It also unblocks external contributions, which is a quality-of-life win independent of the source-management story.

Track 2 (CLI) is the biggest user-visible win, but the landing-spot and trust questions can drag. Best done with focused design time, not as a side project.

Track 3 (fun-pack) is the validation lap — only worth doing once Track 2's CLI gives the fun-pack a real consumer.
