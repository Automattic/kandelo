# Formula Template Directory

The real `Automattic/kandelo-homebrew` tap will place Homebrew formulae here.
This main-repo scaffold intentionally does not include a live formula yet.

Formula work belongs in the later implementation bead that ports and publishes
the first `hello` bottle. Formulae should use normal Homebrew DSL, including
`depends_on`, `bottle do`, `revision`, `rebuild`, and `test do`, while any
Kandelo-specific VFS planning data belongs under `Kandelo/`.

Do not make host or browser tooling evaluate Formula Ruby. The generated
Kandelo link manifest is the structured contract for VFS builders.
