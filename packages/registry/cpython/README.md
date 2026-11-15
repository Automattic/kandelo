# cpython

CPython 3.13.3, cross-built with upstream's WebAssembly System Interface
configure target (`--host=wasm32-unknown-wasi`) against Kandelo's musl
sysroot, and statically linked. The shell carries it through
`python-browser-bundle` (`/usr/bin/python3`, the standard library in
`/usr/lib/python3.13`).

## Modules upstream's WASI target leaves out

Upstream's configure declares a list of modules unavailable on WASI,
because wasi-libc lacks processes, file locking and the user databases.
Kandelo's libc has them, so two patches let configure's usual checks
decide instead, for this target only:

- `posix-subprocess.patch`: `_posixsubprocess`, and `subprocess` on
  `sys.platform == "wasi"`, when `fork` and `execv` exist.
- `posix-libc-modules.patch`: `fcntl` when `flock` exists, and `pwd` and
  `grp` from their usual function checks (Emscripten keeps them off: its
  pwd and grp are stubs). Meson needs `fcntl` for its build-directory lock
  and `pwd` for `meson install` as root.

Still left out by the WASI target, though Kandelo's libc may provide what
they need: `termios`, `mmap`, `resource`, `syslog`, `_multiprocessing`,
`_posixshmem`, `_curses` and `_curses_panel`. Each is a platform gap until
it is enabled the same way and tested. `sys.platform` stays `wasi`.

## Installed layout

The runtime archive carries an empty `lib/python3.13/lib-dynload`, as
`make install` creates it even when every extension module is built in.
CPython's `Modules/getpath.py` takes that directory as the `exec_prefix`
landmark; without it every launch that did not set `PYTHONHOME` printed
`Could not find platform dependent libraries <exec_prefix>`. With it,
`/usr/bin/python3` finds `/usr` for both prefixes on its own, in a login
shell or not, and the shell sets no `PYTHONHOME`.
