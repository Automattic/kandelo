# Kandelo Sidecar Metadata

The future tap will generate this directory from trusted publish workflows.
Checked-in files make metadata reviewable in the tap commit, and the same
payload should be uploaded to a tap release named `bottles-abi-v<N>` for stable
automation fetches.

## Files

```text
metadata.schema.json
formula.schema.json
link-manifest.schema.json
provenance.schema.json

metadata.json                                      # generated in the real tap
formula/<name>.json                               # generated in the real tap
link/<name>-<version>-rebuild<N>-<arch>.json      # generated in the real tap
reports/<name>-<version>-rebuild<N>-<arch>.provenance.json
```

The `examples/` directory contains fixture data for schema and semantic
validator development. It is not published metadata.

## Validation Split

JSON Schema validates object shape, required fields, enum values, scalar
formats, and basic path syntax.

The semantic validator must still check cross-file and artifact facts:

- metadata ABI matches the `bottles-abi-v<N>` release;
- formula sidecars match their package entry in `metadata.json`;
- bottle `arch` and `bottle_tag` agree;
- browser-compatible entries have browser validation evidence;
- link-manifest paths do not escape the Homebrew prefix;
- link sources exist inside the verified bottle payload;
- bottle sha256, cache key, metadata sha, and provenance fields agree.

Run the repo-local validator against a generated tap checkout:

```bash
cargo xtask homebrew-validate --tap-root /path/to/kandelo-homebrew
```

The validator checks the current sidecar JSON and link-manifest consistency. It
does not fetch bottle bytes or evaluate Formula Ruby.
