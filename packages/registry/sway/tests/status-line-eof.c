/* Native regression scaffolding for the actual upstream status reader.
 * The driver inserts that source unchanged, after package patches. Only its
 * unused JSON/Wayland branches are stubbed; the text/stdio path is real. */
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <unistd.h>

enum { PROTOCOL_UNDEF, PROTOCOL_TEXT, PROTOCOL_I3BAR, PROTOCOL_ERROR };
struct wl_list { int unused; };
typedef struct { int unused; } json_object;
struct swaybar { void *eventloop; };
struct status_line {
    struct swaybar *bar;
    int read_fd, write_fd, protocol, stop_signal, cont_signal;
    bool click_events, float_event_coords;
    size_t buffer_size, buffer_index;
    char *buffer;
    const char *text;
    FILE *read;
    struct wl_list blocks;
    void *tokener;
};
#define sway_log(...) ((void)0)
#define sway_log_errno(...) ((void)0)
#define loop_remove_fd(...) ((void)0)
#define wl_list_init(...) ((void)0)
#define json_tokener_parse(...) ((json_object *)0)
#define json_object_object_get_ex(...) 0
#define json_object_get_int(...) 0
#define json_object_get_boolean(...) 0
#define json_object_put(...) ((void)0)
#define json_tokener_new(...) ((void *)0)
#define i3bar_handle_readable(...) false

/* UPSTREAM_STATUS_READER */

static void timed_out(int signal_number) {
    (void)signal_number;
    const char message[] = "FAIL: status reader did not return at EOF\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(1);
}

static int check_stream(bool empty_command) {
    int descriptors[2];
    if (pipe(descriptors) != 0 || fcntl(descriptors[0], F_SETFL, O_NONBLOCK) != 0) return 2;
    FILE *reader = fdopen(descriptors[0], "r");
    if (!reader) return 2;
    struct swaybar bar = {0};
    /* Keep a prefix inside the allocation so the old reader's negative
     * index at EOF is in allocated storage; the timeout judges its loop. */
    char *allocation = calloc(1, 8192 + 32);
    if (!allocation) return 2;
    struct status_line status = {
        .bar = &bar, .read_fd = descriptors[0], .write_fd = -1,
        .protocol = empty_command ? PROTOCOL_UNDEF : PROTOCOL_TEXT,
        .buffer = allocation + 16,
        .buffer_size = 8192, .read = reader,
    };
    alarm(2);
    if (!empty_command) {
        if (write(descriptors[1], "ready\n", 6) != 6) return 2;
        if (!status_handle_readable(&status) || status.protocol != PROTOCOL_TEXT) return 3;
    }
    /* Nonblocking EAGAIN above must preserve the live stream. Closing the
     * writer now produces genuine stdio EOF, with no Kandelo involved. */
    if (close(descriptors[1]) != 0) return 2;
    if (!status_handle_readable(&status) || status.protocol != PROTOCOL_ERROR) return 4;
    alarm(0);
    /* status_error closes the fd; fclose still releases stdio's allocation. */
    (void)fclose(reader);
    free(allocation);
    return 0;
}

int main(void) {
    signal(SIGALRM, timed_out);
    int result = check_stream(false);
    if (result == 0) result = check_stream(true);
    if (result == 0) puts("status reader: EAGAIN stays live; text and empty EOF return without spinning");
    return result;
}
