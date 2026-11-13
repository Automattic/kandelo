# Pending changelog entries

Add one plain-text or Markdown fragment with a meaningful user or contributor
change. Use `<PR-number>.<category>` if you know the PR number, or
`+<unique-descriptive-slug>.<category>` otherwise. The leading `+` avoids
creating a fictitious issue link. Do not add a leading bullet or heading.

Give each distinct user or developer experience its own entry. Start with
what someone can do or which frustrating problem is fixed, using words a
junior developer can follow. A short bold opening should make sense on its
own; follow it with a few sentences and a link to try it. Keep material
support limits beside the claim. Read the editorial guidance in
[the changelog workflow](../docs/changelog.md#write-about-what-people-can-do).

To nominate a major capability for automatic highlighting, start the fragment
with optional TOML front matter:

```markdown
+++
headline = "Build Rust inside your browser computer"
highlight = """The experimental guest toolchain brings Cargo builds and tests
into Kandelo. [Setup](https://github.com/Automattic/kandelo/blob/main/docs/rust-target.md#cargo-inside-kandelo)."""
+++
The experimental toolchain is available through the documented development
image or optional SDK bundle. Start with the offline, single-job workflow;
procedural-macro crates are currently unsupported.
```

Use both fields and a nonempty detailed entry, or omit the front matter.
`scripts/changelog prepare` automatically collects nominations into Highlights;
review chooses the lead and final selection. See the workflow guide below
for a complete example and the criteria for noteworthy ports.

Example: `+terminal-paste.ui` containing:

```text
Pasting several lines into the terminal preserves their line breaks.
```

Categories are defined in [towncrier.toml](../towncrier.toml): `ui`, `agentic`,
`ports`, `correctness`, `completeness`, `features`, and `breaking`.
See [the changelog workflow](../docs/changelog.md) for category boundaries,
validation, dated updates, and publishing.
