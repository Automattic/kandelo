# Changelog and dated updates

Kandelo publishes dated progress updates, identified as `YYYY.MM.DD`,
independently of program ABI and kernel/host versions. An update is not a
stable-API promise or a tested binary distribution. Host and SDK package
versions remain separate; this workflow does not bump package or ABI versions,
rebuild packages, change ABI artifact releases, or deploy the browser app.

## Add an entry with a change

Add a fragment under `changelog.d/`, alongside the implementation and its
documentation. Use `<PR-number>.<category>`, or `+<unique-slug>.<category>`
before the PR number is known. A leading `+` omits the issue link. Write the
user or contributor outcome in plain prose without a heading or leading
bullet. Include concrete limitations and migration instructions when needed.

For example, `changelog.d/+terminal-paste.ui` might contain:

```text
Pasting several lines into the terminal preserves their line breaks.
```

| Extension | Content |
| --- | --- |
| `ui` | User interface, terminal interaction, sharing, accessibility |
| `agentic` | Agent and automation capabilities; say whether these serve users or contributors |
| `ports` | Newly available software, upstream upgrades, package improvements |
| `correctness` | Existing behavior now produces the correct result |
| `completeness` | Missing or partial POSIX interfaces implemented more fully |
| `features` | New capabilities beyond the existing supported surface |
| `breaking` | Breaking changes, removals, and migration instructions; first detailed category |

Choose one primary category per outcome; distinct outcomes may have separate
fragments. Fixing an existing `waitpid` result is correctness; implementing a
previously unsupported POSIX interface is completeness. Do not turn an
unmeasured optimization into a performance claim.

## Write about what people can do

Choose news for the experience it gives someone: a task they can finish,
a problem they no longer hit, or a reason to try Kandelo. A history survey
is a selection of meaningful experiences. The linked history and reference
docs can carry the full inventory.

Give each distinct experience its own entry. C/C++ compilation, Rust
development, running WordPress, and sharing a live website each deserve a
clear opening. A shared implementation or category does not make them the
same story. Keep a major capability out of another item's closing sentence.

Write for a junior developer who has not followed the project. Use a short
bold opening that names the action, then usually two or three sentences:
what someone can do, why it helps, and where to start. Name an unfamiliar
tool's purpose before its internal machinery. Be direct about the achievement;
concrete capabilities convey enthusiasm without superlatives.

For example, a Rust-toolchain entry could start:

```markdown
**Build and test Rust projects inside Kandelo.** Use Cargo to compile your
project and run its tests in the browser computer. Format code with rustfmt
and check it with Clippy.
```

Then link to the setup instructions and name material limits, such as the
experimental image, offline workflow, and unsupported procedural-macro crates.
Keep the useful claim and its scope together.

- Read only the bold openings as a review pass. They should communicate the
  useful news on their own. "See which Rust code your tests run" explains
  coverage; "Add matching profiler support" leaves the reader to infer it.
- Keep one outcome per entry. Separate "Compile C and C++ in your browser"
  from "Build and test Rust projects inside Kandelo" so each can be found
  at a glance. Related steps in one task can stay together.
- Explain fixes through the interrupted task: "Keep using Bash after pressing
  Ctrl-C" makes the benefit clearer than describing fork continuation state.
- Use concrete examples, such as a WordPress site or a cooperative DOOM game.
  A small fix can simply say "Pasting several lines into the terminal preserves
  their line breaks."
- Give readers a next step: a command, a guide, or a reproducible example.
- Keep evidence and technical detail in the linked references. Specific
  support limits and migration actions still belong beside the affected claim.

### Nominate a highlight in the news fragment

For a substantial capability, add optional TOML front matter to the fragment.
The author or coding agent writes the reader-facing significance while the
implementation, evidence, and limitations are fresh:

```markdown
+++
headline = "Give an agent a development computer in your browser"
highlight = """Use WebMCP to edit source, run installed compilers and tests,
and inspect results in the same computer as the user. Requires a browser
with WebMCP registration support. [Explore the tools](https://github.com/Automattic/kandelo/blob/main/docs/webmcp.md)."""
+++
Image-declared tools let an environment expose its own commands to agents.
Editing a definition refreshes the tool without reloading the computer.
Commands run as owned jobs of the agent account, with cancellation.
```

Use both `headline` and `highlight`, or omit the front matter entirely.
`headline` is a short, single-line outcome; `highlight` is a short summary
with the significance, material scope, and a way to try it. The text after
the front matter remains the detailed categorized entry. This example is a
writing model, not a request to announce an existing capability again.

`prepare` automatically puts nominated highlights before the detailed
categories. It passes only the detailed body to the Rust renderer, so
metadata never appears as news. Plain fragments keep working. `check`
rejects malformed front matter, missing or empty fields, unknown fields,
and nominations without detailed news.

All distinct nominations appear in a stable filename order, with exact
duplicates combined. Nothing is silently dropped or ranked by commit count.
The draft includes every nomination even when there are more than five;
review normally selects three to five and chooses the update title and
opening. Merge entries only when they describe the same reader task. Give
separate experiences separate headlines. Small updates need no nominations.
A broad historical survey can use more highlights, grouped under short
headings such as building software, sharing apps, and playing games.

Nominate changes that enable a new workflow, help a new audience, or resolve
a recognizable problem. A port of a compiler or development tool can matter
because of the work it enables, beyond the fact that another package builds.
Libraries can unlock applications or language ecosystems. Routine rebuilds
and recipe maintenance usually need no highlight.

