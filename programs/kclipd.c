/*
 * kclipd — the guest half of host clipboard paste.
 *
 * The host offers clipboard text through /dev/kandelo/clipboard (one record
 * per offer: struct kandelo_clipboard_record, then UTF-8 text). kclipd reads
 * each offer and makes it the desktop's Wayland selection through
 * ext_data_control_v1, the protocol clipboard tools use: it needs no window
 * and no keyboard focus, and it keeps working when a real Hyprland replaces
 * wlcompositor. Once the compositor has installed the selection, kclipd
 * writes an acknowledgement (status 0, or a negative errno) back to the
 * device, which is what the host waits for before it delivers the user's
 * paste chord.
 *
 * In the other direction (copy-out), when anything else on the desktop sets
 * the selection, kclipd reads it as text and writes it to the device as a
 * KANDELO_CLIPBOARD_KIND_GUEST_TEXT record, which the host reads after the
 * user's copy gesture and puts on the host clipboard.
 *
 * kclipd owns the selection until something else replaces it; it serves
 * every paste (ext_data_control_source_v1.send) by writing the text into the
 * pipe the pasting client passed, without blocking its event loop, so a
 * slow reader or a large paste cannot stall the next offer.
 *
 * It never prints clipboard text: its log carries sequence numbers and
 * lengths only. Failures are loud: a missing device or protocol logs the
 * cause and exits non-zero, which the browser reports as "clipboard agent is
 * not running" on the next paste.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <kandelo/clipboard.h>
#include <wayland-client.h>
#include "ext-data-control-v1-client-protocol.h"

static const char *const MIMES[] = {
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "TEXT",
};
#define N_MIMES (sizeof(MIMES) / sizeof(MIMES[0]))
#define MAX_WRITERS 16

/* Clipboard text, shared by the source that offers it and every paste
 * still being written from it. */
struct text {
    int refs;
    size_t len;
    char bytes[];
};

struct source {
    struct ext_data_control_source_v1 *resource;
    struct text *text;
    int cancelled;
};

/* One paste in flight: the rest of `text` still to write into `fd`. */
struct writer {
    int fd;
    struct text *text;
    size_t off;
};

static struct {
    struct wl_display *display;
    struct wl_seat *seat;
    struct ext_data_control_manager_v1 *manager;
    struct ext_data_control_device_v1 *device;
    int finished;
    struct writer writers[MAX_WRITERS];
    int n_writers;
    /* kclipd's selection while it holds it. The compositor cancels this
     * source before it announces any replacement, so a selection event that
     * arrives while it is set is the echo of kclipd's own set_selection —
     * host text, not a guest copy to report back to the host. */
    struct source *owned;
    /* Copy-out: the desktop selection being read, if any. */
    int reader_fd;
    char *reader_buf;
    size_t reader_len;
} k = { .reader_fd = -1 };

static void text_unref(struct text *t) {
    if (t && --t->refs == 0) free(t);
}

static void writer_close(int i) {
    close(k.writers[i].fd);
    text_unref(k.writers[i].text);
    k.writers[i] = k.writers[--k.n_writers];
}

/* Write as much as the pipe takes now; returns 1 when the paste is done. */
static int writer_pump(struct writer *w) {
    while (w->off < w->text->len) {
        ssize_t n = write(w->fd, w->text->bytes + w->off, w->text->len - w->off);
        if (n > 0) { w->off += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) return 0;
        return 1;   /* EPIPE: the reader went away; nothing more to do */
    }
    return 1;
}

/* ---- ext_data_control_source_v1 ---------------------------------------- */

