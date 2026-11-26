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
- `posix-libc-modules.patch`: `fcntl` when `flock` exists; `mmap` and
  `termios` from their header checks; and `pwd`, `grp`, `resource`,
  `syslog`, `_multiprocessing`, `_posixshmem`, `_curses` and
  `_curses_panel` from their usual checks (Emscripten keeps those off: its
  versions are stubs or absent). Meson needs `fcntl` for its
  build-directory lock and `pwd` for `meson install` as root.

`sys.platform` stays `wasi`. `test/posix-modules.test.ts` runs each module
from the `python-browser-bundle` archive on the Node host:

| Module | What the test does |
|---|---|
| `termios` | `tcgetattr`/`tcsetattr` on an `os.openpty()` slave; turns off `ECHO` and `ICANON` and reads one unechoed byte; `ENOTTY` on `/dev/null` |
| `mmap` | Maps a file, writes through the mapping and reads the file back; an anonymous `MAP_SHARED` page written by a forked child |
| `resource` | `RLIMIT_NOFILE` defaults, lowering it and hitting `EMFILE`, a soft limit above the hard one refused, a finite `RLIMIT_AS`, `getrusage` |
| `syslog` | `openlog`/`syslog` reach a datagram socket bound at `/dev/log` with the right priority, tag and pid |
| `_multiprocessing` | `multiprocessing` with the fork start method: three `Process` children answering over `Pipe`s |
| `_posixshmem` | `multiprocessing.shared_memory`: a block under `/dev/shm` written by the parent, read and rewritten by a forked child, then unlinked |
| `_curses`, `_curses_panel` | `curses.wrapper` on a 24x80 PTY with `TERM=xterm-256color`: draws text and a panel and leaves the alternate screen |

Curses links `libncursesw`, `libpanelw` and `libtinfow` from the declared
`ncurses` dependency (`CURSES_LIBS`/`PANEL_LIBS` in `build-cpython.sh`).
Terminal types other than the ones compiled into `libtinfow`
(`xterm-256color`, `xterm`, `vt100`, `dumb`) need ncurses' terminfo
database in the image.

Limits that remain, each a platform boundary rather than a package
choice:

- **Process-shared semaphores.** `multiprocessing.Lock`, `Semaphore`,
  `Event`, `Queue`, `Pool` and the rest of `multiprocessing.synchronize`
  raise CPython's `ImportError` ("This platform lacks a functioning
  sem_open implementation"). `sem_open()` works, but Kandelo has no
  process-shared futexes: a wait or wake reaches only the calling process,
  and a store in a shared mapping reaches a peer only at a syscall
  boundary (`docs/posix-status.md`, "No immediate cross-process
  shared-memory or futex semantics"). Measured with SemLock built in, a
  child's `release()` did not wake the parent's `acquire()` (a 10-second
  timed acquire returned `False`; an untimed one blocked until `SIGALRM`),
  and three children sharing a `Lock` were still blocked after 60 seconds.
  `config.site-wasm32-posix` therefore answers CPython's
  `ac_cv_posix_semaphores_enabled` probe `no`, CPython's own mode for
  this: `_multiprocessing` is built without `SemLock`. Change that answer
  when the kernel implements process-shared futexes.
- **Shared-memory coherence.** `mmap` `MAP_SHARED` mappings and
  `shared_memory` blocks converge between processes at syscall
  boundaries, not on each store (the same `docs/posix-status.md` entry).
- **`mmap.madvise()`** passes advice to the kernel's `madvise()`:
  `MADV_DONTNEED` zero-fills private anonymous pages, and advice Kandelo
  cannot carry out raises `OSError` (`docs/posix-status.md`,
  `posix_madvise()` / `madvise()`). `resize()` uses `mremap()`.
- **`resource.getrusage()`** reports user and system CPU time, which
  Kandelo measures at each thread's syscall boundaries; its other fields
  are zero (`docs/posix-status.md`, `getrusage()`).

## Installed layout

The runtime archive carries an empty `lib/python3.13/lib-dynload`, as
`make install` creates it even when every extension module is built in.
CPython's `Modules/getpath.py` takes that directory as the `exec_prefix`
landmark; without it every launch that did not set `PYTHONHOME` printed
`Could not find platform dependent libraries <exec_prefix>`. With it,
`/usr/bin/python3` finds `/usr` for both prefixes on its own, in a login
shell or not, and the shell sets no `PYTHONHOME`.
