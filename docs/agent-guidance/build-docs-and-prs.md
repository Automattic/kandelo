# Build, Documentation, And PR Contract

## Build And Dev Shell

The build environment is part of the platform contract. Build and verification
commands should run from repo-declared tools, not undeclared host state.

Use the canonical dev shell for build and verification:

```bash
scripts/dev-shell.sh bash scripts/build-musl.sh
scripts/dev-shell.sh bash build.sh
scripts/dev-shell.sh bash
```

Do not use bare `nix develop` for build verification. `scripts/dev-shell.sh`
uses `nix develop --ignore-environment` with a curated keep-list so undeclared
host tools do not leak into builds. If a build fails with "command not found"
inside the dev shell, add the tool to `flake.nix` rather than expanding PATH or
the keep-list. Change the keep-list only for workflow context such as auth or
dispatch inputs, not for build tools.

Direnv is acceptable as a local interactive convenience when it loads the repo
flake, but it is not the verification contract. For build or test results you
intend to claim, use `scripts/dev-shell.sh` or run the command from a shell
entered through `scripts/dev-shell.sh bash`.

`scripts/dev-shell.sh` realizes the shell closure with `--command true` before
running your command, and aborts if Nix starts building the toolchain from
source. That is not build work: it means the binary cache is unhealthy, and
Nix has silently fallen back to bootstrapping `stdenv` (bootstrap-tools,
binutils, gcc, glibc), which takes hours and never fails on its own. The
script retries against a recovered cache and then reports the substituter as
the failure it is. Set `WASM_POSIX_ALLOW_SOURCE_BOOTSTRAP=1` only when you
genuinely intend to bootstrap on a system `cache.nixos.org` does not serve.

CI installs Nix through `.github/actions/setup-nix`, the single place where
substituter settings live. The three `reusable-*.yml` workflows are
`workflow_call`-only and check this repo out into a subpath, so they cannot
reference a relative action and duplicate those settings inline; keep the two
in sync. Every `staging-build.yml` job also carries `timeout-minutes`, so a
degraded substituter fails fast rather than burning a six-hour runner.

## CI Action Pinning

Every third-party action in `.github/` must be pinned to a full 40-character
commit SHA, with the human-readable version in a trailing comment:

```yaml
uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
```

A tag or branch ref is a promise the upstream owner can rewrite. `@v4`, `@v7.0.0`,
and `@master` all re-resolve on every run, so the code CI executes is whatever
that ref points at today, not what was reviewed. Anyone who can move the tag can
change what runs in a job that holds `GITHUB_TOKEN` and repository secrets. A tag
that looks exact is not exact: `v7.0.0` is still a mutable Git tag, not a content
address. Pin the SHA and the workflow runs the code that was reviewed, always.

Pin to the commit the ref resolves to **today**. Pinning is not the place to take
an upgrade: a pin commit that also bumps a version hides a behavior change behind
a security cleanup. Land the pin first, take the bump as its own change.

Each action gets exactly one version across the whole repo. A new workflow that
copies a `uses:` line from an older file reintroduces a version Dependabot has
already moved past, and because Dependabot bumps what it finds rather than
converging versions, the split then persists silently -- that is how
`actions/checkout` ended up on both v6.0.2 and v7.0.0, and `actions/cache` on
both v5.0.5 and v5.1.0. When adding a workflow, copy the `uses:` line from a
current one, and check for splits:

```bash
grep -rhoE "^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^[:space:]./][^[:space:]]*@[0-9a-f]{40}" .github/ \
  | sed -E "s/^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*//" | sort -u \
  | awk -F@ '{c[$1]++} END {for (a in c) if (c[a]>1) print "split: " a}'
```

Before unifying a split, read the upstream release notes for the versions being
crossed and check the change actually applies here. `actions/checkout` v7 blocks
fork-PR checkout under `pull_request_target` and `workflow_run`; that was safe to
adopt only because no workflow in this repo uses either trigger.

The two Homebrew publisher workflows are the deliberate exception: they pin
`actions/checkout` to v6.0.2 while the rest of the repo is on v7.0.0. Their
build, plan, upload, and index steps are frozen by a content digest in
`scripts/check-homebrew-publish-workflow-trust.rb`, so any edit to those steps
-- including a version bump or an added `with:` key -- fails the trust check
until the digest is regenerated in the same reviewed change. Do not converge
`reusable-homebrew-bottle-publish.yml` or `reusable-homebrew-bottle-maintenance.yml`
as a side effect of a repo-wide sweep, and do not add inline substituter tuning
to them the way the other Nix entry points carry it. Version changes to those
two files belong in a dedicated change that updates the digest and re-runs the
trust check. The split-audit above still expects one SHA per action; this pair
is the one documented deviation.

Same-repo references are the one exception. `uses: ./.github/actions/setup-nix`
and `uses: ./.github/workflows/reusable-*.yml` cannot carry `@sha` — GitHub
resolves them at the commit the workflow is already running, so they are pinned
by construction.

Pins are kept current by `.github/dependabot.yml`, which watches the
`github-actions` ecosystem at the repo root and under `/.github/actions/**` (the
composite actions), and raises grouped update PRs. That is what keeps SHA pinning
from decaying into permanently stale actions. Do not "fix" a stale pin by
reverting to a tag; take the Dependabot PR, or bump the SHA deliberately.

