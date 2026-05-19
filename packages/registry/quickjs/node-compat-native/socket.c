#include "socket.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>

typedef enum {
    WATCH_CONNECT = 1, /* wait for write-ready, then check SO_ERROR */
    WATCH_READ    = 2, /* wait for read-ready, then read into buf */
    WATCH_WRITE   = 3, /* wait for write-ready, drain buf */
} WatchKind;

typedef struct WatchEntry {
    int fd;
    WatchKind kind;
    JSContext *ctx;
    JSValue resolve;
    JSValue reject;
    /* WATCH_READ: out buffer, capacity in buf_len.
       WATCH_WRITE: source buffer, total in buf_len, progress in buf_off. */
    uint8_t *buf;
    size_t   buf_len;
    size_t   buf_off;
    struct WatchEntry *next;
} WatchEntry;

static WatchEntry *g_watches = NULL;

static void watch_free(WatchEntry *w)
{
    JS_FreeValue(w->ctx, w->resolve);
    JS_FreeValue(w->ctx, w->reject);
    free(w->buf);
    free(w);
}

static WatchEntry *watch_alloc(JSContext *ctx, int fd, WatchKind kind,
                               JSValue resolve, JSValue reject)
{
    WatchEntry *w = calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->fd = fd;
    w->kind = kind;
    w->ctx = ctx;
    w->resolve = resolve;
    w->reject = reject;
    w->next = g_watches;
    g_watches = w;
    return w;
}

static void watch_unlink(WatchEntry *target)
{
    WatchEntry **pp = &g_watches;
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

static void reject_with_errno(JSContext *ctx, JSValueConst fn, int err,
                              const char *fallback)
{
    const char *msg = err ? strerror(err) : fallback;
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message",
                              JS_NewString(ctx, msg ? msg : "error"),
                              JS_PROP_C_W_E);
    if (err) {
        JS_DefinePropertyValueStr(ctx, e, "errno",
                                  JS_NewInt32(ctx, err), JS_PROP_C_W_E);
    }
    JSValueConst args[1] = { (JSValueConst)e };
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 1, args);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, e);
}

