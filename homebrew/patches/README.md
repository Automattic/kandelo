# Homebrew patch licensing

Homebrew's source tree is distributed under the
[BSD 2-Clause License](https://github.com/Homebrew/brew/blob/4ead8619231cb15cbe15e8e8188081e347d6f7cd/LICENSE.txt).

`0001-add-kandelo-wasm-bottle-tags.patch` was authored in the Kandelo
repository by Brandon Payton across commits `1ab41fe2a`, `6efb411f1`, and
`f84c57f40`. Kandelo's `README.md` explicitly assigns
`GPL-2.0-or-later` to platform and build-script code, and the root
`Cargo.toml` records the same project license. The platform patch has no
separate permissive-license grant in its file or commits. Distribution
metadata therefore keeps the patch at the documented Kandelo project boundary
instead of inferring a Homebrew BSD grant. The prepared `homebrew-bootstrap`
tree declares the composite SPDX expression
`BSD-2-Clause AND GPL-2.0-or-later`.

This notice deliberately does not infer a BSD relicensing from the upstream
project's license. A future explicit grant from the patch copyright holder can
narrow the package expression without changing the prepared Homebrew bytes.
