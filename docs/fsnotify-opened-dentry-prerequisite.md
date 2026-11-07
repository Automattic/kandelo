# Retained tmpfs opened-dentry producer prerequisite

This private source consumes the sealed queue/tmpfs, allocation-free readiness
and dormant fsnotify descriptor owners. Public inotify slots remain ENOSYS. It
adds no ABI55/snapshot/channel/libc change, fork-v20 tag or serialized field.
Existing inode-encoded data/mapping handles and file identity stay unchanged.
It is incomplete VFS notification source, not public inotify/fs.watch support,
a platform exclusion or identified-artifact compatibility on any guest host.

## Actual identity and lifetime

A regular tmpfs open attached to a prepared OFD now retains the actual opened
entry: inode index, parent inode and basename under the authoritative tmpfs lock.
Separate hardlinks produce separate entries. Independent opens of the same
linked entry share that entry but each has its own close owner. Unlink detaches
that entry without rebinding it to a replacement at the same pathname; rename
moves the actual retained entry and its parent pin. Rename-over detaches the old
destination entry, and removes only one nondirectory link from its inode.
The old destination's other hardlinks survive. Names are not reconstructed from
Ofd.path, namespace refresh hints or a search for an arbitrary inode alias.

The parent/child inode pins belong to the real retained dentry record. They
prevent reuse until its final close owner has retired, even when backing release
or namespace unlink happens first. Existing inode open/mapping reference counts
remain separate. The actual SharedOfdState owns one interest per open description;
dup shares it, SCM_RIGHTS queues/installers carry it, fork relinks it by existing
OFD identity, and modern exec retains it in place. CLOSE occurs on its last shared
owner, rather than each numeric fd close. An unarmed failed prepared description
retires its pins without manufacturing OPEN/CLOSE.

Dentry slot/name and pin-count admission precede filesystem creation/truncation.
Names use real bounded inline basename storage and table slots use the existing
IO_MEMORY budget. OPEN arms only at the established nonfallible prepared-fd
publication boundary. The O_PATH identity is retained but suppresses events.
Rename validates name/pin capacity and prepares the extra retained name before
namespace mutation; its dentry move itself allocates nothing. Existing general
tmpfs Vec/BTreeMap namespace allocation behavior is not converted into a fully
fallible VFS transaction by this slice.

## Consumed producers and remaining semantics

Real tmpfs-backed sys_open, read/pread, write/pwrite and ftruncate consume the
retained OFD identity. Nonempty successful data reads produce ACCESS; successful
nonzero writes and successful ftruncate route parent MODIFY in addition to the
existing inode producer. OPEN/CLOSE route both the actual parent basename and
inode watch. Writable close classification follows the immutable open access
mode, not whether a write happened. Zero-byte read/write produces no new event.

Legacy private raw-inode watch admission retains its original smaller producer
mask: those raw APIs cannot generate opened-description OPEN/ACCESS/CLOSE. The
new actual tmpfs descriptor/provider watch admission accepts these additional
implemented producers. Original queue assertions remain byte-identical; no
public valid case is called unsupported merely to hide missing implementation.
Both paths remain private and public inotify is still inactive.

The Linux reference contract is the real file path/dentry, including separate
hardlink entries, current rename identity and retained unlinked entries. See
[Linux v6.12 fsnotify file/close/access/modify hooks](https://raw.githubusercontent.com/torvalds/linux/v6.12/include/linux/fsnotify.h)
and [actual parent notification ownership](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/notify/fsnotify.c).
These are source references, not a Linux runtime differential run on this Mac.

Remaining implementation gaps include directory descriptors/iteration and
non-tmpfs providers/rootfs/mount events; permission/full-mask/quota policy;
EXCL_UNLINK semantics; parent ATTRIB and path-truncate/O_TRUNC notification/order;
exec/mmap/splice/copy/io_uring and other operation producers; precise inode-delete
versus inode-eviction/watch retirement and removed-parent behavior; real host
parked-waiter wake; anonymous-notification metadata/SIGIO; new-kind serialized
fork inheritance and the coherent program/channel/fork ABI activation decision.
Exact combined parent/inode event ordering and every failure/rename race still
need unchanged upstream/native Linux and guest validation. These are gaps or
unresolved conformance, not accepted boundaries or passing coverage.

## Focused evidence limits

Native runtime-core controls use real Process fd/OFD preparation, tmpfs namespace,
queue/readiness and shared-state owners. They cover open/read/write/positioned
I/O/ftruncate/zero-size/O_PATH/dup/final-close, distinct hardlinks, cross-directory
rename, unlink/name reuse, replacement of an open multiply-linked inode,
SCM retained/install primitives, modern exec, actual ProcessTable fork relink
(with the dormant notification fd CLOFORK), fd exhaustion and denied dentry
memory admission before truncation. Fork packet bytes/reader remain unchanged.
They do not execute a guest syscall channel, Linux reference runtime, actual
host wake adapter, four-host suite or rebuilt kernel.

The descriptor capsule's original failed/wrong-expectation evidence remains
immutable, and original queue/descriptor/readiness/serialization assertions are
preserved. Compiler inputs, exact artifacts and every attempt are recorded in
the handoff. Public activation still requires the earlier explicit frozen55
admission decision and coherent fork-reader/version/wake requirements. Report
that an identified new kernel is needed before building under the user's
full-product-rebuild deferral; no such build was performed for this source.
