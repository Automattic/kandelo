# Retained TCP shutdown requests

Connected Socket._final now submits a real foreground native ShutdownWrap
request over the same retained TCP owner as reads/writes/close. Complete pinned
net connected-final/afterShutdown selections supply callback/error behavior;
only retained-owner and private real request-factory admission are adapted.
No mutable public fd selects the actual descriptor and no dummy JS constructor
claims native support. The request has real native allocation/claims, parent,
context roots, async ID/trigger/frame, one submission and actual POSIX outcome.

Native admission happens after request init hooks. Earlier queued writes and
their callbacks retire before the actual deferred shutdown(SHUT_WR) syscall;
later writes are refused. Prior admitted writes may still progress after the
write-shutdown flag is set. Queued native shutdown keeps the loop alive and
holds the parent's close barrier independently of its ref bit. Parent close
cancels the real request before descriptor reuse can touch a replacement.
Actual errno/status is retained and passed to oncomplete; pinned afterShutdown
intentionally ignores deferred status while synchronous errors use ErrnoException.

The no-owner synchronous branch and connecting deferral are unchanged. A real
initialized unbound fd-1 owner reaches post-init ENOTCONN. Native closing remains
alive for init/admission until actual close completion. The dispatcher marks
completion after true child barriers, before close hooks/callback, so a shutdown
inside that close continuation returns EINVAL without initializing a new request.
This distinction is actual lifecycle state, not a guessed fd sign or errno.

Native helper/components are not new guest JSAPI, realm/root/GC/fatal/Worker or
four-host conformance. Private full ShutdownWrap constructor/prototype coverage,
other Socket/StreamBase lifecycle/metadata and actual guest provider behavior
remain incomplete. Existing Owner generation is real object identity, not a
new kernel/OFD-generation guarantee; external same-number fd misuse/reuse and
full native descriptor authority still need their broader owning audit. No ABI
or kernel syscall change is made. Real TLS attachment refuses raw TCP shutdown;
full TLSWrap close_notify/shutdown and HTTPS activation remain separate gaps.
