# B54 — the browser E2E suite has no defined artifact-resolution mode

You are fixing **B54**. Read `docs/plans/2026-09-11-MASTER-PLAN.md`, section
`## B54`, for the filed record; this brief is self-contained.

**The maintainer has decided the direction**: the suite runs **source-only,
matching the dev server**. You are not being asked to choose between modes.
Expect this to surface real failures that the ambient mode was hiding behind
stale artifacts — that is the point, and those failures are findings to file,
not reasons to back out.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-b54 \
        -b brandonpayton/b54-browser-suite-resolution-mode \
        brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-b54

Work **only** there, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger. The campaign
branch is pushed to `brandonpayton/epoll-kernel-route`; there is no remote
branch under its local name, which has confused agents before.

**Do not push.** The stash stack is shared across worktrees, so never use bare
`git stash`.

## What is wrong

The suite resolves artifacts differently depending on how it is invoked, and
nothing in the tree pins which is correct.

| invocation | source-only policy |
|---|---|
| `./run.sh browser` (dev server) | **yes** — `cmd_prepare_browser` exports `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` |
| `./run.sh test browser` | **no** — exports neither |
| Playwright's own web server | inherits the caller's environment (`playwrightWebServerEnvironment` copies `process.env`) |
| CI `browser-demos-ci.yml` | **no** — and it runs five smoke specs, not the suite |

Under source-only a built package lands in `local-binaries/source-only-v1/`,
not in the ambient `local-binaries/programs/wasm32/`. The demo VFS images are
reached through `import.meta.glob` over the **ambient** roots, in both
`apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts` (node-vfs,
wordpress, lamp) and `.../live-setup.ts` (nginx-vfs, nginx-php-vfs). So an
ambient-mode run resolves whatever stale copies happen to remain on disk, and
reports `<name> is not built` for artifacts that are present and correct in the
projection.

That is why the nginx demo passed before the B53 work and failed after.
Nothing about nginx changed: `./run.sh setup` republished the VFS-image
packages once the image writer entered their identity, the republish landed in
the projection, and the leftover ambient copy the suite had been reading
stopped being there. **It was passing on a stale artifact.**

## The part that matters most: fixtures are ambient-only

Test fixtures are not projected. `exec-child.wasm` is on disk at
`local-binaries/programs/wasm32/exec-child.wasm` and appears in the projection
manifest **zero** times:

    python3 -c "
    import json
    d=json.load(open('local-binaries/source-only-v1/.kandelo/source-only-program-projection-v1.json'))
    print(json.dumps(d).count('exec-child.wasm'))"

`apps/browser-demos/test/ruby-posix-spawn.spec.ts` resolves its inputs through
the resolver:

```ts
const rubyBinaryPath = tryResolveBinary("programs/ruby/ruby.wasm");
const execChildBinaryPath = tryResolveBinary("programs/exec-child.wasm");
const artifactsAvailable = rubyBinaryPath !== null && execChildBinaryPath !== null;
```

Ruby itself **is** projected. `exec-child.wasm` is not, so `artifactsAvailable`
is false and **both Ruby tests skip silently** under source-only. The sanctioned
composition therefore drops the browser coverage of Ruby's fork and vfork paths
— the campaign's own subject — while reporting green.

A skip is worse than a failure here. Whatever else you do, **make an
unresolvable fixture loud**: a spec that cannot get its inputs should fail, not
quietly vanish from the count.

`process-memory-retirement.spec.ts` survives only because it reads its fixtures
with `readFileSync` on ambient paths instead of resolving them. That is a
bypass, not a fix; treat it as a second instance of the same problem, not as
the pattern to copy.

## The work

1. **Project the browser test fixtures.** They must be owned members of the
   source-only projection, the way `kandelo_image_module32.wasm` became one in
   B53 (`CORESIDENT_SIDE_MODULES` in `tools/xtask/src/local_build.rs`, and the
   matching allowlist in `host/src/binary-resolver.ts`). Fixtures are a
   different category from co-resident modules, so work out where they belong
   rather than forcing them into that table.