static void source_send(void *data, struct ext_data_control_source_v1 *s,
                        const char *mime, int32_t fd) {
    struct source *src = data;
    if (k.n_writers == MAX_WRITERS) {
        fprintf(stderr, "kclipd: too many pastes in flight; dropping one\n");
        close(fd);
        return;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    struct writer w = { .fd = fd, .text = src->text, .off = 0 };
    src->text->refs++;
    if (writer_pump(&w)) {
        close(w.fd);
        text_unref(w.text);
        return;
    }
    k.writers[k.n_writers++] = w;
}

static void source_cancelled(void *data, struct ext_data_control_source_v1 *s) {
    struct source *src = data;
    src->cancelled = 1;
    if (k.owned == src) k.owned = NULL;
    ext_data_control_source_v1_destroy(s);
    text_unref(src->text);
    free(src);
}

static const struct ext_data_control_source_v1_listener source_listener = {
    .send = source_send,
    .cancelled = source_cancelled,
};

/* ---- ext_data_control_device_v1 ---------------------------------------- */

/* The text types kclipd can read back for copy-out, best first. */
struct offer_mimes {
    int utf8, plain, utf8_string;
};
static void offer_offer(void *data, struct ext_data_control_offer_v1 *o,
                        const char *mime) {
    struct offer_mimes *m = data;
    if (!strcmp(mime, "text/plain;charset=utf-8")) m->utf8 = 1;
    else if (!strcmp(mime, "text/plain")) m->plain = 1;
    else if (!strcmp(mime, "UTF8_STRING")) m->utf8_string = 1;
}
static const struct ext_data_control_offer_v1_listener offer_listener = {
    .offer = offer_offer,
};
static void device_data_offer(void *data, struct ext_data_control_device_v1 *d,
                              struct ext_data_control_offer_v1 *offer) {
    ext_data_control_offer_v1_add_listener(offer, &offer_listener,
                                           calloc(1, sizeof(struct offer_mimes)));
}

static void reader_abandon(void) {
    if (k.reader_fd >= 0) close(k.reader_fd);
    free(k.reader_buf);
    k.reader_fd = -1;
    k.reader_buf = NULL;
    k.reader_len = 0;
}

/* Copy-out: someone else set the selection. Read it as text through a pipe
 * (non-blocking, from the main loop); a newer selection replaces a read in
 * progress. */
static void device_selection(void *data, struct ext_data_control_device_v1 *d,
                             struct ext_data_control_offer_v1 *offer) {
    if (k.owned) {
        if (offer) {
            free(ext_data_control_offer_v1_get_user_data(offer));
            ext_data_control_offer_v1_destroy(offer);
        }
        return;
    }
    if (!offer) return;
    struct offer_mimes *m = ext_data_control_offer_v1_get_user_data(offer);
    const char *mime = m->utf8 ? "text/plain;charset=utf-8"
                     : m->plain ? "text/plain"
                     : m->utf8_string ? "UTF8_STRING" : NULL;
    free(m);
    if (mime) {
        int fds[2];
        if (pipe(fds) == 0) {
            reader_abandon();
            fcntl(fds[0], F_SETFD, FD_CLOEXEC);
            fcntl(fds[1], F_SETFD, FD_CLOEXEC);
            fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK);
            ext_data_control_offer_v1_receive(offer, mime, fds[1]);
            close(fds[1]);
            k.reader_fd = fds[0];
        } else {
            fprintf(stderr, "kclipd: pipe for copy-out: %s\n", strerror(errno));
        }
    }
    ext_data_control_offer_v1_destroy(offer);
}

/* Read what the pipe has; at EOF, report the whole text to the device. */
static void reader_pump(int dev) {
    for (;;) {
        char chunk[16384];
        ssize_t n = read(k.reader_fd, chunk, sizeof(chunk));
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) return;
        if (n < 0) {
            fprintf(stderr, "kclipd: reading the selection: %s\n", strerror(errno));
            reader_abandon();
            return;
        }
        if (n == 0) break;
        if (k.reader_len + (size_t)n > KANDELO_CLIPBOARD_MAX_TEXT_BYTES) {
            /* Never a truncated copy: the host clipboard keeps what it had. */
            fprintf(stderr, "kclipd: selection over %d bytes; not copied out\n",
                    KANDELO_CLIPBOARD_MAX_TEXT_BYTES);
            reader_abandon();
            return;
        }
        char *grown = realloc(k.reader_buf, k.reader_len + (size_t)n);
        if (!grown) { reader_abandon(); return; }
        k.reader_buf = grown;
        memcpy(k.reader_buf + k.reader_len, chunk, (size_t)n);
        k.reader_len += (size_t)n;
    }
    size_t total = sizeof(struct kandelo_clipboard_record) + k.reader_len;
    char *rec = malloc(total);
    if (rec) {
        struct kandelo_clipboard_record h = {
            .version = KANDELO_CLIPBOARD_RECORD_VERSION,
            .kind = KANDELO_CLIPBOARD_KIND_GUEST_TEXT,
            .seq = 0,
            .len = (uint32_t)k.reader_len,
        };
        memcpy(rec, &h, sizeof(h));
        if (k.reader_len) memcpy(rec + sizeof(h), k.reader_buf, k.reader_len);
        if (write(dev, rec, total) == (ssize_t)total) {
            printf("KCLIPD_COPIED len=%zu\n", k.reader_len);
            fflush(stdout);
        } else {
            /* Not UTF-8, or the device refused it: say so, copy nothing. */
            fprintf(stderr, "kclipd: reporting the selection: %s\n", strerror(errno));
        }
        free(rec);
    }
    reader_abandon();
}

