# TLS normal-open graceful write-shutdown prerequisite

A genuine existing native ShutdownWrap now owns a transport operation, actual
TLS/TCP private roots, the real TLS async ID trigger/frame and existing native
callback/error/retirement scope. No fabricated provider ID, Promise callback
engine or public _handle facade is added. The public bootstrap _final remains
inactive: early-end-before-secure, full TLSWrap/library-stack/handshake behavior
and identified-artifact guest validation remain missing prerequisites.

The shared ShutdownOperation waits for the real parent earlier-write barrier
and TLS write-ticket index, including callback-retiring tickets. It attempts
SSL_shutdown twice only if the first returned0, never waits for peer notify,
and retains original memoryBIO bytes until actual captured-parent completion
and acknowledgment. Only then may the same native request issue parentSHUT_WR.
A pointer to that actual pending Shutdown request temporarily authorizes its
attached transport's preceding ciphertext/alert drain despite writeShutdown;
raw/foreign writes remain refused. Half-close, cancel, detach and native request
retirement clear that reservation before its allocation is freed. Callback
lifetime keeps the existing real TLS request/parent-close barrier until scope
retirement. A private transport root is also cleared during context teardown.

Actual owning read/retry error paths record fatal SSL/SYSCALL results. The new
graceful operation refuses another SSL_shutdown after those; it does not run
the old invalid abrupt-after-fatal fixture. Existing best-effort Close attempt,
error/flush/drop behavior is byte-preserved. That candidate destruction policy
is not asserted equal to pinned Node DestroySSL, which is reviewed separately.

Four tiny native helper compilations succeeded. Six clean-queue native owner
subjects pass; two actual native Node TLSWrap/ShutdownWrap references confirm
local completion without waiting for peer alert. Two TLS1.3 injected-queue
preservation nonpasses remain unresolved against native reference behavior;
clean positives do not replace them or establish full error ownership. Original
EPIPE composition failures and all reference harness failures remain evidence.

Native OpenSSL3.5.9/Node headers/config and explicit portable callback tickets
are component dependencies. New guest C++/JSAPI/root/realm/GC/OOM/fatal/Worker
behavior is uncompiled; no four-host or full secure-network compatibility is
claimed. Current inputBIO remains direct socket BIO, unlike full Node ClearIn
ownership. No kernel/program ABI, platform identity, target pin, public TLS
server or overall-suite change is part of this slice.

The new primitive still waits for Open and does not establish target early-end
or in-SSL-library-call deferral. The real whole write list includes current
callback retirement, but admission of later writes and the shutdown phase gate
remain public-activation prerequisites. These are implementation gaps, not
accepted platform boundaries.
