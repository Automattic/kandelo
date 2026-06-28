# Homebrew Publishing

Kandelo's Homebrew publishing path is being built in the main
`Automattic/kandelo` repository for a future `Automattic/kandelo-homebrew`
tap. Homebrew formulae and bottle metadata should remain Homebrew-native; the
Kandelo sidecar metadata is an additional contract for VFS builders and browser
automation, not a replacement for formula `bottle do` blocks.

## Kandelo Bottle Tags

Kandelo bottles use the Homebrew platform tags `wasm32_kandelo` and
`wasm64_kandelo`. The tag names intentionally keep the Kandelo ABI out of the
Homebrew tag. ABI compatibility belongs in Kandelo metadata, release names such
as `bottles-abi-v<N>`, and bottle sidecars so Homebrew's platform tag remains a
stable architecture/system selector.

Homebrew's current bottle tag parser treats the token before the final
underscore as a CPU architecture only when it is listed in
`Hardware::CPU::ALL_ARCHS`. Without a patch, `wasm32_kandelo` is parsed as an
`x86_64` bottle for a synthetic `wasm32_kandelo` system and serializes back as
`x86_64_wasm32_kandelo`. That breaks formula DSL round-tripping and install
selection for a Kandelo current tag.

The carried patch is:

```text
homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch
```

It changes Homebrew's parser to recognize `wasm32` and `wasm64` as CPU
architectures and maps `system: :kandelo` tags to the Linuxbrew prefix and
cellar:

```text
/home/linuxbrew/.linuxbrew
/home/linuxbrew/.linuxbrew/Cellar
```

Until this behavior is accepted upstream by Homebrew, Kandelo's trusted
Homebrew publishing workflow must apply the patch to the Homebrew checkout used
for bottle generation, formula bottle block merging, and install-selection
tests. Do not patch a developer's host Homebrew in place.

Verify the carried patch against the installed Homebrew checkout with:

```bash
scripts/verify-homebrew-kandelo-platform-tags.sh
```

The verifier applies the patch to a temporary source overlay, reloads the
relevant Homebrew Ruby classes from that overlay, and asserts that
`wasm32_kandelo` and `wasm64_kandelo` round-trip through
`Utils::Bottles::Tag` and `BottleSpecification`.

The trusted bottle script applies the patch to a temporary Homebrew worktree and
sets `HOMEBREW_KANDELO_BOTTLE_TAG` to `wasm32_kandelo` or `wasm64_kandelo`
before invoking `brew bottle`. Formula code should use `HOMEBREW_KANDELO_*`
variables for values that must survive Homebrew's environment handling:

```text
HOMEBREW_KANDELO_ROOT
HOMEBREW_KANDELO_ARCH
HOMEBREW_KANDELO_NODE
HOMEBREW_KANDELO_LLVM_BIN
```

The workflow-facing sidecar and publication scripts continue to use
`KANDELO_HOMEBREW_*` variables outside Formula Ruby.

Published GHCR bottle blob URLs use the OCI registry API and may return a
Bearer challenge before serving bytes, even for public packages. Kandelo's
Homebrew VFS image builder follows that `WWW-Authenticate` challenge and
retries the blob request with the advertised token; public bottle materializers
do not need a GitHub token just to read public GHCR blobs.

## First Bottle Path

`homebrew/kandelo-homebrew/` is a main-repo scaffold for the future
`Automattic/kandelo-homebrew` tap. Local validation can copy that scaffold into
a temporary git checkout, run `scripts/homebrew-bottle-build.sh`, and then run
the dry-run upload and sidecar generation scripts against the resulting bottle
bytes.

The reusable workflow installs root and host npm dependencies before bottle
builds because the first `hello` formula test boots the produced Wasm with:

```bash
node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts
```

Sidecar provenance must use schema-compatible validation outcome lists. For the
first `hello` bottle, `bottle_build` and `node_smoke` are success lists,
`homebrew_audit` is skipped unless the real tap gate runs it, and
`browser_smoke` is skipped until the browser follow-up lands.

As of this implementation, `Automattic/kandelo-homebrew` must exist before the
trusted publish workflow can satisfy publication. If the repo is missing,
local bottle bytes, bottle blocks, and sidecars are only evidence; they do not
complete the publication requirement.
