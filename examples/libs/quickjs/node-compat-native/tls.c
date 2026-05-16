#include "tls.h"

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/bio.h>

#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Per-connection TLS state. The handle is the index into g_handles + 1
   (so handle 0 is reserved as "invalid"). */
typedef struct {
    int      active;
    int      fd;
    SSL     *ssl;
    SSL_CTX *ctx;            /* per-connection only when ca/insecure */
    int      ctx_owned;
    int      handshake_done;
} TlsHandle;

/* npm install of mid-size dep trees (express ≈30 deps, each fetched as
   manifest + tarball over keep-alive) routinely keeps 100+ TLS connections
   open in parallel; 64 was empirically too small. 1024 entries × ~24 B is
   ~24 KB of BSS — negligible. */
#define TLS_MAX_HANDLES 1024
static TlsHandle g_handles[TLS_MAX_HANDLES];
static SSL_CTX  *g_default_ctx = NULL;
static int       g_openssl_inited = 0;

typedef enum {
    TLS_WATCH_HANDSHAKE = 1,
    TLS_WATCH_READ      = 2,
    TLS_WATCH_WRITE     = 3,
} TlsWatchKind;

typedef struct TlsWatchEntry {
    int           handle;        /* 1-based index into g_handles */
    TlsWatchKind  kind;
    int           want_pollout;  /* 1 = POLLOUT, 0 = POLLIN */
    JSContext    *ctx;
    JSValue       resolve;
    JSValue       reject;
    uint8_t      *buf;
    size_t        buf_len;
    size_t        buf_off;
    struct TlsWatchEntry *next;
} TlsWatchEntry;

static TlsWatchEntry *g_watches = NULL;

static void watch_free(TlsWatchEntry *w)
{
    JS_FreeValue(w->ctx, w->resolve);
    JS_FreeValue(w->ctx, w->reject);
    free(w->buf);
    free(w);
}

static TlsWatchEntry *watch_alloc(JSContext *ctx, int handle, TlsWatchKind kind,
                                  int want_pollout, JSValue resolve,
                                  JSValue reject)
{
    TlsWatchEntry *w = calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->handle = handle;
    w->kind = kind;
    w->want_pollout = want_pollout;
    w->ctx = ctx;
    w->resolve = resolve;
    w->reject = reject;
    w->next = g_watches;
    g_watches = w;
    return w;
}

static void watch_unlink(TlsWatchEntry *target)
{
    TlsWatchEntry **pp = &g_watches;
    while (*pp) {
        if (*pp == target) { *pp = target->next; return; }
        pp = &(*pp)->next;
    }
}

static void resolve_with(JSContext *ctx, JSValueConst fn, JSValue arg)
{
    JSValueConst args[1] = { arg };
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, args);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, arg);
}

static void reject_with_message(JSContext *ctx, JSValueConst fn, const char *msg)
{
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message",
                              JS_NewString(ctx, msg ? msg : "tls error"),
                              JS_PROP_C_W_E);
    JSValueConst args[1] = { (JSValueConst)e };
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, args);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, e);
}

/* Pull the next OpenSSL error string and reject with it. Falls back to a
   stock message when the error queue is empty (e.g. plain syscall errors). */
static void reject_with_openssl(JSContext *ctx, JSValueConst fn,
                                const char *fallback)
{
    char buf[256];
    unsigned long code = ERR_peek_last_error();
    if (code == 0) {
        reject_with_message(ctx, fn, fallback ? fallback : "tls error");
        return;
    }
    ERR_error_string_n(code, buf, sizeof(buf));
    ERR_clear_error();
    reject_with_message(ctx, fn, buf);
}

static int alloc_handle(int fd, SSL *ssl, SSL_CTX *ctx, int ctx_owned)
{
    for (int i = 0; i < TLS_MAX_HANDLES; i++) {
        if (!g_handles[i].active) {
            g_handles[i].active = 1;
            g_handles[i].fd = fd;
            g_handles[i].ssl = ssl;
            g_handles[i].ctx = ctx;
            g_handles[i].ctx_owned = ctx_owned;
            g_handles[i].handshake_done = 0;
            return i + 1; /* 1-based */
        }
    }
    return -1;
}

static TlsHandle *get_handle(int handle)
{
    if (handle < 1 || handle > TLS_MAX_HANDLES) return NULL;
    TlsHandle *h = &g_handles[handle - 1];
    return h->active ? h : NULL;
}

