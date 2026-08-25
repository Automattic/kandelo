# Homebrew bootstrap package (disabled)

The Homebrew bootstrap implementation is retained here for possible future
work, but it is intentionally absent from Kandelo's active package registry.
The resolver discovers only `package.toml` with a sibling `build.toml`; the
manifests in this directory therefore use the `.disabled` suffix.

Do not enable, build, publish, or test this package as part of the normal
Kandelo build. Re-enabling it requires a separate reviewed change that restores
the manifest names and the corresponding build, test, and publication paths.
