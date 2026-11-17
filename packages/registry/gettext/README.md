# gettext

GNU gettext's manual pages ship in the `gettext-docs` lazy archive: one
page for each program and for `autopoint`, `gettextize` and `po-fetch`.

## Why `gettext.sh` has no manual page

`/usr/bin/gettext.sh` is not a command. It is a library of shell functions
(`eval_gettext`, `eval_ngettext` and the others) that a script loads with
`. gettext.sh`; it is in `/usr/bin` so the shell finds it on `PATH`. Run
directly, it prints only `Usage: . gettext.sh`.

Upstream ships no page for it. The gettext manual documents it under
"sh - Shell Script" ("The gettext.sh approach" and "Preparing for
gettext.sh").
