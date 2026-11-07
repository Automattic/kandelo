# Dormant notification queues and opened-entry ownership

Current214 composes queue -> descriptor -> opened-dentry producers over already
integrated shared epoll readiness. Actual bounded queues retain whole records;
internal FsNotify fd/OFD owners share state through dup/SCM_RIGHTS/modern exec.
Core read/poll/epoll consume that queue. New-kind fork inheritance is refused by
preflight before Writer/fd/ref/child commit; version20 tags/reader stay unchanged.

Regular tmpfs descriptions retain actual opened dentry identity on shared OFD
state, independent of inode-based data/mapping handles. Hardlinks remain distinct;
rename moves the same entry and unlink/name reuse never rebinds old opens. Actual
OPEN/read/pread/write/pwrite/ftruncate/final-close producers consume that owner.
Rename replacement now decrements exactly one nondirectory link, preserving other
aliases. No public inotify route is activated and fs.watch remains incomplete.

Root703 exact native input identities admit the preserved identified artifact and
fresh sealed12-process125-case rerun (0failures). No root runtime rerun or compile
is counted. Fifteen historical native Cargo test/check invocations, including one
missing-fixture compile failure, are counted once; readiness4 is already counted.
Native unity/bootstrap and884 declared engine inputs remain unchanged. Existing14
package checks are reused for the identical package inputs, not rerun or broadened.

A preparation command accidentally wrote integration JSON over root POSIX status
through path-variable reuse. The strict source guard failed before controls;
corrupt bytes were preserved and exact previous HEAD/state bytes restored before
this authorized source composition. Old sealed root-readonly metadata is false
and explicitly superseded by incident evidence, not silently rewritten. Original
wrong-seek/control failures and unknown zero-case artifact identities stay visible.

Actual host wake, metadata/SIGIO, full watch policy/quota/permissions, directory/
rootfs/provider/mount and other producers/order/deletion remain missing. Program
ABI/snapshot/channel source and existing fork wire are unchanged by this dormant
slice; this does not prove dynamic baseline compatibility or authorize public
activation. Fresh current kernel/engine and all-four-host evidence remain needed.
No engine revision bump, finding/family closure, overall suite or full rebuild.
