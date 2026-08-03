# In-guest Homebrew real-install diagnostic

This diagnostic answers two bounded questions:

1. Can stock Homebrew install and run the public core Bzip2 bottle
   inside Kandelo?
2. Can the same image tap an independent public repository, install
   its keg-only `m4-canary` bottle, and use Dash from the core tap as a
   dependency?

It does **not** authorize the main shell. The shipping shell has a
separate, larger contract and product pointer. A successful diagnostic
must not replace, seal, or weaken either one.

## What the image contains

[`homebrew/real-install-diagnostic.json`][diagnostic-contract] is the
source of truth. It binds the exact campaign, Kandelo commit, tap
source, architecture, Application Binary Interface (ABI), selection
roots, direct dependencies, and dependency-first Formula order.

The closed selection contains 25 Formulae. `homebrew-bootstrap` is
support data: it supplies the reviewed Homebrew source ZIP and
environment file. The other 24 Formulae are normal bottle trees in the
Virtual File System (VFS).

Only Libcxx, Ncurses, and Bash are embedded. Bash is the shell and is
needed at every boot. The remaining 21 bottle trees and the Homebrew
source tree are lazy. Opening a path in one of those trees downloads
and verifies that tree's complete bottle archive; it does not fetch
individual archive members.

The diagnostic intentionally does not use either of these product files:

- `homebrew/main-shell-selection-lock.json`
- `homebrew/main-shell-homebrew-runtime-support.json`

The Homebrew source tree is an independent lazy activation in this
diagnostic. Ruby, Git, curl, and the other runtime tools activate
through their own bottle paths as Homebrew uses them. The shipping
shell may retain a stricter atomic runtime-support policy without
making that policy a prerequisite for this bounded experiment.

## Before running

The 25 Formula handoffs must be frozen in one campaign scheduler state.
Do not mix handoffs from another campaign, architecture, or source tap.
The tap's protected data-only workflow, rather than a developer
checkout, owns selection publication.

Create canonical compact JSON from the campaign's exact identities and
the scheduler-recorded immutable handoff tag for every Formula below.
The roots are policy; the publisher independently derives their closure
and rejects a missing or extra handoff.

```bash
CAMPAIGN_TAG=<immutable-campaign-tag>
KANDELO_COMMIT=<campaign-kandelo-commit>
SOURCE_TAP_COMMIT=<campaign-source-tap-commit>
HANDOFFS_JSON=/path/to/sorted-25-formula-handoff-object.json
DIAGNOSTIC_WORK=/path/to/new-diagnostic-work

roots='["bash","bzip2","coreutils","curl","findutils","gawk","git","homebrew-bootstrap","posix-utils-lite","ruby","tar"]'
plan="$(jq -cnS \
    --arg campaign_tag "$CAMPAIGN_TAG" \
    --arg kandelo_commit "$KANDELO_COMMIT" \
    --arg source_tap_commit "$SOURCE_TAP_COMMIT" \
    --argjson handoffs "$(jq -cS . "$HANDOFFS_JSON")" \
    --argjson roots "$roots" \
    '{
      schema: 1,
      kind: "kandelo-homebrew-closed-selection-publish-plan",
      campaign_tag: $campaign_tag,
      kandelo_commit: $kandelo_commit,
      source_tap_commit: $source_tap_commit,
      roots: $roots,
      handoffs: $handoffs
    }')"
plan_sha256="$(printf '%s\n' "$plan" | sha256sum | cut -d' ' -f1)"
```

## Publish and verify the selection

Publication is a mutation. Dispatch the protected tap workflow only
after checking the exact Kandelo and tap commits again. The reusable
Kandelo workflow anonymously reconstructs every handoff, publishes an
immutable content-addressed release, and anonymously reads it back. It
does not move the main-shell product pointer.

