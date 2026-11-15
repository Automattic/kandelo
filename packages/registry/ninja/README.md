# ninja

Ninja 1.13.2, built with upstream's CMake build and the SDK toolchain file
(`sdk/cmake/kandelo-toolchain.cmake`) against the declared libcxx. The
shell installs it as the lazy file `/usr/bin/ninja`; the build image holds
it resident. Meson's builds run it (`meson compile`, or `ninja -C build`).

## Platform paths

Upstream's own configure checks pick the POSIX paths; nothing is patched:

- Each build command runs through `posix_spawn` of `/bin/sh -c`, with
  `POSIX_SPAWN_SETSIGMASK` and, for commands outside the console pool,
  `POSIX_SPAWN_SETPGROUP`. Kandelo's `posix_spawn` supports both
  (`docs/posix-status.md`).
- CMake finds `ppoll()` in `<poll.h>`, so ninja waits for command output
  and SIGCHLD with `ppoll` (`USE_PPOLL`) rather than `pselect`. The recipe
  fails if that check stops finding it.
- `fork()` and `pipe()` are present, so `ninja -t browse` is built. It
  runs `python3` (the shell's Python) to serve the dependency browser.
- `-j` defaults to the online processor count plus two. Kandelo reports
  one online processor (`sysconf(_SC_NPROCESSORS_ONLN)`), so ninja runs two
  jobs at a time unless told otherwise.

## Manual page

Upstream has no manual page: `doc/manual.asciidoc` is a user guide. The
`ninja-docs` package makes `ninja(1)` with help2man from what ninja prints
for `--help` (on standard error) and `--version` running inside Kandelo.