2. **Pin the suite's mode.** `./run.sh test browser` must export the same
   policy `cmd_prepare_browser` does, and the mode must not be silently
   inheritable from the caller's environment.
3. **Settle `KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL`.** Nothing in the
   repository ever sets it — not `run.sh`, not a script, not a workflow — so
   `expectSourceRootfsShell` is always false. Under source-only the Node demo
   boots, evaluates JavaScript in the terminal, and then fails only here:

        expect(standaloneShellRuntimeFetches.filter(({name}) => name === "coreutils"))
          .toHaveLength(expectSourceRootfsShell ? 1 : 0)
        Expected length: 0   Received length: 1

   The spec encodes two modes and the tree supplies no way to select the one
   source-only actually produces. Decide which is correct and make the tree say
   so; do not set the variable just to make the assertion pass.
4. **Make the fixture/mode coupling hold.** A guard, not a comment. B53's two
   guards are the local precedent, and the defect they close is exactly this
   shape: two lists in two places that must agree, with prose as the only
   enforcement.

## Standing constraints

* **Perturb every guard until it fails before claiming it works.** A
  perturbation that cannot reach the code proves nothing.
* **Run the surface budget before every commit** and read its verdict lines:
  `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/surface-budget.test.ts'`
* **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
* **No `ABI_VERSION` bumps** — everything stays under ABI 44.
* **Gate on exit codes, never on piped output.** `cmd | tail` reports `tail`'s
  status; this has already cost this campaign a false "setup passed".
* Check `git status` before `git add -A` —
  `packages/registry/.program-packages.json.index-transaction-*` is a build
  cache that must never be committed.
* Deferrals are the **maintainer's** call. Land the safe part, then stop and
  argue the case with what/why/cost/follow-up. Never self-defer.

## How to run things

Start from a green tree:

    cd /Users/brandon/kandelo-b54
    CARGO_NET_OFFLINE=true ./run.sh setup > /tmp/b54-setup.log 2>&1
    echo "exit: $?"          # gate on THIS

Run a browser spec the sanctioned way. Until step 2 lands you have to set the
policy by hand to reproduce source-only behaviour:

    scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
      WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
      WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=/Users/brandon/kandelo-b54/local-binaries/source-only-v1 \
      npx playwright test test/ruby-posix-spawn.spec.ts \
      --project=chromium --workers=1 --max-failures=0 --reporter=list'

Two things that will waste your time otherwise:

* **Run heavy specs alone and single-worker.** Running the ruby, memory and
  merge-gate specs together starved them: three of four "failures" in one such
  run were plain 180s/600s timeouts, and a concrete assertion was replaced by a
  verdict that said nothing. A timeout in this area is a resource verdict, not a
  platform verdict.
* **The merge gate is serial** (`test.describe.configure({ mode: "serial" })`),
  so one failure aborts every demo behind it. `--max-failures=0` does not change
  that; `--grep-invert` advances it one test at a time.

## A mistake already made here, so you don't repeat it

This defect was first filed with the wrong mechanism: "the SourceOnly rewrite
does not claim these globs", evidenced by the transformed module serving all six
as `Object.assign({ })`, Vite's own expansion rather than the rewrite's output.

**That evidence came from a dev server started by hand with `npm exec vite`,
which sets neither source-only variable, so the SourceOnly plugin was not in the
config at all.** The observation was real and the inference from it was
worthless.

The rewrite works. Instrumenting the `transform` hook in
`apps/browser-demos/source-only-vite-assets.ts` and starting the server with
both variables set shows it running before Vite's glob expansion and emitting
correct projection-backed importers:

    PROBE optional-demo-vfs.ts hasGlobText=true hasObjectAssign=false

    "../../../../../local-binaries/programs/wasm32/node-vfs.vfs.zst":
      () => import("/@id/__x00__kandelo-source-only-asset:programs%2Fwasm32%2Fnode-vfs.vfs.zst?import")

`tests/package-system/source-only-vite-assets.test.ts` already covered the unit
("rewrites an exact mirror glob when only SourceOnly owns the artifact"). Read
it before concluding the unit is broken.

**The lesson to carry:** in this area, always confirm which server you are
talking to and what environment it has, before drawing any conclusion from what
it served.
