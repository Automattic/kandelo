# VFS Permission Enforcement — Follow-up Plan

> **Context:** PR 5/5 (`#443`, `vfs(5/5): permission enforcement`) lands the
> first end-to-end POSIX file-permission enforcement (`check_access`, sticky
> bits, setuid-on-exec, umask, EROFS on readonly mounts) gated on a runtime
> toggle that's now default-on. The PR description and per-task implementer
> reports surfaced 4 explicit "migration debt" items plus several adjacent
> follow-ups that didn't fit the PR's scope.
>
> This document is the deliberate revisit of those items: what's owed, why,
> dependencies, and a recommended ordering. **Each group below corresponds
> to one (or occasionally two) follow-up PRs.** Sizes are rough.

## TL;DR — priority order

| Group | What | Why | Effort |
|---|---|---|---|
| **A** | POSIX credential completeness (saved-set-id, supplementary groups, real-vs-effective uid for `access(2)`) | Security correctness; setresuid programs (servers that drop+regain root) broken today | 1 PR, ~1 week |
| **B** | `MountConfig.nosuid` (suppress setuid-on-exec per mount) | Security defense for future user-content mounts; cheap addition | 1 PR, 2–3 days |
| **E** | Pre-bake CA cert bundle into rootfs.vfs; delete `/etc/ssl/certs` overlay | Eliminates a fragile bridge; smallest delta | 1 PR, 2–3 days |
| **C** | Migrate legacy-SAB browser demos to `boot({vfsImage:"default"})` | Removes the `overlayEtcFromRootfs` bridge + `BrowserKernel.init()` legacy path; finishes PR 4/5's cutover | 1–2 PRs, ~1 week |
| **D** | `defaultMountsForTesting()` helper + migrate `dash`/`git`/`php`/`dlopen` tests off `io: NodePlatformIO()` | Eliminates the host-fs-leakage opt-out for tests that don't actually need it | 1 PR, ~1 week |
| **F** | Migrate remaining 16 direct-`NodePlatformIO` callers (demos + tests) | Quality of life; existing pattern works | 1–2 PRs, ~1–2 weeks |