static int set_nonblock(int fd)
{
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static int resolve_host(const char *host, struct in_addr *out)
{
    /* Numeric path first — avoids a DNS round-trip for "127.0.0.1" etc. */
    if (inet_aton(host, out)) return 0;

    struct addrinfo hints = {0};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(host, NULL, &hints, &res);
    if (rc != 0 || !res) {
        if (res) freeaddrinfo(res);
        return -1;
    }
    *out = ((struct sockaddr_in *)res->ai_addr)->sin_addr;
    freeaddrinfo(res);
    return 0;
}

JSValue js_node_native_socket_connect(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "socket.connect: host, port required");

    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host) return JS_EXCEPTION;
    int32_t port_i32;
    if (JS_ToInt32(ctx, &port_i32, argv[1]) < 0 ||
        port_i32 < 0 || port_i32 > 65535) {
        JS_FreeCString(ctx, host);
        return JS_ThrowRangeError(ctx, "socket.connect: invalid port");
    }

    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, host);
        return JS_EXCEPTION;
    }

    struct in_addr ip;
    int dns_rc = resolve_host(host, &ip);
    JS_FreeCString(ctx, host);
    if (dns_rc < 0) {
        reject_with_errno(ctx, resolving[1], 0, "ENOTFOUND");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        reject_with_errno(ctx, resolving[1], errno, NULL);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    set_nonblock(fd);

    struct sockaddr_in sa = {0};
    sa.sin_family = AF_INET;
    sa.sin_port   = htons((uint16_t)port_i32);
    sa.sin_addr   = ip;

    int cr = connect(fd, (struct sockaddr *)&sa, sizeof(sa));
    if (cr == 0) {
        resolve_with(ctx, resolving[0], JS_NewInt32(ctx, fd));
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    if (errno != EINPROGRESS && errno != EAGAIN && errno != EALREADY) {
        int e = errno;
        close(fd);
        reject_with_errno(ctx, resolving[1], e, NULL);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    WatchEntry *w = watch_alloc(ctx, fd, WATCH_CONNECT, resolving[0], resolving[1]);
    if (!w) {
        close(fd);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    return promise;
}

JSValue js_node_native_socket_read(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "socket.read: fd required");
    int32_t fd, n = 16384;
    if (JS_ToInt32(ctx, &fd, argv[0]) < 0) return JS_EXCEPTION;
    if (argc >= 2 && JS_ToInt32(ctx, &n, argv[1]) < 0) return JS_EXCEPTION;
    if (n <= 0) n = 16384;

    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) return JS_EXCEPTION;

    uint8_t *buf = malloc((size_t)n);
    if (!buf) {
        reject_with_errno(ctx, resolving[1], 0, "ENOMEM");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    ssize_t r = read(fd, buf, (size_t)n);
    if (r >= 0) {
        JSValue ab = JS_NewArrayBufferCopy(ctx, buf, (size_t)r);
        free(buf);
        resolve_with(ctx, resolving[0], ab);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
        int e = errno;
        free(buf);
        reject_with_errno(ctx, resolving[1], e, NULL);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    WatchEntry *w = watch_alloc(ctx, fd, WATCH_READ, resolving[0], resolving[1]);
    if (!w) {
        free(buf);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    w->buf = buf;
    w->buf_len = (size_t)n;
    return promise;
}

JSValue js_node_native_socket_write(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "socket.write: fd, buf required");
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]) < 0) return JS_EXCEPTION;

    size_t len = 0;
    uint8_t *src = JS_GetUint8Array(ctx, &len, argv[1]);
    if (!src)
        return JS_ThrowTypeError(ctx, "socket.write: buf must be Uint8Array");

    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) return JS_EXCEPTION;

    if (len == 0) {
        resolve_with(ctx, resolving[0], JS_NewInt32(ctx, 0));
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    ssize_t wr = write(fd, src, len);
    if (wr >= 0 && (size_t)wr == len) {
        resolve_with(ctx, resolving[0], JS_NewInt32(ctx, (int32_t)wr));
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    if (wr < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        int e = errno;
        reject_with_errno(ctx, resolving[1], e, NULL);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }

    /* Partial write or full EAGAIN: copy remaining bytes, register a watch.
       The JS source buffer can be GC'd between now and the next dispatch. */
    size_t off = (wr > 0) ? (size_t)wr : 0;
    uint8_t *copy = malloc(len);
    if (!copy) {
        reject_with_errno(ctx, resolving[1], 0, "ENOMEM");
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return promise;
    }
    memcpy(copy, src, len);
    WatchEntry *w = watch_alloc(ctx, fd, WATCH_WRITE, resolving[0], resolving[1]);
    if (!w) {
        free(copy);
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    w->buf = copy;
    w->buf_len = len;
    w->buf_off = off;
    return promise;
}

JSValue js_node_native_socket_close(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "socket.close: fd required");
    int32_t fd;
    if (JS_ToInt32(ctx, &fd, argv[0]) < 0) return JS_EXCEPTION;

    /* Reject every pending promise on this fd, then actually close. */
    WatchEntry **pp = &g_watches;
    while (*pp) {
        WatchEntry *w = *pp;
        if (w->fd == fd) {
            *pp = w->next;
            reject_with_errno(w->ctx, w->reject, 0, "socket closed");
            watch_free(w);
        } else {
            pp = &w->next;
        }
    }
    if (fd >= 0) close(fd);
    return JS_UNDEFINED;
}

int js_node_socket_has_watches(void)
{
    return g_watches != NULL;
}

int js_node_socket_dispatch(JSContext *ctx)
{
    int n = 0;
    for (WatchEntry *w = g_watches; w; w = w->next) n++;
    if (n == 0) return 0;

    struct pollfd *pfds = malloc(sizeof(struct pollfd) * (size_t)n);
    if (!pfds) return 0;

    int i = 0;
    for (WatchEntry *w = g_watches; w; w = w->next, i++) {
        pfds[i].fd = w->fd;
        pfds[i].events = (w->kind == WATCH_READ) ? POLLIN : POLLOUT;
        pfds[i].revents = 0;
    }

    /* Non-blocking poll. Centralized-mode poll() with timeout > 0 returns
       EAGAIN, so we tick the loop instead of trying to block in-kernel. */
    int prc = poll(pfds, (nfds_t)n, 0);
    if (prc <= 0) {
        free(pfds);
        return 0;
    }

    int processed = 0;
    WatchEntry *w = g_watches;
    int idx = 0;
    while (w && idx < n) {
        WatchEntry *next = w->next;
        short re = pfds[idx].revents;
        idx++;

        if (re == 0) { w = next; continue; }

        switch (w->kind) {
        case WATCH_CONNECT: {
            int err = 0;
            socklen_t elen = sizeof(err);
            if (getsockopt(w->fd, SOL_SOCKET, SO_ERROR, &err, &elen) == 0 && err == 0) {
                watch_unlink(w);
                resolve_with(ctx, w->resolve, JS_NewInt32(ctx, w->fd));
                watch_free(w);
            } else {
                int e = err ? err : ECONNREFUSED;
                watch_unlink(w);
                reject_with_errno(ctx, w->reject, e, NULL);
                watch_free(w);
            }
            processed++;
            break;
        }
        case WATCH_READ: {
            ssize_t r = read(w->fd, w->buf, w->buf_len);
            if (r >= 0) {
                JSValue ab = JS_NewArrayBufferCopy(ctx, w->buf, (size_t)r);
                watch_unlink(w);
                resolve_with(ctx, w->resolve, ab);
                watch_free(w);
                processed++;
            } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
                int e = errno;
                watch_unlink(w);
                reject_with_errno(ctx, w->reject, e, NULL);
                watch_free(w);
                processed++;
            }
            /* else: spurious wake-up, leave registered */
            break;
        }
        case WATCH_WRITE: {
            ssize_t r = write(w->fd, w->buf + w->buf_off, w->buf_len - w->buf_off);
            if (r > 0) {
                w->buf_off += (size_t)r;
                if (w->buf_off >= w->buf_len) {
                    watch_unlink(w);
                    resolve_with(ctx, w->resolve, JS_NewInt32(ctx, (int32_t)w->buf_len));
                    watch_free(w);
                    processed++;
                }
            } else if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
                int e = errno;
                watch_unlink(w);
                reject_with_errno(ctx, w->reject, e, NULL);
                watch_free(w);
                processed++;
            }
            break;
        }
        }
        w = next;
    }

    free(pfds);
    return processed;
}