To audit, list every ref and look for any non-local one that is not a 40-hex SHA.
Anchor `uses:` to the start of the line: an unanchored match also hits the
`statuses: read` / `statuses: write` keys in `permissions:` blocks.

```bash
grep -rhoE "^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^[:space:]]+" .github/ \
  | sed -E "s/^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*//" | sort -u \
  | grep -v '^\./' | grep -vE '@[0-9a-f]{40}$'
```

Empty output means every third-party action is pinned.

When already inside `scripts/dev-shell.sh bash`, run the build commands
directly:

```bash
bash scripts/build-musl.sh   # Build wasm32 musl sysroot when libc overlay/glue changes
bash build.sh                # Build kernel wasm, host TypeScript, and programs
scripts/build-programs.sh    # Rebuild test/example C programs
```

`bash build.sh` does not rebuild musl. After editing `libc/musl-overlay/` or
`libc/glue/channel_syscall.c`, run `scripts/build-musl.sh` before relying on
`build.sh`, Vitest, or conformance tests. Otherwise user programs can link
against a stale `sysroot/lib/libc.a`, hiding or inventing syscall, ABI, and
libc behavior.

## Documentation And PRs

PR titles, PR descriptions, and commit messages should lead with the purpose of
the work: the platform contract, user-visible behavior, system invariant, or
project capability being changed or protected. Every PR description must begin
its substance with a plain-language `## Why` section. Put `## What changed`,
implementation details, validation, and rollout information after it. The Why
section must explain:

- what currently fails, is risky, or is unnecessarily difficult;
- who or what is affected; and
- why the change matters to Kandelo's users, platform contracts, or maintainers.

Write for a junior developer who has not followed the incident or earlier PRs.
Define necessary terms, expand acronyms on first use, and use a concrete example
when it makes the failure easier to understand. Links may supply evidence or
history, but the reader must not need to open them to learn why the PR exists.
Avoid unexplained repository shorthand, internal task names, and descriptions
that start with file edits or implementation mechanics. Preserve technical
precision while explaining specialized concepts in ordinary language.

For nontrivial runtime, ABI-adjacent, generated-code, package-artifact, or
measurement-sensitive work, the commit body and PR description or maintainer
comment should explain the problem, implementation, measured or observed
effect, validation, skipped suites, and remaining risk. When reporting
before/after numeric results, use a compact table instead of prose-only
bullets, and include the run context needed to compare the numbers honestly
(for example host, engine version, benchmark source, and whether rows came from
the same run or from historical bead notes).

Documentation is part of the platform contract. If a change adds, removes,
completes, limits, or changes user-visible behavior, API behavior, platform
semantics, package behavior, build behavior, browser behavior, ABI behavior, or
operational workflow, update the documentation that consumers and future agents
use to understand that contract.

Documentation must be truthful about the state of the platform. Do not describe
aspirational behavior as supported behavior. If behavior is partial, bounded by
today's WebAssembly runtime limits, host-specific, package-specific, or known to
fail, document that boundary directly.

Do not use documentation to create a platform promise before the implementation,
tests, package artifacts, and browser/Node behavior support it. Future work
belongs in plans or clearly marked limitations, not in reference docs written as
current behavior.

Update the authoritative doc for the contract touched:

| Change | Primary docs |
|---|---|
| Kernel design, process model, host runtime, VFS, networking, devices | `docs/architecture.md` |
| Syscall support or POSIX semantics | `docs/posix-status.md` |
| ABI rules, ABI bumps, snapshot behavior | `docs/abi-versioning.md` |
| Fork instrumentation behavior | `docs/fork-instrumentation.md` |
| SDK tools, compiler flags, sysroot expectations | `docs/sdk-guide.md` |
| Porting workflow or package build expectations | `docs/porting-guide.md` |
| Package schema, resolver, cache, build-script contract | `docs/package-management.md` |
| Binary release/index/fetch behavior | `docs/binary-releases.md` |
| Browser capabilities, demo architecture, VFS images, service worker, UI metadata | `docs/browser-support.md` |
| Repository layout or ownership boundaries | `docs/repository-organization.md` |
| Major user-facing feature or project structure | `README.md` |

Historical plan docs are records. Do not rewrite old plans to pretend they
predicted the current design. Prefer updating the current reference docs and,
when useful, link to the historical plan for rationale.

Do not duplicate long policy text across many files. Keep one authoritative
reference and point agent guidance to it.

PR descriptions and agent final reports should make the contract scope and
evidence explicit:

- What platform contract changed?
- What claim is being made?
- What evidence supports that claim?
- What user-visible behavior changed?
- What changed on Node.js and what changed on browser?
- Was ABI affected? If yes, was `ABI_VERSION` bumped or was the snapshot
  additive?
- Were package artifacts, revisions, VFS images, or indexes affected?
- What validation was run?
- What validation was not run?
- What known gaps remain?

For host-runtime changes, name both hosts. If one host is intentionally
unaffected, explain why with a concrete code path or platform boundary.

For docs-only changes, say they are docs-only and do not imply runtime
validation.
