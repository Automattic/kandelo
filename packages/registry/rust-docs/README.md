# Rust and Cargo manuals

This lazy archive ships the upstream `rustc(1)`, `rustdoc(1)`, `cargo(1)`
and Cargo subcommand pages from the same immutable nightly distribution as
the guest tools. Both compiler and Cargo commit identities are checked.
The recipe decompresses the original pages without rewriting their content.

Pages live under `/usr/share/man/man1`. The shell's man viewer loads the
archive when needed; for example, `MANPAGER=cat man 1 cargo-test`.
`kandelo-rustc(1)` and `wasm32posix-rustc(1)` are links to `rustc(1)`:
the image installs the compiler under those names too. The pinned
distribution provides no rustfmt or Clippy man pages; `rust-tools-docs`
makes theirs from each tool's own --help.
