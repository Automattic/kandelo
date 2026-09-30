# De-risk findings: nginx -> Python (WSGI) Notes API example

Task 1 of the nginx-python-notes-api plan. No product code changed; this
records the two unknowns the plan spec flagged, resolved against a real
build in this worktree.

## 1. Confirmed ABI

```
$ scripts/dev-shell.sh bash -lc 'grep -n "ABI_VERSION" crates/shared/src/lib.rs | head'
121:pub const ABI_VERSION: u32 = 43;
```

`ABI_VERSION = 43`. Use `kernel_abi = 43` wherever this plan needs to name
the current kernel ABI.

## 2. nginx and cpython ABI status: no bump required

`packages/registry/cpython/package.toml` declares `kernel_abi = 41` and
`packages/registry/nginx/package.toml` declares `kernel_abi = 7`, both far
below the current ABI 43. Despite that, **no rebuild-blocking ABI mismatch
exists and no `kernel_abi`/`revision` bump is required** to build either
package against the current kernel.

Why: `kernel_abi` in `package.toml` is documented in
`tools/xtask/src/pkg_manifest.rs` (around line 415) as an *optional ABI
floor*, and the field is currently `#[allow(dead_code)]` — "until the floor
is enforced" (Phase A-bis records it; Phase B is a not-yet-landed CI matrix
check). The resolver does not compare a package's declared `kernel_abi`
against `wasm_posix_shared::ABI_VERSION` at all today. What the resolver
*does* key on is `current_abi_version()` (`tools/xtask/src/build_deps.rs`,
`current_abi_version()` returns `wasm_posix_shared::ABI_VERSION`), which is
folded into the build/cache-key hash for every package and product. So a
fresh build of cpython/nginx is automatically keyed to ABI 43 regardless of
the stale-looking `kernel_abi` field in their `package.toml`.

This worktree started with git submodules uninitialized and no sysroots,
kernel wasm, or `local-binaries/` at all (a fresh checkout, per the
Build/Docs/PR contract's provisioning note). The very first resolve attempt
for `cpython` failed — not on an ABI mismatch, but because the wasm32 C
toolchain (`wasm32posix-cc`) had no sysroot yet:

```
$ scripts/dev-shell.sh bash -lc '... cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve cpython'
...
checking whether the C compiler works... no
configure: error: in `.../readline-8.2.../readline-src':
configure: error: C compiler cannot create executables
xtask build-deps: readline@8.2: build script .../build-readline.sh exited with exit status: 77
```

That is ordinary missing-artifact provisioning, not a platform defect.
Fixed by:

```
git submodule update --init --recursive
scripts/dev-shell.sh bash -lc './run.sh setup'
```

`./run.sh setup` (via `scripts/setup.sh` -> `cargo run -p xtask -- bootstrap`)
ran the full closure — musl sysroot (wasm32 and wasm64), the SDK, the whole
package engine (all `packages/sets/local-supported.toml` products, including
`cpython`, `nginx`, `nginx-vfs`, `nginx-php-vfs`, `browser-nginx`,
`browser-nginx-php`), rootfs, and host-dist (the TypeScript host bundle) —
and finished with exit code 0. The engine's own summary line reported both
packages `"succeeded"`:

```
{"disposition":"cached","node":{"kind":"package","name":"cpython","target_arch":"wasm32"},"state":"succeeded"}
{"disposition":"cached","node":{"kind":"package","name":"nginx","target_arch":"wasm32"},"state":"succeeded"}
```

After that, re-running the Step 2 resolve commands succeeded cleanly for
both packages (exit code 0 each), confirming they resolve/build fine at ABI
43 with their current, unmodified `package.toml`/`build.toml`:

```
$ scripts/dev-shell.sh bash -lc '... cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve cpython'
...
/Users/brandon/.cache/kandelo/programs/cpython-3.13.3-rev3-wasm32-00529e62b0eaca0f83d529f6fd843925780d9d8034c6ce64374bcb28fdb4f359
exit=0

$ scripts/dev-shell.sh bash -lc '... cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve nginx'
...
installed /Users/brandon/conductor/workspaces/kandelo/bandung/local-binaries/programs/wasm32/nginx.wasm
/Users/brandon/.cache/kandelo/programs/nginx-1.24.0-rev2-wasm32-fb9587d66c56dffff96987920576b1e130661c5d0228649c7dd3ad4d88f1a616
exit=0
```

**Verdict: no `kernel_abi`/`revision` package edits are required for this
plan.** The stale-looking `kernel_abi = 41` / `kernel_abi = 7` values are
inert (unenforced) today. If a later task wants to true these values up as
part of the plan (so the declared floor reflects reality), the exact edits
would be:

- `packages/registry/cpython/package.toml`: `kernel_abi = 41` -> `kernel_abi = 43`
- `packages/registry/cpython/build.toml`: bump `revision = 3` -> `revision = 4`
- `packages/registry/nginx/package.toml`: `kernel_abi = 7` -> `kernel_abi = 43`
- `packages/registry/nginx/build.toml`: bump `revision = 2` -> `revision = 3`

These are recorded here for reference only; this task does not make them,
per the task brief.

## 3. Browser HTTP surface (`nginx-php` live demo)

`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`:

- `HTTP_PORT = 8080` (line 221).
- The `LIVE_DEMO_SPECS["nginx-php"]` entry (lines 381-395) has
  `network: true` and `init.web.requiredPorts: [HTTP_PORT]` (i.e. `[8080]`).
- `init.web.requiredServices: [...REQUIRED_DINIT_SERVICES["nginx-php"]]`.
  `REQUIRED_DINIT_SERVICES` is imported from `./dinit-boot-status`
  (`apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts`,
  line 13), where `"nginx-php": ["php-fpm", "nginx"]` (line 15) — i.e. the
  live-demo boot tracker waits for both the `php-fpm` and `nginx` dinit
  services to report ready before treating the demo as booted.

**Confirmed `HTTP_PORT = 8080`.**

## Commands run (for reference)

```
git submodule update --init --recursive
scripts/dev-shell.sh bash -lc 'grep -n "ABI_VERSION" crates/shared/src/lib.rs | head'
scripts/dev-shell.sh bash -lc './run.sh setup'
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve cpython'
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --target aarch64-apple-darwin --quiet -- build-deps resolve nginx'
```

All commands were run inside `scripts/dev-shell.sh`, per the build contract.
`HOST_TARGET` resolved to `aarch64-apple-darwin` via
`rustc -vV | awk '/^host/ {print $2}'`.
