# meson

Meson 1.12.1, installed as `meson.zip` mounted at `/usr`: the `mesonbuild`
package in its own directory, `/usr/lib/meson`, and `/usr/bin/meson`, the
console script `pip install meson` would write, which puts that directory
on `sys.path` and is run by `/usr/bin/python3`. Meson stays out of the guest
Python's own `/usr/lib/python3.13`, which images such as web-stack copy
eagerly as Python's; files of a lazy archive mounted inside it could not be
copied. The
shell carries it as a lazy archive beside `python-browser-bundle`; the
build image holds it, Python and Ninja resident. A project builds the usual
way, natively inside Kandelo:

```sh
meson setup build
ninja -C build        # or: meson compile -C build
meson test -C build
meson install -C build
```

## How Meson describes Kandelo

Meson reads the machine from Python's `platform` module, which reports
`uname`: `host_machine.system()` is `wasm-posix`, `cpu_family()` and
`cpu()` are `wasm32`, and `kernel()` is unset, because Meson maps no kernel
name to `wasm-posix`. That is the truth about the machine, and Meson needs
no native file to build: the compiler is the guest SDK's `cc` (Clang 21),
the linker `wasm-ld`, and probes such as `cc.has_function()` link against
the SDK's sysroot, so a missing function is reported missing. A build
script that tests `host_machine.system() == 'linux'` takes its generic path
here, as Kandelo is not Linux.

This differs from the SDK's cross files (`sdk/meson/wasm32posix.ini`),
which declare `system = 'linux'` for cross builds on the build machine.

Two patches:

- `patches/0001-wasm-posix-executable-suffix.patch`: Meson names
  executables `<name>.js` on any system whose name starts with `wasm`, a
  convention for Emscripten's JavaScript loaders. Kandelo runs WebAssembly
  executables directly by path, so the patch leaves `wasm-posix`
  executables unsuffixed, like any POSIX system's.
- `patches/0002-kandelo-refuse-linking-programs-to-shared-libraries.patch`:
  on a `wasm-posix` machine Meson refuses an executable's `link_with` of a
  shared library, naming `static_library()`, `-Ddefault_library=static`
  and `shared_module()`, instead of leaving the link to fail.

## Limits

- **Modules, not shared libraries.** A Kandelo executable cannot link
  against a shared library. `library()` defaults to shared, so Meson stops
  at configure time with "a Kandelo program cannot be linked against a
  shared library"; use `static_library()`, or
  `meson setup -Ddefault_library=static`. `shared_module()` builds a side
  module, `lib<name>.so`, that `dlopen()` loads, and `export_dynamic: true`
  on the executable (`-Wl,-export-dynamic`) exports its symbols, and the
  libc functions it links, to it. `dependency('dl')` is built in: the SDK
  links its loader into any program that calls `dlopen`. See "Plugin
  modules" in `docs/sdk-guide.md`.
- Kandelo reports one online processor, so by default Ninja (and
  `meson compile`) runs two jobs at a time and `meson test` one test at a
  time. `-j` and `MESON_NUM_PROCESSES` override them.
- The polkit policy upstream installs for `meson install` elevation is
  left out: Kandelo has no polkit.

Meson needs the `fcntl` module for its build-directory lock and `pwd` for
`meson install` as root. Kandelo's CPython builds both
(`packages/registry/cpython/posix-libc-modules.patch`).

## Manual page

`meson-docs` ships upstream's `man/meson.1` from the same release tarball.
