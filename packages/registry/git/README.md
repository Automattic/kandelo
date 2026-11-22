# git

git's manual pages ship in the `git-docs` lazy archive.

## Why `git-remote-http` has no manual page

`git-remote-http` (also installed as `git-remote-https`, `git-remote-ftp`
and `git-remote-ftps`) is the helper git runs itself to fetch and push over
HTTP, HTTPS, FTP and FTPS URLs. It is not meant to be run by hand: git's own
build installs it in git's private helper directory, `libexec/git-core`, not
on `PATH`, and gives it no page and no `--help`. Upstream documents remote
helpers as a group in `gitremote-helpers(7)`, which `git-docs` ships.

Kandelo installs it in `/usr/bin` (`images/vfs/lib/init/shell-binaries.ts`),
which is why it looks like a command without a page.
