# Packages

Kandelo software package definitions live here.

- `registry/<name>/package.toml` describes one buildable package, its source,
  license, dependencies, build script, and outputs.
- `registry/<name>/build-*.sh` builds the package for Kandelo.
- `sets/*.toml` names product or CI scenarios that should be kept buildable as
  a group. These are advisory manifests today; automation can consume them
  once the package-set schema is wired into `tools/xtask`.

Keep package recipes here even when an example under `examples/` uses the same
software. Example directories should show usage; package directories should own
build and release metadata.
