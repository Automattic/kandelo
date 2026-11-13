# posix-utils-lite

Minimal stand-ins, written for Kandelo, for POSIX utilities that have no
upstream port yet (`cal`, `ed`, `pax`, `ps` and the rest).

## Why these commands have no manual pages

They are placeholders, not upstream programs, so there is no upstream page
to ship, and a page describing a placeholder would document behavior that is
about to go away. Each is being replaced by an upstream implementation whose
own pages ship with it. That has already happened for `ar`, `nm`, `strip` and
`strings` (LLVM's tools) and `patch` (GNU patch).
