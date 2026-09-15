# B44 — spidermonkey cannot rebuild: a host tool links against no libc

Paste everything below into a fresh agent.

---

You are fixing **B44**. It blocks all six browser products, so the campaign's
browser suite cannot run to completion. Read `docs/plans/2026-09-11-MASTER-PLAN.md`,
section `## B44`, for the filed record; this brief is self-contained.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-b44 \
        -b brandonpayton/b44-spidermonkey-host-link brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-b44

Work **only** there, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger. Note that the
campaign branch is pushed to `brandonpayton/epoll-kernel-route`; there is no
remote branch under its local name, which has confused agents before.

## The failure

`packages/registry/spidermonkey/build-spidermonkey.sh`, during `mach build`:

    ld64.lld: error: undefined symbol: access
    >>> referenced by host_nsinstall.o:(symbol main+0x540)
    ... chown, strtol, getgrnam, getpwnam, rmdir, strncmp, readlink, strcpy
    >>> also referenced by host_pathsub.o

`host_nsinstall` is a **host** tool — a Mach-O binary that runs on the build
machine, not wasm. `strcpy` and `strncmp` being undefined means the link has
**no libc at all**, not a subtly wrong one.

## Reproduce

    cd /Users/brandon/kandelo-b44
    CARGO_NET_OFFLINE=true ./scripts/dev-shell.sh ./run.sh setup > /tmp/b44.log 2>&1
    echo "exit: $?"          # gate on THIS, never on piped output
    grep -aE 'undefined symbol: access|FAILED spidermonkey' /tmp/b44.log

Roughly 25 seconds to the failure once dependencies are cached. `CARGO_NET_OFFLINE=true`
is needed or the install step tries to reach `index.crates.io`.

## It is latent, not a regression

spidermonkey was served from **cache** in every earlier run — nothing had
rebuilt it in that worktree for some time. It began failing only when its cache
key moved, which is B38's mechanism: a `runtime-core` edit republishes kernel
and rootfs, and downstream keys follow. Do not go looking for the campaign
change that "broke" it; there isn't one.

## Three causes already eliminated — do NOT repeat these

Each was tested by a full rebuild, not by reasoning. All three looked right.

1. **Target `LDFLAGS` leaking into host links.** The recipe exports
   `LDFLAGS` with wasm32 archives and `-Wl,-z,stack-size=16777216`, and never
   sets `HOST_LDFLAGS`; mozbuild is documented to fall back to the target forms
   for host programs. Setting `HOST_CFLAGS`/`HOST_CXXFLAGS`/`HOST_LDFLAGS`
   empty → **identical error**.
2. **The cross linker leaking through `LD`.** The dev shell exports `LD=ld`,
   and `ld` resolves to `/nix/store/…clang-wrapper-21.1.7/bin/ld` — the cross
   wrapper, which drives `ld64.lld`. `HOST_LD` is unset. Rebuilding with
   `HOST_LD=/usr/bin/ld` → **identical error**.
3. **A missing macOS SDK.** Ruled out by reading the build log: the mozconfig
   does pass `--with-macos-sdk=/Applications/Xcode.app/…/MacOSX.sdk`, and
   `xcrun --show-sdk-path` resolves.

Also not the cause: the Xcode licence (cleared 2026-09-15; `/usr/bin/cc` links
a host binary fine inside the dev shell), a broken dev shell (a plain host link
works there), and stale configure state (no spidermonkey work directory
persists — each build starts in a fresh temp dir).

## The cause is FOUND — start from here, not from scratch

This section supersedes the earlier advice to capture the invocation first. It
has been captured. `mach build -v` gives the failing link:

    /usr/bin/cc -isysroot .../MacOSX.sdk --target=arm64-apple-darwin \
      -o nsinstall_real  -fuse-ld=lld  host_nsinstall.o host_pathsub.o

Apple's `cc`, the right SDK, the right target — and **`-fuse-ld=lld`**, which
routes the link to the nix `ld64.lld` on PATH. That linker supplies none of
Apple's default library search paths, so libSystem is missing and every libc
symbol is undefined. **The compile step is correct; only the link is wrong.**

**The flag is GENERATED, not inherited.** It is in neither the dev shell
(`LDFLAGS` is unset), nor the recipe, nor `scripts/`. It comes from mozbuild's
own configure, which prefers `lld` when it finds it on PATH. That is exactly
why elimination 1 below failed: `HOST_LDFLAGS=""` cannot clear a flag that does
not originate in `HOST_LDFLAGS`.

**Your job is the fix, not the diagnosis.** Stop mozbuild choosing lld for the
HOST link, or append a later `-fuse-ld` that overrides it — clang honours the
last one wins. Whatever you choose, the TARGET link must stay on `wasm-ld`;
breaking that trades one failure for a worse one.

**One candidate is untested.** A run with `HOST_LDFLAGS=-fuse-ld=/usr/bin/ld`
was started and **killed before it finished** when this work was handed over.
Its result is unknown. Do not read it as either confirmation or refutation —
re-run it yourself if you want to know.

Useful context while reading it: the recipe generates its mozconfig inline
(`build-spidermonkey.sh`, around line 319) with
`--target=wasm32-unknown-linux-musl`, and exports `CC`/`CXX`/`AS` as
`wasm32posix-cc`. On Darwin it sets `HOST_CC="${HOST_CC:-/usr/bin/cc}"` — an
override-respecting default, which is why the environment experiments above
were possible.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root form
  fetches an unpinned vitest.
- **Gate on exit codes, never on piped output.** `./run.sh setup | tail` gives
  you `tail`'s status and will report success for a failed build.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
- **Perturb every new guard until you have seen it fail**, and quote the failure
  text in the commit message.
- **A perturbation that cannot reach the code proves nothing** (H-25). Before
  believing a green result, confirm the code you changed is on the path the
  verifier exercises. This bit twice in one day.
- If a fix does not work, **revert it** rather than leaving an unproven edit in
  a delicate package, and record what was disproved.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- **Deferrals are the maintainer's call.** Land the safe part, then stop and
  argue it — what, why, cost, follow-up — and ask. Never self-defer.

## Done looks like

`./run.sh setup` reaches `"outcome":"succeeded"` with real exit code 0, and
`SUCCEEDED spidermonkey/wasm32` appears in the log. That unblocks
`spidermonkey-node`, `node`, and all six browser products.

Then say explicitly what you did **not** establish — in particular whether the
fix is specific to this machine's toolchain or holds for a fresh worktree.