static void destroy_handle(int handle)
{
    TlsHandle *h = get_handle(handle);
    if (!h) return;
    if (h->ssl) {
        /* Best-effort uni-directional close; ignore I/O at this point. */
        SSL_shutdown(h->ssl);
        SSL_free(h->ssl);
        h->ssl = NULL;
    }
    if (h->ctx_owned && h->ctx) {
        SSL_CTX_free(h->ctx);
    }
    h->ctx = NULL;
    if (h->fd >= 0) {
        close(h->fd);
        h->fd = -1;
    }
    h->active = 0;
}

static void ensure_openssl_inited(void)
{
    if (g_openssl_inited) return;
    /* OPENSSL_init_ssl is idempotent and thread-safe, but we still gate it
       to avoid the pointless work on every connect. */
    OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS |
                     OPENSSL_INIT_LOAD_CRYPTO_STRINGS, NULL);
    g_openssl_inited = 1;
}

static SSL_CTX *make_ctx(const char *ca_pem, int reject_unauthorized)
{
    ensure_openssl_inited();
    SSL_CTX *c = SSL_CTX_new(TLS_client_method());
    if (!c) return NULL;
    /* Pin to TLS 1.2+; refuse SSLv3/TLS1.0/1.1 outright. */
    SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);

    if (ca_pem) {
        BIO *bio = BIO_new_mem_buf(ca_pem, -1);
        if (!bio) { SSL_CTX_free(c); return NULL; }
        X509_STORE *store = SSL_CTX_get_cert_store(c);
        X509 *x;
        int n = 0;
        while ((x = PEM_read_bio_X509(bio, NULL, NULL, NULL)) != NULL) {
            if (X509_STORE_add_cert(store, x)) n++;
            X509_free(x);
        }
        BIO_free(bio);
        ERR_clear_error(); /* PEM_read_bio_X509 EOF surfaces as an error */
        if (n == 0) { SSL_CTX_free(c); return NULL; }
    } else {
        /* Default verify paths (OPENSSLDIR=/etc/ssl in our build).
           The wasm process inherits /etc/ssl/cert.pem from the host fs;
           later slices vendor a Mozilla bundle. */
        SSL_CTX_set_default_verify_paths(c);
    }

    SSL_CTX_set_verify(c,
        reject_unauthorized ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, NULL);
    return c;
}

static SSL_CTX *get_default_ctx(void)
{
    if (!g_default_ctx) g_default_ctx = make_ctx(NULL, 1);
    return g_default_ctx;
}

/* Run the next step of SSL_connect/read/write and (re)register a watch on
   the appropriate event when the I/O parks. Returns:
     1  — completed successfully (caller should resolve/free)
     0  — parked, watch (re)registered (caller returns)
    -1  — fatal error (caller should reject/free) */
static int step_ssl_io(TlsWatchEntry *w, int *out_n)
{
    TlsHandle *h = get_handle(w->handle);
    if (!h) return -1;
    int rc;
    int err;
    *out_n = 0;

    switch (w->kind) {
    case TLS_WATCH_HANDSHAKE:
        rc = SSL_connect(h->ssl);
        if (rc == 1) {
            h->handshake_done = 1;
            return 1;
        }
        err = SSL_get_error(h->ssl, rc);
        break;
    case TLS_WATCH_READ:
        rc = SSL_read(h->ssl, w->buf, (int)w->buf_len);
        if (rc > 0) { *out_n = rc; return 1; }
        if (rc == 0) {
            /* Clean shutdown — surface as zero-byte read (EOF). */
            *out_n = 0;
            return 1;
        }
        err = SSL_get_error(h->ssl, rc);
        break;
    case TLS_WATCH_WRITE: {
        size_t remaining = w->buf_len - w->buf_off;
        rc = SSL_write(h->ssl, w->buf + w->buf_off, (int)remaining);
        if (rc > 0) {
            w->buf_off += (size_t)rc;
            if (w->buf_off >= w->buf_len) {
                *out_n = (int)w->buf_len;
                return 1;
            }
            err = SSL_ERROR_WANT_WRITE; /* keep going */
        } else {
            err = SSL_get_error(h->ssl, rc);
        }
        break;
    }
    default:
        return -1;
    }

    if (err == SSL_ERROR_WANT_READ) {
        w->want_pollout = 0;
        return 0;
    }
    if (err == SSL_ERROR_WANT_WRITE) {
        w->want_pollout = 1;
        return 0;
    }
    return -1;
}

