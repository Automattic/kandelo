# Formula Directory

The `kandelo-dev/tap-core` tap places Homebrew formulae here. Its GitHub
repository is `kandelo-dev/homebrew-tap-core`. This
main-repo scaffold includes a non-live `what.rb` fixture so Formula, bottle,
sidecar, and smoke logic can be reviewed alongside the Kandelo implementation
that consumes it. Live Formula sources belong in the tap repository rather than
this fixture.

Formulae should use normal Homebrew DSL, including `depends_on`, `bottle do`,
`revision`, `rebuild`, and `test do`, while any Kandelo-specific VFS planning
data belongs under `Kandelo/`.

Every authored Formula byte outside its structurally canonical `bottle do`
block and the block's single formatting separator is part of the immutable
source identity for a publication attempt. Required files under
`Kandelo/formula_support/`, including their paths and modes, are part of that
identity as well. Commit Formula and support changes before dispatching; any
later change requires a fresh publication rather than a rerun of old build
artifacts.

The publisher owns the canonical `bottle do` block, its single separator, and
generated `Kandelo/` sidecars. Do not hand-edit them. The publisher may insert
or replace only that generated block and separator while preserving every
remaining authored Formula byte exactly, and publication fails if the authored
Formula or support identity drifts between planning, building, verification,
and tap finalization.

Do not make host or browser tooling evaluate Formula Ruby. The generated
Kandelo link manifest is the structured contract for VFS builders.