Order recommendation: **A → B → E → C → D → F** (A unblocks D's helper design; B/E independent; D unblocks F).

---

## Group A — POSIX credential completeness

Three sub-items that hang together: they're all about closing the
credential gap so that a program running through the kernel sees the
same view of its own identity that it would on Linux.

### A1. Saved-set-uid and saved-set-gid fields

**Today.** `Process` (`crates/kernel/src/process.rs:247–250`) has:

```rust
pub uid:  u32,
pub gid:  u32,
pub euid: u32,
pub egid: u32,
// no suid, no sgid
```

`sys_setresuid` (`syscalls.rs:8574`) takes `(ruid, euid, _suid)` with the saved-set arg **underscore-ignored**. Setuid-on-exec (PR 5/5 Task 5.7) updates `euid` but doesn't touch a saved-set field because none exists.

**Why it matters.** POSIX `setresuid(real, eff, saved)` lets a program drop privilege (`setresuid(-1, n, -1)`) and then regain it temporarily (`setresuid(-1, 0, -1)`) — but only up to the saved-set value. Without saved-set semantics:
- A server that exec's as root, calls `setuid(nobody)`, and later wants to re-elevate (to bind a privileged port, write a log, etc.) **cannot**.
- `setuid` programs (`S_ISUID` binaries) cannot fully implement POSIX semantics: after exec, real=invoker, effective=owner, **saved=owner** (so the program can `seteuid(real)` to drop and `seteuid(saved)` to re-elevate).
- No demo today exercises this path, but `passwd`-style binaries and any "drop privilege after setup" server would break the moment they're ported.

**Tasks.**
- Add `suid: u32` and `sgid: u32` to `Process`. Default to 0 (matches uid/gid defaults).
- Initialize `proc.suid = proc.euid` at `Process::new` (saved-set tracks effective at boot).
- Update `apply_setuid_setgid_on_exec` (`syscalls.rs:3504`) to set `proc.suid = proc.euid` and `proc.sgid = proc.egid` after the `S_ISUID`/`S_ISGID` branch fires.
- Update `sys_setresuid`/`sys_setresgid` to actually store the saved-set arg, with POSIX enforcement: non-root can only set each id to a value in `{real, effective, saved}`.
- Add cargo tests: drop-and-regain round-trip; non-root attempting to escape the {real,eff,saved} set returns EPERM.

**Effort.** Medium. ~3 days. The hardest part is the test matrix — POSIX setresuid has a few cells that aren't obvious.

### A2. `sys_access` uses real uid (not euid)

**Today.** `sys_access` (per audit) calls `check_access(..., proc.euid, proc.egid, ...)`. PR 5/5 noted this as a deliberate simplification "for consistency with check_open_access."

**Why it matters.** POSIX `access(2)` is specifically defined to check against the **real** uid/gid — so a setuid program (running as effective=root, real=invoker) can ask "would the invoking user be allowed to do this?" Using euid breaks that contract. There's `faccessat(AT_EACCESS)` for the euid variant.

**Tasks.**
- Change `sys_access` to pass `proc.uid`/`proc.gid` to `check_access`.
- Add cargo test: process with `uid=1000, euid=0` checks `access("/root-only", R_OK)`; expect EACCES (uses real uid 1000), even though euid would grant.
- Verify `sys_faccessat` honors `AT_EACCESS` — if it's not threaded yet, add that thread (cheap, one branch).

**Effort.** Small. ~half a day. Standalone, but tested most easily after A1 (when uid and euid can differ at all).

### A3. Supplementary groups

**Today.** `check_access` accepts `caller_groups: &[u32]` but every call site passes `&[]`. `Process` has no `groups` field. `setgroups`/`getgroups` syscalls exist as no-ops or partial implementations (audit-flagged; verify exact state).

**Why it matters.** Real-world programs (process supervisors, container managers, anything calling `initgroups`) rely on supplementary group membership for permission grants. A file mode-0o040 (group-read only) is unreachable for a process whose primary gid doesn't match — even if the user is a member of that group via supplementary. Today's behavior silently denies these accesses.

**Tasks.**
- Add `groups: Vec<u32>` to `Process` (or `[u32; N]` if `no_std`-on-wasm-target is fussy; check what's idiomatic — `Vec` is fine in cargo tests but kernel target might prefer fixed-size).
- Initialize empty.
- Implement `sys_setgroups(n, gidset)`: writes the array; restricted to euid=0 per POSIX.
- Implement `sys_getgroups(n, gidset)`: returns count + writes.
- Plumb `proc.groups` through every `check_access` call site (audit lists 12 syscalls).
- Cargo tests: setgroups + access via a supplementary group; non-root setgroups returns EPERM.

**Effort.** Medium. ~2 days. Mechanical plumbing; the cargo test that supplementary-grants-access is the value.

**Cross-cutting note (A1+A2+A3).** All three are credential semantics, share the test harness, and produce a coherent "credentials are now POSIX-compliant" PR. Recommend landing as one PR rather than three.

---

## Group B — `MountConfig.nosuid`

**Today.** `MountConfig` has `readonly: boolean`. Setuid-on-exec (PR 5/5 Task 5.7) fires unconditionally whenever the binary's mode has `S_ISUID`/`S_ISGID`.

**Why it matters.** `nosuid` is a standard mount option that tells the kernel: ignore setuid/setgid bits on binaries from this mount. It's a defense for any mount that could contain user-controlled binaries — historically `/home`, `/tmp`, removable media, network mounts. For wasm-posix today there's no user-content mount, but the moment we add one (uploaded-files mount, OPFS-backed user homedir on browser, etc.) we want this knob present.

**Tasks.**
- Add `nosuid?: boolean` to `MountConfig` in `host/src/vfs/types.ts`.
- Plumb the value through `VirtualPlatformIO` so the dispatch result includes the mount's `nosuid` flag.
- Either:
  - **Option B1** (simpler): expose mount-nosuid query as a new kernel-host extern, e.g. `host_mount_flags(path) -> u32`. Kernel calls it during exec and conditionally fires setuid logic.
  - **Option B2** (richer): include `nosuid` bit in the exec-result struct that `host_exec` returns. Avoids a second host round-trip.
- Update `apply_setuid_setgid_on_exec` to skip when the mount is `nosuid`.
- Vitest: mount a writable scratch as `nosuid`, exec a setuid-0o4755 binary from it, assert euid unchanged. Mount same backend writable but not nosuid, repeat, assert euid changed.

**Effort.** Small-medium. ~2 days. Option choice (B1 vs B2) wants a quick spike.

**Note.** PR 5/5 design decisions also flagged a related "noexec" option. Out of scope for this PR — would require a separate "exec at all" check that doesn't exist today. File as a future ticket if/when relevant.

---

## Group C — Browser legacy-SAB demo cutover

**Today.** PR 4/5's Task 4.5 left a bridge in `examples/browser/lib/kernel-worker-entry.ts`: when the legacy `fsSab` path is used (no `vfsImage` passed), the worker overlays `/etc/{passwd, group, hosts, services}` from rootfs.vfs at boot via the `overlayEtcFromRootfs` helper. This kept `erlang`, `git-test`, `doom`, `benchmark`, `test-runner`, `texlive` demos working through the synthetic-removal cutover.

**Why it matters.** The bridge is dead code as soon as those 6 demos migrate to `boot({vfsImage:"default"})`. Removing it shrinks the browser kernel-worker by ~60 lines and eliminates the maintenance burden of "two browser boot paths."

**Tasks.** Per-demo:
- **C1. Erlang demo** — switch entry point to `BrowserKernel.boot({vfsImage:"default", argv, env, ...})`. Verify it reads `/etc/services` for port lookups.
- **C2. Git-test demo** — same. This is the demo that previously hit "dubious ownership" before host-fs uid normalization; the boot path should already work.
- **C3. Doom demo** — uses the framebuffer. Verify mount layout includes `/dev/fb0` (kernel synthesizes; should be fine). Check whether doom assumes any writable paths outside the default scratch mounts.
- **C4. Benchmark demo** — loads various pre-built `.vfs.zst` images. Migrate to `boot({vfsImage:"<demo>.vfs", ...})` per benchmark.
- **C5. Test-runner demo** — runs the sortix suite in the browser. May depend on the legacy SAB's ability to inject test fixtures at runtime; verify before migrating.
- **C6. Texlive demo** — uses a large lazy archive (the texlive distribution). Confirm lazy-archive mode works under `boot()`.

**Once all 6 are migrated:**
- **C7.** Delete `overlayEtcFromRootfs` from `kernel-worker-entry.ts`.
- **C8.** Delete `BrowserKernel.init()` (legacy SAB path); keep only `BrowserKernel.boot()`.
- **C9.** Delete the `legacy fsSab branch` in `kernel-worker-entry.ts`.

**Effort.** Medium per demo, large in aggregate. ~1 week. Each demo can land as its own commit. The cleanup tasks C7–C9 should be a separate small PR after all migrations land.

**Manual smoke required**: every migrated demo needs a `./run.sh browser` walkthrough per project convention.

---

## Group D — Test infrastructure consolidation

**Today.** PR 4/5 + 5/5 introduced 5 tests that opt out of the mount router via `io: new NodePlatformIO()`:
- `host/test/dash.test.ts` (PATH lookup of `/bin/cat` etc. via host fs)
- `host/test/git.test.ts` (cross-boot persistence via host `/tmp`)
- `examples/libs/php/test/php-hello.test.ts`
- `examples/libs/php/test/php-concurrent-sqlite.test.ts`
- `host/test/dlopen-e2e.test.ts` (writes `.so` under `os.tmpdir()` and passes the absolute path to the wasm program)

Plus PR 5/5 Task 5.6 added an "ancestor-of-registered-path" inference to `MockHostIO`: when `host_stat` is called on a path that's an ancestor of a path registered with `set_file_with_owner`, it returns `S_IFDIR | 0o755` instead of ENOENT. This is a test-fixture convenience.

**Why it matters.**
- The `NodePlatformIO` opt-out is the documented escape hatch but it's overuse-shaped: each new test author is tempted to opt out rather than think about how to express their fixture needs through the mount router. Long-term this dilutes the "VFS is the only lens" guarantee.
- The ancestor-inference shortcut masks real bugs: if a test sets a mode-0 on an intermediate but later forgets to declare it, the inferred 0o755 silently grants traversal.

**Tasks.**
- **D1.** Design `defaultMountsForTesting(opts?)` helper in `host/src/vfs/default-mounts-node.ts`. Returns a `MountConfig[]` with:
  - An in-memory rootfs MemFs (no file read from disk) populated from a compile-time fixture
  - Optional scratch dirs (path-prefix list, all `HostFileSystem`-backed)
  - An optional "host-bind" mount (e.g. `/host-build` → `BUILD_DIR`) for tests that need to hand paths back and forth
- **D2.** Migrate `dash.test.ts`: replace `io: NodePlatformIO()` with `defaultMountsForTesting({hostBind: {"/host-fixtures": fixturesDir}})`. Update PATH env to find binaries within the test-mounted root.
- **D3.** Migrate `git.test.ts` similarly; persistence works via the host-bind mount.
- **D4. and D5.** php tests; similar pattern. PHP tests need writable `/tmp` for the SQLite WAL.
- **D6.** Migrate `dlopen-e2e.test.ts`: write the `.so` into a host-bind mount instead of `os.tmpdir()`. The `dlopen()` call inside the wasm program then targets a path that IS in a mount. (This is the trickiest migration — needs `dl-open-host-bind` to be writable from the test harness AND readable by the wasm program.)
- **D7.** Make the ancestor-inference opt-in: add an `inferAncestors: true` flag to `MockHostIO::new` and update existing tests that depend on it to set it explicitly. New tests get explicit-declaration by default.
- **D8.** Update `docs/architecture.md` "Permission model" section to describe the test helper.

**Effort.** Medium. ~1 week. Dependency on Group A only because the test helper should also accept `proc.uid/euid/groups` overrides — better to design once than retrofit.

---

## Group E — rootfs MANIFEST hardening (CA-certs)

**Today.** PR 4/5 Task 4.4 added a 256 KiB writable scratch memfs mounted at `/etc/ssl/certs` so the browser-side CA-cert injection survives the readonly `/` mount. The cert blob is injected at boot via `kernel-worker-entry.ts` writing through the overlay backend.

**Why it matters.** The overlay is a bridge to keep behavior working. Long-term:
- Pre-baked certs ship with the kernel binary (deterministic, reproducible)
- No runtime injection step (faster boot, less code)
- One less mount = simpler mental model
- `MemoryFileSystem.fromImage` returns a mutable copy today, so even when readonly enforcement is strict the cert path would just need to live in the image — no overlay needed

**Tasks.**
- **E1.** Decide on a source for the CA bundle. Options:
  - Bundle a copy in the repo (`rootfs/etc/ssl/certs/ca-certificates.crt`); update procedure is a periodic refresh (cron PR).
  - Download from Mozilla's cacert.org or curl's bundle at build time. Adds a network dep to `scripts/build-rootfs.sh`; risk of build flakes.
  - **Recommended:** bundle a copy. Add a `scripts/refresh-ca-certs.sh` for manual periodic updates. Cron job is a follow-up.
- **E2.** Add the path to `MANIFEST` with mode `0o644`, uid=0, gid=0.
- **E3.** Update `mkrootfs` if needed to handle large embedded files (~150 KB; current scaffolding should already cope but verify).
- **E4.** Delete the `/etc/ssl/certs` scratch overlay in `kernel-worker-entry.ts`.
- **E5.** Delete the CA-cert injection logic in the same file.
- **E6.** Verify TLS still works in MariaDB/WordPress browser demos (they exercise the cert path).
- **E7. (separate small task)** Fix `examples/browser/scripts/dinit-image-helpers.ts`'s inline `ETC_GROUP` — PR 3/5 audit flagged it's missing `nobody:x:65534:` vs the canonical rootfs version. Either fix in place OR delete the inline constants entirely (since the kernel now mounts rootfs.vfs at `/`, demos don't need to inject their own copies).
- **E8.** Decision on E7: delete the inline constants. Migrate any caller that depended on them to either include rootfs.vfs in their image build, or rely on the kernel's default mount.

**Effort.** Small-medium. ~2–3 days. Most of the time is in vendoring/refreshing the cert bundle and confirming TLS demos still work.

---

## Group F — `NodePlatformIO` direct-caller migration

**Today.** Task 4.1's audit identified 21 direct `NodePlatformIO` callers (6 demos + 15 tests). 5 of the test cases are tracked in Group D above. The remaining 16:

**Demos** (Task 4.1 audit list):
- `examples/run-hello.ts`
- `examples/nginx-test/nginx-wrapper.ts`
- `examples/mariadb-test/run-tests.ts`
- `examples/wordpress/test/wordpress-server.test.ts`
- `examples/libs/openssl/test/ssl-basic.test.ts`
- `examples/cpython/debug-test.ts`

**Tests** (the remainder; need re-audit before this group starts):
- 10 more tests scattered across `host/test/` that the Task 4.1 audit found but didn't enumerate by name.

**Why it matters.** Same as Group D's argument scaled up: every direct caller is a place where the "VFS is the only lens" invariant is bypassed. As we add new enforcement (e.g. nosuid, real-uid `access`) these callers won't exercise it.

**Tasks.**
- **F1.** Re-audit: enumerate the exact set of remaining `NodePlatformIO` callers in `host/test/` and `examples/`. Note for each: what host-fs access does it actually need, vs what could be expressed via the mount router?
- **F2–F17.** Per caller, migrate to `defaultMountsForTesting` (from Group D) plus a host-bind mount where necessary. Or, if the caller is a demo that genuinely needs raw host fs (e.g. `examples/run-hello.ts` invokes user binaries the kernel hasn't seen), document the rationale and KEEP the `NodePlatformIO` usage with an explanatory comment.
- **F18. (final).** Once the list is empty (or every remaining caller has a documented rationale), consider narrowing `NodePlatformIO` to a `HostServices`-only class (no FS ops) — per Task 4.4 implementer's note. This is purely a refactor: move FS methods out of `NodePlatformIO` so callers that "thought they wanted NodePlatformIO" can no longer accidentally reach them.

**Effort.** Large. ~1–2 weeks total. Each caller is small (~hour) but there are many.

**Dependencies.** Blocks on Group D's `defaultMountsForTesting` helper landing.

---

## Cross-cutting items (not their own group)

A few smaller follow-ups that fit in existing groups:

- **A4.** `chown` clears setuid/setgid bits is already done (PR 5/5 Task 5.5). No follow-up.
- **B3.** `noexec` mount option — out of scope; file as separate ticket when needed.
- **`docs/posix-status.md`** — Group A's PR should mark `setresuid`/`setresgid` saved-set-id as IMPLEMENTED and `setgroups`/`getgroups` as IMPLEMENTED.
- **`docs/compromising-xfails.md`** — Group A's PR may close some pthread/credential-related XFAILs.

---

## Dependency graph (recommended order)

```
A (credentials)
├──> D (test helper signature uses Process credentials)
│    └──> F (migrate remaining callers using D's helper)
└──> C (demo migration uses correct cred model)

B (nosuid mount) — independent
E (CA-cert pre-bake) — independent
```

Suggested rollout:

1. **Week 1:** Group A (credential completeness)
2. **Week 1, parallel:** Group B (nosuid) + Group E (CA-cert pre-bake)
3. **Week 2:** Group C (legacy SAB cutover) + Group D (test helper + 5 migrations)
4. **Week 3:** Group F (remaining 16 callers; sub-tasks parallel)

Total: ~3 weeks of focused work, but most groups can also be picked up opportunistically as time permits.

---

## What this plan deliberately does NOT include

These are NOT follow-up items — they're scope decisions the original PR series already made and shouldn't be revisited unless new evidence arises:

- **VFS image format changes.** The current SAB-blob format is fine; sparse encoding (the "Future Improvements" note about saveImage emitting 16 MB for 50 small files) is a separate optimization.
- **Mount mediation in the kernel.** Today's mount routing lives entirely host-side. Moving it into the kernel-wasm itself was considered (original 2026-04-25 design) and explicitly deferred.
- **Permission model changes (ACLs, capabilities).** POSIX rwx is what we implement. ACLs / `getxattr`-based capabilities are an entirely different surface.
- **MountConfig.uid/gid override.** Today `HostFileSystem` returns `uid=0/gid=0` constants for stat results. PR 1/5 fixed this; no follow-up needed unless someone wants per-mount uid override.