JSValue js_node_native_tls_connect(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "tls.connect: fd, hostname required");

    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]) < 0) return JS_EXCEPTION;
    const char *hostname = JS_ToCString(ctx, argv[1]);
    if (!hostname) return JS_EXCEPTION;

    char *ca_pem_owned = NULL;
    int reject_unauthorized = 1;
    if (argc >= 3 && JS_IsObject(argv[2])) {
        JSValue ru = JS_GetPropertyStr(ctx, argv[2], "rejectUnauthorized");
        if (!JS_IsUndefined(ru) && !JS_IsException(ru)) {
            reject_unauthorized = JS_ToBool(ctx, ru) ? 1 : 0;
        }
        JS_FreeValue(ctx, ru);

        JSValue ca = JS_GetPropertyStr(ctx, argv[2], "ca");
        if (JS_IsString(ca)) {
            const char *s = JS_ToCString(ctx, ca);
            if (s) {
                ca_pem_owned = strdup(s);
                JS_FreeCString(ctx, s);
            }
        }
        JS_FreeValue(ctx, ca);
    }

    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, hostname);
        free(ca_pem_owned);
        return JS_EXCEPTION;
    }

    SSL_CTX *cctx;
    int ctx_owned;
    if (ca_pem_owned || !reject_unauthorized) {
        cctx = make_ctx(ca_pem_owned, reject_unauthorized);
        ctx_owned = 1;
    } else {
        cctx = get_default_ctx();
        ctx_owned = 0;
    }
    free(ca_pem_owned);

    if (!cctx) {
        reject_with_openssl(ctx, resolving[1], "SSL_CTX_new failed");
        JS_FreeCString(ctx, hostname);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    SSL *ssl = SSL_new(cctx);
    if (!ssl) {
        if (ctx_owned) SSL_CTX_free(cctx);
        reject_with_openssl(ctx, resolving[1], "SSL_new failed");
        JS_FreeCString(ctx, hostname);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    /* SNI + verify-against-hostname (the latter only matters when
       reject_unauthorized; harmless when off). */
    SSL_set_tlsext_host_name(ssl, hostname);
    if (reject_unauthorized) {
        SSL_set1_host(ssl, hostname);
    }
    SSL_set_fd(ssl, fd);
    SSL_set_connect_state(ssl);
    JS_FreeCString(ctx, hostname);

    int handle = alloc_handle(fd, ssl, cctx, ctx_owned);
    if (handle < 0) {
        SSL_free(ssl);
        if (ctx_owned) SSL_CTX_free(cctx);
        reject_with_message(ctx, resolving[1], "tls handle table full");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    TlsWatchEntry *w = watch_alloc(ctx, handle, TLS_WATCH_HANDSHAKE,
                                   /*want_pollout=*/1,
                                   resolving[0], resolving[1]);
    if (!w) {
        destroy_handle(handle);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }

    /* Try once synchronously. If it parks, the dispatcher picks it up. */
    int n;
    int rc = step_ssl_io(w, &n);
    if (rc == 1) {
        watch_unlink(w);
        resolve_with(ctx, w->resolve, JS_NewInt32(ctx, handle));
        watch_free(w);
    } else if (rc == -1) {
        watch_unlink(w);
        reject_with_openssl(ctx, w->reject, "SSL_connect failed");
        watch_free(w);
        destroy_handle(handle);
    }
    return promise;
}

JSValue js_node_native_tls_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "tls.read: handle required");
    int32_t handle, n = 16384;
    if (JS_ToInt32(ctx, &handle, argv[0]) < 0) return JS_EXCEPTION;
    if (argc >= 2 && JS_ToInt32(ctx, &n, argv[1]) < 0) return JS_EXCEPTION;
    if (n <= 0) n = 16384;

    TlsHandle *h = get_handle(handle);
    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) return JS_EXCEPTION;
    if (!h) {
        reject_with_message(ctx, resolving[1], "tls.read: invalid handle");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    uint8_t *buf = malloc((size_t)n);
    if (!buf) {
        reject_with_message(ctx, resolving[1], "ENOMEM");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    TlsWatchEntry *w = watch_alloc(ctx, handle, TLS_WATCH_READ,
                                   /*want_pollout=*/0,
                                   resolving[0], resolving[1]);
    if (!w) {
        free(buf);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    w->buf = buf;
    w->buf_len = (size_t)n;

    int got;
    int rc = step_ssl_io(w, &got);
    if (rc == 1) {
        JSValue ab = JS_NewArrayBufferCopy(ctx, w->buf, (size_t)got);
        watch_unlink(w);
        resolve_with(ctx, w->resolve, ab);
        watch_free(w);
    } else if (rc == -1) {
        watch_unlink(w);
        reject_with_openssl(ctx, w->reject, "SSL_read failed");
        watch_free(w);
    }
    return promise;
}

JSValue js_node_native_tls_write(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "tls.write: handle, buf required");
    int32_t handle;
    if (JS_ToInt32(ctx, &handle, argv[0]) < 0) return JS_EXCEPTION;

    size_t len = 0;
    uint8_t *src = JS_GetUint8Array(ctx, &len, argv[1]);
    if (!src)
        return JS_ThrowTypeError(ctx, "tls.write: buf must be Uint8Array");

    TlsHandle *h = get_handle(handle);
    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) return JS_EXCEPTION;
    if (!h) {
        reject_with_message(ctx, resolving[1], "tls.write: invalid handle");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    if (len == 0) {
        resolve_with(ctx, resolving[0], JS_NewInt32(ctx, 0));
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    /* SSL_write may need to retry on a memory-stable buffer (per OpenSSL
       MOVING_WRITE_BUFFER semantics) — copy. */
    uint8_t *copy = malloc(len);
    if (!copy) {
        reject_with_message(ctx, resolving[1], "ENOMEM");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    memcpy(copy, src, len);

    TlsWatchEntry *w = watch_alloc(ctx, handle, TLS_WATCH_WRITE,
                                   /*want_pollout=*/1,
                                   resolving[0], resolving[1]);
    if (!w) {
        free(copy);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    w->buf = copy;
    w->buf_len = len;
    w->buf_off = 0;

    int n;
    int rc = step_ssl_io(w, &n);
    if (rc == 1) {
        watch_unlink(w);
        resolve_with(ctx, w->resolve, JS_NewInt32(ctx, n));
        watch_free(w);
    } else if (rc == -1) {
        watch_unlink(w);
        reject_with_openssl(ctx, w->reject, "SSL_write failed");
        watch_free(w);
    }
    return promise;
}

JSValue js_node_native_tls_close(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "tls.close: handle required");
    int32_t handle;
    if (JS_ToInt32(ctx, &handle, argv[0]) < 0) return JS_EXCEPTION;

    /* Reject every watch on this handle before freeing the SSL state. */
    TlsWatchEntry **pp = &g_watches;
    while (*pp) {
        TlsWatchEntry *w = *pp;
        if (w->handle == handle) {
            *pp = w->next;
            reject_with_message(w->ctx, w->reject, "tls socket closed");
            watch_free(w);
        } else {
            pp = &w->next;
        }
    }
    destroy_handle(handle);
    return JS_UNDEFINED;
}

int js_node_tls_has_watches(void)
{
    return g_watches != NULL;
}

int js_node_tls_dispatch(JSContext *ctx)
{
    int n = 0;
    for (TlsWatchEntry *w = g_watches; w; w = w->next) n++;
    if (n == 0) return 0;

    struct pollfd *pfds = malloc(sizeof(struct pollfd) * (size_t)n);
    if (!pfds) return 0;

    int i = 0;
    for (TlsWatchEntry *w = g_watches; w; w = w->next, i++) {
        TlsHandle *h = get_handle(w->handle);
        pfds[i].fd = h ? h->fd : -1;
        pfds[i].events = w->want_pollout ? POLLOUT : POLLIN;
        pfds[i].revents = 0;
    }

    int prc = poll(pfds, (nfds_t)n, 0);
    if (prc <= 0) {
        free(pfds);
        return 0;
    }

    int processed = 0;
    TlsWatchEntry *w = g_watches;
    int idx = 0;
    while (w && idx < n) {
        TlsWatchEntry *next = w->next;
        short re = pfds[idx].revents;
        idx++;
        if (re == 0) { w = next; continue; }

        int got;
        int rc = step_ssl_io(w, &got);
        if (rc == 1) {
            JSValue arg;
            if (w->kind == TLS_WATCH_HANDSHAKE) {
                arg = JS_NewInt32(ctx, w->handle);
            } else if (w->kind == TLS_WATCH_READ) {
                arg = JS_NewArrayBufferCopy(ctx, w->buf, (size_t)got);
            } else {
                arg = JS_NewInt32(ctx, got);
            }
            watch_unlink(w);
            resolve_with(ctx, w->resolve, arg);
            watch_free(w);
            processed++;
        } else if (rc == -1) {
            int handle = w->handle;
            TlsWatchKind kind = w->kind;
            watch_unlink(w);
            reject_with_openssl(ctx, w->reject,
                kind == TLS_WATCH_HANDSHAKE ? "SSL_connect failed" :
                kind == TLS_WATCH_READ      ? "SSL_read failed" :
                                              "SSL_write failed");
            watch_free(w);
            if (kind == TLS_WATCH_HANDSHAKE) destroy_handle(handle);
            processed++;
        }
        w = next;
    }

    free(pfds);
    return processed;
}
