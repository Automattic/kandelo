# Filesystem notification readiness prerequisite

This is a shared producer-correctness prerequisite, not public inotify or
Node fs.watch activation. Existing epoll sources consume it now; the sealed
private notification queue and filesystem frontend remain separate source
capsules. Public inotify syscall slots still return ENOSYS. No FileType, fd
creation interface, syscall descriptor, libc, fork tag/version, host wake wire,
program/host ABI version, snapshot or frozen executable changes in this slice.

## Shared candidate ownership

A committed VFS mutation cannot safely allocate while notifying an already
admitted queue. The existing epoll::notify made temporary Vecs for direct
candidates and nested parents. A native control observed five allocator calls
inside one real eventfd write through five actual nested epoll owners. This is
an allocation/commit-safety finding, not a measured performance claim.

The actual shared EpollInstance now owns one private notification epoch. The
existing epoll-table lock serializes epoch assignment and the entire cascade.
Direct interests retain the same event mask, disabled, error/hangup and
exclusive-sleeper policy. Nested parents inspect immutable child marks before
mutating their own interest; all paths retain distinct interest pending flags.
Four passes cover the existing legal graph depth in either slot order. Cycles
remain rejected by unchanged ctl; delivery still rechecks actual fd readiness
and preserves level, edge, oneshot, dup/fork and fd-reuse ownership.

Zero is an initial/noncurrent marker. Wrap clears only private markers under the
same lock before reusing one; it preserves pending events, waiters and sources.
Epoch is scratch, not a public identity or fabricated readiness generation.
There is no exhaustion failure after mutation. Concurrent calls serialize in
that lock. The borrowed section invokes no user/provider callbacks or allocator,
so it introduces no reentrant notification path; recursively borrowing that
existing table remains invalid. Callback/delivery ownership outside it is
unchanged. No guest/OFD/fork record stores the epoch.

## Native evidence and limits

The native runtime-core baseline control failed with five allocations versus
zero expected; original source, binary and diagnostics are preserved. After the
first correction the affected epoll module passed24 cases. The final source
passes26 cases:23 unchanged tests plus3 additions for allocation-free real write
and four parent edges in both orders, a real diamond graph, and forced wrap
without stale propagation or consuming pending candidates. Wrap is injected
into actual private scratch; it is not a public syscall conformance case. The
measurement allocator delegates unchanged to System and exists only in native
cfg(test), never guest or production builds.

These are native aarch64-apple-darwin Rust components, not an identified Wasm
kernel, Linux inotify reference, guest program, browser or four-host result.
Unchanged frozen ABI55 binaries are compile inputs only, not executed semantic
gates. Source/protected-byte checks do not replace ABI/runtime validation.
Current full product rebuild deferral remains in force.

## Required fd/OFD and activation continuation

1. Make an explicit program-contract decision before guest activation. Existing
   ABI55 baseline admission is exact and rejects even structural additions. The
   current channel-linked libc needs declared syscall/scalar/path marshalling
   metadata; appending those changes the Program digest. ABI history also names
   inotify ENOSYS, so a structurally additive snapshot alone does not approve
   changed observable semantics. Recommended next decision: specify a coherent
   extension/admission contract, preserving frozen55 bytes and old semantics as
   required, with negative admission of new requirements on older runtimes. An
   explicitly authorized new-baseline release is the alternative. Neither is
   implemented or silently selected here; never restamp old programs.
2. Consume the genuine queue into a managed descriptor/OFD kind. Preserve one
   real backing reference per owning OFD across dup, fork/spawn, SCM_RIGHTS,
   exec/CLOEXEC, blocked retry pins and final close. Reuse stable OfdId ownership,
   not reusable fd numbers or path aliases. Add actual flags/limits/read/error,
   FIONREAD/fstat and final epoll-interest retirement, with truthful unresolved
   APIs until implemented. No dormant helper means public support.
3. Classify the fork-wire change explicitly. Current version20 encodes tags0–12;
   a new notification kind needs a new tag and real retained backing, never an
   existing kind surrogate or copied queue. Appending a tag preserves old tag
   values/record width but old readers reject it. Decide versioned extension or
   version advance/reader policy from actual caller and kernel/host coherence,
   with negative unknown-tag/version controls. This slice changes none of them.
4. Connect authoritative queue publication to actual poll/select/epoll and host
   parked-waiter wake routing. Candidate marking alone does not wake a host
   channel. Existing wake buffer publication can also allocate; future routing
   needs pre-admitted or coalesced real wake ownership and its own kernel/host
   wire classification. Do not reuse an unrelated wake kind or decode fs_changes
   refresh hints as notification records. This shared epoll correction removes
   one prerequisite; it does not finish producer-to-host wake ownership.
5. Complete actual producers and policy. The sealed tmpfs subset has real inode
   and namespace identity but no opened-dentry owner for directory-child
   MODIFY/ACCESS/OPEN/CLOSE after hard links/rename. Rootfs/persistent/provider/
   mount/internal-tree mutation paths, permissions, masks, quotas and lifecycle
   remain gaps. Do not invent directory events for every pathname alias.
6. After source/ABI admission is coherent, report the need for a fresh identified
   kernel artifact before building under the user's deferral. Validate actual
   guest descriptors, waits/signals/overflow/rename/dentry/fork/exec lifetimes and
   unchanged Node watch assertions on Node, Chromium, Firefox and WebKit, plus
   unchanged frozen-program gates. ENOSYS and missing implementation remain
   failing gaps, not passing skips or accepted platform exclusions.
