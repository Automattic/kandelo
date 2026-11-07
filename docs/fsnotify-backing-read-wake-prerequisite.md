# Reactive backing-read wake source candidate

This source follows the dormant fsnotify queue/readiness/descriptor/dentry
owners and addresses one real FS-005 dependency. The public inotify slots still
return ENOSYS. It neither completes Node FSWatcher nor wakes every host-owned
poll/select/epoll request. The integrated native runtime consumers now compile;
the Wasm kernel typechecks without linking or guest execution. Producer-seal
observations below describe the earlier private helper-only stage.

## Actual consumed source

A normal registered task's blocking read that returned EAGAIN may now park for
an actual live managed eventfd or FsNotify backing. The syscall channel remains
the real caller's channel; its fd/count are checked against the staged call,
its pointer is decoded at the process pointer width, and its existing exact
blocked-OFD binding is retained. The source key is a typed backing kind and its
real handle. That binding prevents handle/OFD slot recycling while the park owns
it; it is not a new caller-assigned token or a pipe/PTY/datagram surrogate.

Actual FsNotify queue insertion and successful eventfd write record that typed
source. The existing retry settle runs the real syscall against its pinned target,
leaves EAGAIN parked, and completes success/error through the existing task/channel
generation owner. Signal interruption/restart, cancellation, exit, exec and binding
release use the existing Retry owner. Successful direct completion retains the
existing live-task/signal/stopped/shared-memory guards; other results use the
normal queued completion path. Only an actually decided kernel wait produces the
existing TYPE_WAIT_COMPLETE and existing host completion drain/publication.
No host wire bit, record layout, export/import signature, ABI pin or fork tag is
added or repurposed. All hosts consume the same existing kernel/worker protocol.

The new ReadySources owner reserves physical Vec capacity while the park may
still fail. Interested retry sources only can be published. Admission accounts
for old dirty entries plus live/new retry owners; duplicate notifications consume
no extra slot. Settlement clears entries while retaining admitted storage, rather
than mem::take losing it. Publication scans real retry owners and pushes into
that prepared storage without allocation or callbacks. A failed reservation
returns ENOMEM before that park/channel is published, and the dispatch owner
releases the just-created exact OFD binding. This is allocation/commit safety,
not a performance or complete kernel-memory-accounting claim. Existing queue/
completion/settlement allocations outside this publication path remain separate.

## Concrete limits and next owners

Timerfd remains on the old path. Its actual timerfd_refresh is lazy: merely adding
a typed source without scheduling the real clock/deadline refresh would strand
an infinite read, or convert expiration into a timeout. A genuine deadline/
refresh/retry owner is required before admitting timerfd here. No fake expiration,
clock metadata or polling timer is added. Existing pipe/socket and timerfd source
behavior otherwise remains intact.

Host-owned poll/select/epoll waits still need genuine source registration/wake
ownership or migration into kernel-owned Parks/completion, including masks,
timeouts, nested epoll, descriptor generations and cancellation. Current packed
wake events already use all eight bits. Adding/reinterpreting a bit or a new
host-export flag would require an explicit kernel/host contract decision and
snapshot assessment; no such change is made here. This read slice avoids that
by consuming the existing decided-wait protocol, not by claiming poll is fixed.

Unregistered task channels, other read/write families, complete metadata/SIGIO,
watch policy, directory/rootfs/provider/mount producers, deletion/order semantics,
new-kind fork inheritance, frozen55 admission and public activation remain gaps.
Host-originated VFS mutation/drain coverage also needs actual end-to-end review.
Caller-buffer EFAULT/partial-copy and completion-allocation behavior use existing
transfer owners and remain unvalidated; no new claim of those semantics follows.

## Evidence

A standalone native control imports the exact production ReadySources module;
it is not a rewritten copy. Four cases pass: duplicate/clear/reuse publication
allocates zero times in the measured region; deterministic admission overflow
preserves old dirties; stale and new admitted sources coexist; and an unadmitted
publisher asserts rather than allocating or dropping silently. The last is an
expected programmer-invariant control, not a public API pass. The admission
failure test uses usize::MAX capacity overflow, not physical OOM injection.

At the original producer seal, only this small helper was compiled with
task-local rustc output via the declared
dev shell. The command uses rustc's native host default; compiler observation and
exact source/binary identity are recorded, not relabeled as an explicit --target
invocation. Parks, backing admission, kernel dispatch/settle/publication and host
interaction were not typechecked or run. Rustfmt was used only to parse the
changed Rust leaves with stdout discarded, not as a formatting or compile gate.
Old 125-case artifacts do not validate this changed candidate and are not rerun.
No Cargo/dependency/kernel/Wasm/engine/product build, overall suite or guest/four-
host validation occurred. Full source/native/kernel controls remain necessary
within the user's product-rebuild deferral and current resource constraints.


## Conservative backing-read admission refinement

A new backing read whose fd/count snapshot is exact but whose count exceeds
MAX_PARKED_TRANSFER now remains on its original host retry path. The bounded
kernel owner does not turn that storage limit into eventfd EIO or truncate the
call. Snapshot read/fd/count errors and all prior pipe guards remain errors;
there is no inferred clipping exception. Current Node/browser host large reads
already use a separate reserved transfer export, and generic read marshalling
does not intentionally shorten counts, so this refinement does not claim an
end-to-end oversized/clipped-read regression reproduction. Any future legitimate
clipping must be established at its actual staging owner.

The final extracted scalar production admission policy passes six tiny native
Rust cases. At the review seal only that policy was compiled; full consumers were uncompiled
and the changed kernel source was syntax-parsed only. A superseded permissive clipping
assumption/control remains separately preserved; it is not shipped. No ABI,
wire, export, frozen55 fixture or public activation changes. Shared read-copy,
settlement/completion allocation, peer-memory liveness and lifecycle evidence
remain required. This does not close FSWatcher, fsnotify, waits or core parity.


## Integrated native compilation and Wasm typecheck

The combined root candidate passes a targeted native runtime-core release build
and a wasm32-unknown-unknown kandelo library Cargo check through the declared
dev shell. Raw Cargo success receipts and identified native output are retained
in the backing-read-wake finding evidence. The latter checks the actual kernel
admission/settlement/publication consumers; it produces no linked kernel Wasm
and proves neither ABI baseline execution nor host/guest behavior.

Two added native controls exercise actual producer hooks, task retry parks,
OFD bindings, sys_read and queued completion: eventfd counter mutation after
closing/reusing the original descriptor number, and real tmpfs mutation through
the dormant notification queue. The local HostIO fixture provides caller memory;
it does not supply readiness or read results. These controls do not execute the
Wasm task/channel admission or direct-publication/host-drain path. Exact current
results and artifacts are recorded separately rather than inferred from the
earlier125-case artifact.

The notification producer's lock path includes a short Parks borrow while holding
the notification table; that borrow performs source matching only and ends before
epoll notification. Retry extraction releases Parks before re-entering provider
tables. This source trace is not a complete lock/lifecycle proof. Shared transfer
copyback/allocation/peer-memory questions and all limits above remain open.