static void device_finished(void *data, struct ext_data_control_device_v1 *d) {
    k.finished = 1;
}
static void device_primary_selection(void *data,
                                     struct ext_data_control_device_v1 *d,
                                     struct ext_data_control_offer_v1 *offer) {
    if (offer) {
        free(ext_data_control_offer_v1_get_user_data(offer));
        ext_data_control_offer_v1_destroy(offer);
    }
}
static const struct ext_data_control_device_v1_listener device_listener = {
    .data_offer = device_data_offer,
    .selection = device_selection,
    .finished = device_finished,
    .primary_selection = device_primary_selection,
};

/* ---- registry ---------------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    if (!strcmp(iface, "wl_seat") && !k.seat)
        k.seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (!strcmp(iface, "ext_data_control_manager_v1"))
        k.manager = wl_registry_bind(reg, name,
                                     &ext_data_control_manager_v1_interface, 1);
}
static void registry_global_remove(void *data, struct wl_registry *r,
                                   uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

/* ---- the device -------------------------------------------------------- */

/* read() exactly `len` bytes of the current record. The device returns at
 * most one record per read and streams a record through short buffers, so
 * a short count only means "keep reading". */
static int read_exact(int fd, void *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = read(fd, (char *)buf + got, len - got);
        if (n > 0) { got += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        return n < 0 ? -errno : -EIO;
    }
    return 0;
}

static void ack(int dev, uint32_t seq, int32_t status) {
    struct kandelo_clipboard_ack a = { .seq = seq, .status = status };
    if (write(dev, &a, sizeof(a)) != (ssize_t)sizeof(a))
        fprintf(stderr, "kclipd: acknowledging offer %u: %s\n", seq,
                strerror(errno));
}

/* Read one offer and make it the selection. Returns -1 when the device
 * failed in a way kclipd cannot recover from. */
static int handle_offer(int dev) {
    struct kandelo_clipboard_record rec;
    int err = read_exact(dev, &rec, sizeof(rec));
    if (err == -EAGAIN) return 0;   /* woken without a record */
    if (err < 0) {
        fprintf(stderr, "kclipd: reading %s: %s\n",
                KANDELO_CLIPBOARD_DEVICE_PATH, strerror(-err));
        return -1;
    }
    if (rec.version != KANDELO_CLIPBOARD_RECORD_VERSION ||
        rec.kind != KANDELO_CLIPBOARD_KIND_OFFER_TEXT ||
        rec.len > KANDELO_CLIPBOARD_MAX_TEXT_BYTES) {
        fprintf(stderr, "kclipd: unsupported record (version %u kind %u)\n",
                rec.version, rec.kind);
        return -1;   /* the stream position is unknown from here */
    }
    struct text *t = malloc(sizeof(*t) + rec.len);
    if (!t) {
        /* Still consume the payload so the next record starts in place. */
        char sink[4096];
        for (uint32_t left = rec.len; left > 0;) {
            uint32_t n = left < sizeof(sink) ? left : (uint32_t)sizeof(sink);
            if (read_exact(dev, sink, n) < 0) return -1;
            left -= n;
        }
        ack(dev, rec.seq, -ENOMEM);
        return 0;
    }
    t->refs = 1;
    t->len = rec.len;
    if (read_exact(dev, t->bytes, rec.len) < 0) {
        free(t);
        return -1;
    }

    struct source *src = calloc(1, sizeof(*src));
    if (!src) {
        free(t);
        ack(dev, rec.seq, -ENOMEM);
        return 0;
    }
    src->text = t;
    src->resource = ext_data_control_manager_v1_create_data_source(k.manager);
    ext_data_control_source_v1_add_listener(src->resource, &source_listener, src);
    for (size_t i = 0; i < N_MIMES; i++)
        ext_data_control_source_v1_offer(src->resource, MIMES[i]);
    k.owned = src;
    ext_data_control_device_v1_set_selection(k.device, src->resource);
    /* After the roundtrip the compositor has processed set_selection; a
     * source it rejected or that something replaced at once is cancelled. */
    if (wl_display_roundtrip(k.display) < 0) {
        fprintf(stderr, "kclipd: lost the compositor connection\n");
        return -1;
    }
    /* `src` may have been freed by `cancelled`; only `rec` is used below. */
    printf("KCLIPD_OFFER seq=%u len=%u\n", rec.seq, rec.len);
    fflush(stdout);
    ack(dev, rec.seq, 0);
    return 0;
}

