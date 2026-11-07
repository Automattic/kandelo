# Dormant filesystem-notification descriptor owner

This source follows the sealed private fsnotify queue/tmpfs producer and shared
allocation-free epoll prerequisites. It adds a genuine internal FsNotify kind,
managed fd/OFD admission, queue reads and core readiness. No public inotify init,
add/remove-watch route is activated: slots247/381/248/249 still return ENOSYS.
No program/host ABI version, frozen ABI55 digest, snapshot, syscall/channel
marshalling, libc, fork version/tag or host wake wire changes. This is a partial
source prerequisite, not public inotify/fs.watch support or an exclusion of any
valid public case. Earlier capsules' no-descriptor statements describe those
historical slices, not this composed source.

## Real descriptor and queue ownership

The crate-private open_description prepares the actual Process fd/OFD/path and
flags before admitting the existing bounded Instance. That owning reference is
consumed into its real table handle; publication is the established nonfallible
prepared-descriptor transaction. Invalid flags, limits, fd exhaustion and memory
refusal publish no descriptor or orphan queue. Limits remain explicit private
admission, not fabricated Linux procfs quotas.

Descriptor backing management recognizes only this kind and its live actual
entry. Dup shares one description and flags; independent process/SCM ownership
uses existing retained backing operations. Last release frees the actual watch/
event buffers and active entry. A kernel blocked-read pin keeps the exact OfdId,
slot and queue through numeric fd reuse. Existing native SCM_RIGHTS queued
reference/install primitives keep the queue alive after sender close; no new
external wire representation is used.

Production modern exec commits in place. It retains a non-CLOEXEC alias/queue
and releases final CLOEXEC ownership through the normal close path. The legacy
exec serializer is cfg(test), and is not the production exec path.

Read consumes whole real encoded records, including record-size semantics for
zero-byte calls; aliases consume the same queue. FIONREAD sums actual queued
wire bytes. Poll/select and epoll inspect real queue content; actual new queue
insertions record EPOLLIN/RDNORM candidates, including arrivals while already
readable. Merged adjacent events and repeated queued overflow do not invent new
insertion callbacks. This matches the source insertion/wakeup phases in
[Linux v6.12 notification.c](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/notify/notification.c).

The notification table remains borrowed through candidate marking, avoiding a
reusable-index wake window. Lock order is tmpfs inode -> notification table ->
epoll table. The sealed candidate owner allocates/calls no provider; actual
epoll delivery snapshots interests and releases its borrow before querying the
notification table. No reverse borrowed-table callback or host call is added.
A native actual fchmod -> inode queue -> epoll control observes zero allocations.
Host parked-waiter wake publication is still a separate unimplemented owner.

Inotify deliberately uses noop_llseek: valid whence leaves the shared cursor
unchanged; invalid whence fails. This is real specified no-op behavior, not a
success facade. See [inotify operations](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/notify/inotify/inotify_user.c),
[anonymous-file initialization](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/file_table.c)
and [seek entry/implementation](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/read_write.c).
The anonymous constructor does not enable positional-read/write modes; those
fail without consuming records. Generic data-transfer staging cannot consume
the queue through an absent splice-read operation.

## Explicit gaps and v20 refusal

The kind has no v20 tag. Current tags0–12, version20 and decoder are unchanged.
The serializer preflights surviving descriptions before constructing its Writer,
changing fd/ref state or publishing/allocating a child identity. FsNotify yields
EOPNOTSUPP, not a surrogate kind or new old-version tag. CLOFORK filtering is real;
legacy test-only exec filtering also applies CLOEXEC first. Ordinary surviving
kinds retain their prior encoding and error/output-full path. ProcessTable's
existing temporary serialization scratch can still be admitted before this
preflight; no fd/ref/child commit occurs. Actual modern exec requires no new tag.
Unsupported fork/inherited wire remains an implementation gap, not passing
compatibility or an accepted platform boundary.

No real anonymous-inode metadata owner exists yet. Stat/statfs/chmod/chown return
explicit unsupported errors for this kind before generic fake/default metadata
or success-noops. Likewise SIGIO delivery is not implemented; async admission
fails before setting a flag no producer could honor. These are valid public API
failures that remain open. Passing native refusal guards does not count them as
passing stat, metadata, async or fork compatibility.

The private tmpfs watch helper retains the existing subset only. Full pathname
marshalling/resolution/credentials/masks, per-user quotas, rootfs/persistent/
provider/mount hooks and opened-dentry identity are absent. Tmpfs regular handles
encode inode index, not the opened dentry: exact directory-child MODIFY/ACCESS/
OPEN/CLOSE after rename/hard links needs that owner. Rootfs fs_changes refresh
hints are separate and are not decoded into notification records.

## Evidence and activation continuation

Focused native runtime-core controls exercise actual fd tables, OFDs, queue/
tmpfs mutations, read/poll/epoll/flags, duplicate/final-close, modern exec,
blocked-read reuse, retained SCM primitives and atomic admission/wire refusal.
They do not execute guest syscalls or host wake routing. Early native8 cases
passed an incorrect ESPIPE seek expectation; exact source/artifact/logs remain,
that policy/assertion was corrected from the primary source, and no target
conformance is inferred from that historical pass. Subsequent exact artifacts
and all command attempts are identified in the handoff. Original queue/readiness
and serializer assertions remain unchanged. Frozen55 artifacts are copied
unchanged as compile inputs only, never rebuilt/restamped or executed here.

Before public activation, make the explicit ABI55 program-extension/admission
or authorized new-baseline decision, complete linked channel metadata and
negative baseline gates, and specify a coherent new fork-kind reader/version
policy. Do not silently add a tag under version20 or restamp historical bytes.
Then implement remaining metadata/async/watch policy/producers and allocation-
safe real host wake routing; candidate bits alone do not wake parked channels.
Report the need for a fresh identified kernel before building under the user's
full-rebuild deferral. Actual guest lifecycle/fork/exec/namespace/overflow/wait
and unchanged Node watch coverage on Node, Chromium, Firefox and WebKit remain
required. No four-host or public compatibility closure is claimed.
