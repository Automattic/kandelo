# grep

GNU grep's manual page, `grep(1)`, ships in the `grep-docs` lazy archive.

## Why `egrep` and `fgrep` have no manual pages

In GNU grep 3.11, `egrep` and `fgrep` are small scripts that print an
obsolescence warning and run `grep -E` or `grep -F`. Upstream leaves them
out of `grep(1)` on purpose. Its info manual mentions them only in the FAQ
entry "What happened to egrep and fgrep?", which says POSIX removed them in
2001 and that they are planned to be removed from GNU grep entirely.

Their `--help` is grep's own, so a page laid out from it would be `grep(1)`
under another name. Use `grep -E` and `grep -F`.