int main(void) {
    /* A pasting client may close its end before reading everything (a
     * cancelled paste). That must fail the one write with EPIPE, not kill
     * the agent and every later paste with it. */
    signal(SIGPIPE, SIG_IGN);
    int dev = open(KANDELO_CLIPBOARD_DEVICE_PATH, O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (dev < 0) {
        fprintf(stderr, "kclipd: open %s: %s\n", KANDELO_CLIPBOARD_DEVICE_PATH,
                strerror(errno));
        return 1;
    }
    k.display = wl_display_connect(NULL);
    if (!k.display) {
        fprintf(stderr, "kclipd: cannot connect to the Wayland compositor\n");
        return 1;
    }
    struct wl_registry *registry = wl_display_get_registry(k.display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(k.display);
    if (!k.seat || !k.manager) {
        fprintf(stderr, "kclipd: compositor offers no %s\n",
                k.seat ? "ext_data_control_manager_v1" : "wl_seat");
        return 1;
    }
    k.device = ext_data_control_manager_v1_get_data_device(k.manager, k.seat);
    ext_data_control_device_v1_add_listener(k.device, &device_listener, NULL);
    wl_display_roundtrip(k.display);
    printf("KCLIPD_READY\n");
    fflush(stdout);

    int wl_fd = wl_display_get_fd(k.display);
    while (!k.finished) {
        while (wl_display_prepare_read(k.display) != 0)
            wl_display_dispatch_pending(k.display);
        wl_display_flush(k.display);

        /* dev, the compositor, the copy-out reader (-1 = none, which poll
         * skips), then one entry per paste being written. */
        struct pollfd fds[3 + MAX_WRITERS];
        fds[0] = (struct pollfd){ .fd = dev, .events = POLLIN };
        fds[1] = (struct pollfd){ .fd = wl_fd, .events = POLLIN };
        fds[2] = (struct pollfd){ .fd = k.reader_fd, .events = POLLIN };
        for (int i = 0; i < k.n_writers; i++)
            fds[3 + i] = (struct pollfd){ .fd = k.writers[i].fd, .events = POLLOUT };
        int nw = k.n_writers;
        int reader = k.reader_fd;
        if (poll(fds, (nfds_t)(3 + nw), -1) < 0) {
            wl_display_cancel_read(k.display);
            if (errno == EINTR) continue;
            fprintf(stderr, "kclipd: poll: %s\n", strerror(errno));
            return 1;
        }
        if (fds[1].revents & (POLLIN | POLLERR | POLLHUP)) {
            if (wl_display_read_events(k.display) < 0) {
                fprintf(stderr, "kclipd: lost the compositor connection\n");
                return 1;
            }
        } else {
            wl_display_cancel_read(k.display);
        }
        if (wl_display_dispatch_pending(k.display) < 0) {
            fprintf(stderr, "kclipd: lost the compositor connection\n");
            return 1;
        }
        /* Pump pastes from the end so writer_close's swap stays valid. */
        for (int i = nw - 1; i >= 0; i--)
            if (fds[3 + i].revents && writer_pump(&k.writers[i]))
                writer_close(i);
        /* Only if the reader polled is still the current one: a selection
         * dispatched above may have replaced it. */
        if (reader >= 0 && reader == k.reader_fd && fds[2].revents)
            reader_pump(dev);
        if ((fds[0].revents & POLLIN) && handle_offer(dev) < 0) return 1;
    }
    fprintf(stderr, "kclipd: the compositor withdrew the data-control device\n");
    return 1;
}
