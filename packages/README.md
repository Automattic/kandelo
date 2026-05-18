# Packages

Kandelo software package definitions and package-facing examples live here.
Packages are secondary to the kernel, but this tree keeps the CI and shipped
software story organized.

- `registry/<name>/package.toml` describes one buildable package, its source,
  license, dependencies, build script, and outputs.
- `registry/<name>/build-*.sh` builds the package for Kandelo.
- `examples/<name>/` contains runnable service harnesses, package-specific test
  drivers, and benchmark fixtures for ported software.
- `sets/*.toml` names product or CI scenarios that should be kept buildable as
  a group. These are advisory manifests today; automation can consume them
  once the package-set schema is wired into `tools/xtask`.

Keep package recipes in `registry/` even when a package example uses the same
software. `registry/` owns build and release metadata; `examples/` shows how
that software is run, tested, or composed into service stacks. Root
`../examples/` is reserved for small kernel and SDK examples.
