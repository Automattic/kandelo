# Prepared pipe-source action lifetime

The async spawn frontend emits all supported stdio dup2/open actions before
closing its prepared owned pipe sources in the child. It uses the existing real
pipe descriptor slots and genuine native minFd3 guarantee. An inherited numeric
fd can genuinely become valid when earlier pipe preparation reuses that number;
keeping that actual source alive closes the observed ordering gap. No descriptor
precheck, number reservation or success simulation is used. Parent rollback,
close-on-exec flags, borrowed descriptors and child wait cleanup are unchanged.

The existing numeric-diagnostic.cjs is intentionally unchanged. Its historical
scope/explanation text describes the prior nonpass; judge its actual expected,
actual, same and exit status. Before this action correction, native launches and
exits1 while the candidate throws EBADF; afterward both launch and exit1. The
old sealed failure remains evidence. This is a bounded actual-POSIX/native
component comparison, not guest JSAPI or four-host conformance.

Existing focused controls also retain genuine EMFILE/ENOENT/EACCES rollback,
EBADF without pipe reuse, borrowed fd flags/output/continued parent ownership,
actual pipe output, stdin exit cleanup and fd-table equality after child exit.
Full low-number borrowed-source cycles/remapping, inherited-source nonblocking
policy and cwd/file-action error precedence remain implementation gaps. Source
lifetime repair does not establish those behaviors or complete child_process.
