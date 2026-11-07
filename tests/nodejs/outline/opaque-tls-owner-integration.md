# Opaque TLS native ownership integration

Source203 replaces the recyclable numeric TLS handle table with an actual
foreground context/generation/SSL_CTX/SSL/captured-descriptor owner. The private
bootstrap interface changes as a pair with the engine; old-engine/new-bootstrap
mixing is invalid. Pins and ABI55 stay unchanged; normal source declares and
stages the real portable tls-owner.h. New guest JSAPI remains uncompiled.

TCP transfer refuses active reads and native requests, completes fallible getter/
Promise/allocation work before descriptor commit and retires only the emptied
source. Private WeakMap state retains actual handshake/owner, so destroy closes
real pending SSL/fd authority. Separate thread-local watches retain capability/
Promise roots and immutable generation; detach before any arbitrary JavaScript
publication. Consumed byte/count/error material survives publication failure,
without replaying SSL I/O. Context shutdown stops producers without user callbacks.

## Focused evidence and limits

One current real native TCP/TLS portable-owner scenario passes with90observed
assertions,24plaintext bytes, actual SSL/SSL_CTX free callbacks and reused fd
number immune to old-owner close. Original run observed105assertions; retry-loop
assertions vary and are not independent API coverage. Current27TLS-policy and
12public-constant groups pass. Normal source/staging,876input closure, exact
engine patch replay, unchanged registration names/arities, unchanged Mozilla
checker, pinned bootstrap syntax and14package checks pass.

Exactly2previously uncounted tiny helper compiler attempts,1failed C++standard/
dependency fixture assumption and1success, are integrated once. Follow-on missing
component control failure is retained. Current controls reuse identified native
component and exact headers; no new compile/engine/kernel/product/guest/overall
suite ran. The upstream cipher-list file is native-only baseline evidence, not
a candidate upstream pass. Source201TTY/202SEA/currentcollector/SignJob remain.

## Full TLSWrap and HTTPS remain separate

D01SSL birth occurs after TCP connection and transfer retires sourceTCP. Pinned
TLSWrap is created earlier and retains an actual TCP parent. It proxies
hasPendingRead/ref/unref/controls through that parent; the earlier claim that
this method is absent was wrong. Do not invent a public native handle, provider
label, parent proxy or TLS plaintext probe to hide this owning-layer gap.

D02read material/acknowledgement, true Socket/StreamBase/onread/AsyncWrap/ref/timers,
full writes/error/lifetime, sessions/ALPN/cert/custom verification/CONNECT/options
and server/SecureContext remain gaps. Existing no-op public controls are not
passing support. Secure HTTPS Agent activation remains blocked. All guest
GC/realm/CCW/Worker/OOM/fatal/four-host obligations remain; no finding closes.
Fullproduct/overall deferrals remain, nested guest Wasm stays in scope last.
