# Formula Directory

The real `Automattic/kandelo-homebrew` tap will place Homebrew formulae here.
This main-repo scaffold includes `hello.rb` so the first wasm32 bottle path can
be reviewed and exercised before the real tap repository exists.

Formulae should use normal Homebrew DSL, including `depends_on`, `bottle do`,
`revision`, `rebuild`, and `test do`, while any Kandelo-specific VFS planning
data belongs under `Kandelo/`.

Do not make host or browser tooling evaluate Formula Ruby. The generated
Kandelo link manifest is the structured contract for VFS builders.