For each significant port, explain what the tool does, why running it inside
Kandelo is useful, where it is available, and how to try it. Link to the
usage guide and recorded validation. Distinguish a tested development image
from default availability, and a successful build from a tested workflow.

WebMCP plus in-guest development tools is an important combined capability:
an agent can work in an in-browser OS using its commands, files, processes,
and previews. Describe the guest OS as the environment for those commands.
Keep guest-command isolation distinct from browser-origin isolation:
same-origin preview scripts share the app's WebMCP trust boundary, as
documented in [WebMCP](webmcp.md). Do not imply a separate browser-origin
security boundary that has not been implemented.

Review checks nominations against the documented behavior and evidence.
It can also promote an overlooked plain entry; author nominations are a
starting point. Automation preserves authored claims without inventing new
capabilities, performance results, or security guarantees.
Treat generated categories as an editing aid. Read the draft for flow and
remove repeated announcements. A selected experience can be told completely
in its highlight; add detail below only when it helps the reader take action.
Historical surveys can use themed highlights without a second categorized
retelling. Keep breaking changes as the first detailed category after
highlights, and keep source and compatibility metadata at the end.

Every PR needs a new fragment or a line in its body explaining an omission:

```text
Changelog: none Internal refactor with no observable behavior change.
```

Update-assembly PRs consume already-reviewed fragments and need no new entry.
An omission is appropriate for internal maintenance and test-only changes.
The PR check also rejects empty fragments, unknown categories, invalid names,
and a stale generated index. Existing fragments are not rewritten by CI.

```bash
scripts/dev-shell.sh scripts/changelog check
```

## Tools and historical survey

`scripts/changelog-tool` installs exact Rust CLI releases with Cargo's locked
dependency resolution into `.context/changelog-tools/` on first use:

- `changelog-builder` 0.10.1 renders fragments using `towncrier.toml`.
- `git-cliff` 2.14.0 builds an editorial history inventory using `cliff.toml`.

No global Cargo installation or Python package is needed. The wrapper and
validation use repository-provided Python; rendering and history collection
use the Rust CLIs. Use the dev shell for all commands. First use needs network
access to the Cargo registry. `changelog-builder` lacks Towncrier's `create`
and `check` commands; fragment creation is an ordinary file edit, and
`scripts/changelog check` provides the repository-specific checks.

The first update is a curated baseline survey through its pinned source
commit. It does not invent older releases. Reproduce a history inventory from
inside the development shell:

```bash
scripts/dev-shell.sh bash
scripts/changelog history <commit-or-range> > .context/changelog-history.md
```

History collection includes unmatched commit subjects for review and ignores
artifact/archive tags as release boundaries. Commit prefixes are routing
hints, not evidence that a capability works. Check candidate milestones
against current authoritative docs and implementation before publishing.

## Prepare and publish an update

From a clean checkout with committed fragments:

```bash
scripts/dev-shell.sh scripts/changelog prepare --date 2026-11-15 --preview
scripts/dev-shell.sh scripts/changelog prepare --date 2026-11-15
scripts/dev-shell.sh scripts/changelog check
```

Preview renders in a temporary directory without changing the working tree.
Preparation collects nominated highlights, records `HEAD` and its ABI
snapshot, writes `changelog/updates/YYYY.MM.DD.md`, consumes the pending fragments, and
regenerates `CHANGELOG.md`. Dates must advance; this workflow publishes at
most one update per day. Unrelated untracked files are left alone.

The canonical text lives in `changelog/updates/*.md`. Edit those files to
choose a title, review the nominated highlights, and polish the update.
Then run `scripts/changelog assemble` to regenerate the root index.
The documentation page includes that index rather than keeping
a separate copy. Metadata is checked against the pinned source snapshot.
These checks verify publication bookkeeping, not runtime conformance.

The **Prepare changelog update** workflow is configured for Mondays and
manual dispatch from `main` or `develop`. It checks out `develop` and, with
pending fragments and no open update PR, prepares a dated update, checks it,
and opens a draft PR against `develop`. Review and merge the text there;
publication waits for promotion to stable `main`. It never merges a PR.

GitHub schedules workflows from the repository's default branch, `main`.
The scheduled definition must therefore reach `main` before it can run;
manual dispatch can select `develop` once the workflow is discoverable.
Execution also depends on the repository Actions settings and the
[CI transition](development-workflow.md#transition-order-and-current-limits).
These workflow definitions do not enable Actions or perform a promotion.

GitHub must allow Actions to create pull requests. An optional
`CHANGELOG_BOT_TOKEN` secret may hold an appropriately scoped bot token so
the generated PR triggers ordinary PR workflows. With the default
`GITHUB_TOKEN`, GitHub suppresses those downstream events; the prepare job
runs the changelog checks itself, and maintainers must arrange any other
required PR checks before merging. No personal token is required for local
preparation.

On `main`, **Publish changelog updates** publishes newly added update files
as GitHub Releases under `kandelo-update-YYYY.MM.DD`. Tags point to the pinned
source commit, and update releases do not replace GitHub's latest software
release. Existing tags/releases are checked rather than overwritten; reruns
can finish an interrupted publication. A manual dispatch retries a selected
update. Promotion must preserve the pinned source ancestry, as required by
the development workflow. Hosted behavior still needs verification after
the CI transition and operator enablement.

The documentation page ships with the normal guide publication. This change
does not introduce a separate website deployment. The existing
`binaries-abi-v…` releases continue to serve package artifacts independently.
