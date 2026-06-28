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
