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

### Preserve Contributor Attribution

Authorship records contribution; restacking must not transfer it. Before
rewriting another contributor's branch, inspect the original commits with
`git show --format=fuller`.

- Keep the contributor as author of derived commits and the restacker as
  committer. Set `--author` explicitly when reconstructing a commit.
- For materially combined work, retain the primary author and add accurate
  `Co-authored-by:` trailers; do not demote the primary author to a trailer.
- Before force-pushing, verify patch and author preservation with
  `git range-diff` and `git log --format=fuller`. If provenance is ambiguous,
  reconstruct it from the original commits and PR timeline instead of guessing.
- An authorship-changing head invalidates earlier approvals, readiness labels,
  and validation. Rerun the required gates.

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
