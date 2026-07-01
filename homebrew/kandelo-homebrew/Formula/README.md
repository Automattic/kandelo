# Formula Directory

The `Automattic/kandelo-homebrew` tap places Homebrew formulae here. This
main-repo scaffold includes representative program and library formulae so
formula, bottle, sidecar, and smoke logic can be reviewed alongside the Kandelo
implementation that consumes it.

Formulae should use normal Homebrew DSL, including `depends_on`, `bottle do`,
`revision`, `rebuild`, and `test do`, while any Kandelo-specific VFS planning
data belongs under `Kandelo/`.

Do not make host or browser tooling evaluate Formula Ruby. The generated
Kandelo link manifest is the structured contract for VFS builders.