```bash
gh workflow run publish-closed-selection.yml \
  --repo Kandelo-dev/homebrew-tap-core \
  --ref main \
  -f selection_plan="$plan" \
  -f selection_plan_sha256="$plan_sha256"

# Record the exact successful workflow run; do not select a merely recent run.
RUN_ID=<exact-workflow-run-id>
SELECTION_RECEIPT=/path/to/new-selection-receipt
gh run download "$RUN_ID" \
  --repo Kandelo-dev/homebrew-tap-core \
  --name "homebrew-closed-selection-publication-$plan_sha256" \
  --dir "$SELECTION_RECEIPT"
SELECTION_TAG="$(jq -er '.tag' "$SELECTION_RECEIPT/receipt.json")"
```

Before opening the proof pull request, update the reviewed diagnostic
contract from this exact selection and the canary tap revision that
publishes `m4-canary`. Do not substitute the main-shell selection lock
or copy an unrelated campaign's identities.

The focused contract test anonymously clones that exact canary
revision. It requires both `Formula/m4-canary.rb` and its generated
`Kandelo/formula/m4-canary.json` metadata. The Formula's canonical
bottle block, bottle digest, ABI, guest prefix, tap identity, and Dash
dependency must all agree with the metadata. It also downloads and
hashes the public bottle without credentials. This catches a valid but
stale commit that predates `m4-canary`, or metadata that points at
unreadable bytes, before image composition begins.

## Compose and prove the exact VFS

Install the repository-declared Node and rootfs-builder dependencies
first. Then prepare the image and its closed lazy-asset fixture:

```bash
bash scripts/dev-shell.sh \
  bash scripts/run-homebrew-real-install-diagnostic.sh prepare \
  --selection-tag "$SELECTION_TAG" \
  --work-dir "$DIAGNOSTIC_WORK"
```

The prepare step fetches the immutable selection anonymously into the
new work directory. It runs the generic closed-selection readback
verifier, then uses only that private snapshot for every extractor and
composer read. The diagnostic check retains all 25 versions, handoff
digests, archive digests, and immutable release evidence.

Preparation also repeats the anonymous canary checkout and records its
Formula, metadata, and bottle digests in
`independent-tap-check.json`. Node and Chromium therefore consume a
fixture bound to a third-party revision already proven to contain the
installable Formula; they do not discover a missing Formula only after
the guest boots.

It then extracts `homebrew-bootstrap` from its authenticated bottle,
builds a platform-only base, composes the 24 executable Formula trees,
and records the exact mirror and browser fixture. It never reads the
traditional package-registry program fragment.

Run the two Node scopes. Each scope starts from the original VFS bytes:

```bash
bash scripts/dev-shell.sh \
  bash scripts/run-homebrew-real-install-diagnostic.sh prove-node \
  --work-dir "$DIAGNOSTIC_WORK"
```

Run the same two scopes in Chromium against the same VFS and exact lazy
assets:

```bash
bash scripts/dev-shell.sh \
  bash scripts/run-homebrew-real-install-diagnostic.sh prove-browser \
  --work-dir "$DIAGNOSTIC_WORK"
```

The browser command creates a temporary private fixture directory under
the browser app, runs the closed-acceptance Vite mode, and removes that
directory when Playwright exits. Guest `brew tap` and `brew install`
still use their real public Git and bottle URLs.

## What success means

Success proves the following for the exact recorded VFS bytes in both
hosts:

- stock Homebrew starts from the lazy bootstrap;
- Homebrew's runtime commands activate from independent bottle trees;
- Bzip2 is removed from the precomposed diagnostic and installed again
  by stock `brew install`;
- the downloaded Bzip2 archive hashes to the exact digest admitted by
  the closed selection;
- a separate public tap can be cloned and pinned to an exact revision;
- its keg-only `m4-canary` bottle can depend on the exact selected core
  Dash bottle without uninstalling the shell's core M4; and
- both installed programs execute successfully.

It does not prove the complete shell selection, upgrades, reboot
persistence, in-guest source builds, or product deployment. Those
remain separate claims with separate evidence.

[diagnostic-contract]: ../homebrew/real-install-diagnostic.json
