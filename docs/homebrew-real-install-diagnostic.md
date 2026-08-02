# In-guest Homebrew real-install diagnostic

This diagnostic answers two bounded questions:

1. Can stock Homebrew install and run the public core Bzip2 bottle
   inside Kandelo?
2. Can the same image tap an independent public repository, install
   its M4 bottle, and use Dash from the core tap as a dependency?

It does **not** authorize the main shell. The shipping shell has a
separate 41-Formula contract and product pointer. A successful
diagnostic must not replace, seal, or weaken either one.

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
The paths below are examples; use new output directories every time.

```bash
CAMPAIGN_ROOT=/path/to/c2-campaign
STATE_ROOT="$CAMPAIGN_ROOT/scheduler-state"
KANDELO_ROOT=/path/to/exact-kandelo-checkout
SELECTION_CANDIDATE=/path/to/new-selection-candidate
SELECTION_RELEASE=/path/to/new-selection-release
DIAGNOSTIC_WORK=/path/to/new-diagnostic-work
```

Materialize every frozen handoff from its immutable public release.
This read must work without credentials:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  python3 "$CAMPAIGN_ROOT/campaign_scheduler.py" \
    --campaign "$CAMPAIGN_ROOT/campaign.json" \
    --state-root "$STATE_ROOT" \
    materialize \
    --kandelo-root "$KANDELO_ROOT" \
    --source-tap-root "$CAMPAIGN_ROOT/source-tap"
```

Prepare the exact 25-Formula closed selection:

```bash
formulae=(
  libcxx ncurses bash bzip2 coreutils openssl zlib libcurl curl dash
  findutils gawk ed diffutils grep less sed vim git homebrew-bootstrap
  posix-utils-lite libyaml ruby gzip tar
)
handoff_args=()
for formula in "${formulae[@]}"; do
  handoff_args+=(--handoff "$STATE_ROOT/materialized/handoffs/$formula")
done

cd "$KANDELO_ROOT"
bash scripts/dev-shell.sh python3 \
  scripts/homebrew-prefix-campaign-executor.py prepare-selection \
  --campaign "$CAMPAIGN_ROOT/campaign.json" \
  --source-tap-root "$STATE_ROOT/materialized/target-source" \
  --root-formula bash \
  --root-formula bzip2 \
  --root-formula coreutils \
  --root-formula curl \
  --root-formula findutils \
  --root-formula gawk \
  --root-formula git \
  --root-formula homebrew-bootstrap \
  --root-formula posix-utils-lite \
  --root-formula ruby \
  --root-formula tar \
  --arch wasm32 \
  "${handoff_args[@]}" \
  --out "$SELECTION_CANDIDATE"
```

## Publish and verify the selection

Publication is a mutation. Run it only from the reviewed current-main
authority and only after checking the exact Kandelo and tap commits
again. The publisher creates an immutable content-addressed release;
it does not move the main-shell product pointer.

```bash
cd "$KANDELO_ROOT"
bash scripts/publish-homebrew-closed-selection-release.sh \
  --selection "$SELECTION_CANDIDATE" \
  --lock-root "$SELECTION_RELEASE" \
  --receipt "$SELECTION_RELEASE/publish-receipt.json" \
  --kandelo-main-contains-sha \
    6024539d7849bb5f0d9c235b97218e60f03a2fef \
  --target-main-contains-sha \
    b19a62636c9c8136740eba05237e3106ddd37c97

SELECTION_TAG="$(
  jq -er '.tag' "$SELECTION_RELEASE/publish-receipt.json"
)"
```

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
- its M4 bottle can depend on the exact selected core Dash bottle; and
- both installed programs execute successfully.

It does not prove the complete shell selection, upgrades, reboot
persistence, in-guest source builds, or product deployment. Those
remain separate claims with separate evidence.

[diagnostic-contract]: ../homebrew/real-install-diagnostic.json
