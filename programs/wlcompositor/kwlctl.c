/*
 * kwlctl — the hyprctl analog: a tiny CLI + event tail over the compositor's
 * /tmp/kwlctl-0 control socket (PR14c). It speaks the newline-delimited line
 * protocol wlcompositor's kwlctl IPC serves:
 *
 *   kwlctl clients | workspaces | activewindow   -> print the JSON reply
 *   kwlctl dispatch <op ...>                      -> workspace N, movetoworkspace
 *                                                    N, close, exec <prog ...>
 *   kwlctl --listen                               -> stream `event>>data` lines
 *                                                    until the compositor exits
 *
 * The whole conversation is one command line written to the socket followed by
 * the server's reply; for --listen the server holds the connection open and
 * pushes events. This is the control surface Omarchy's scripts and the Tier-1
 * bar (PR15) consume. No fork here, so it is not fork-instrumented.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define KWLCTL_SOCKET_PATH "/tmp/kwlctl-0"

static int connect_kwlctl(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWLCTL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    /* The compositor may still be coming up; retry briefly like a wl client. */
    for (int i = 0; i < 200; i++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) return fd;
        usleep(10000);
    }
    perror("connect");
    close(fd);
    return -1;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: kwlctl <clients|workspaces|activewindow|"
                        "dispatch ...|--listen>\n");
        return 2;
    }

    int fd = connect_kwlctl();
    if (fd < 0) return 1;

    /* Re-join argv[1..] into one space-separated command line. */
    char cmd[1024];
    int n = 0;
    for (int i = 1; i < argc && n < (int)sizeof(cmd) - 2; i++)
        n += snprintf(cmd + n, sizeof(cmd) - n, "%s%s", i > 1 ? " " : "",
                      argv[i]);
    cmd[n++] = '\n';
    if (write(fd, cmd, (size_t)n) != n) { perror("write"); close(fd); return 1; }

    /* Print the reply. A request/reply command's socket is closed by the
     * server after the reply (read hits EOF); --listen streams until the
     * compositor exits. Either way, drain to EOF. */
    char buf[4096];
    ssize_t r;
    while ((r = read(fd, buf, sizeof(buf))) > 0) {
        fwrite(buf, 1, (size_t)r, stdout);
        fflush(stdout);
    }
    close(fd);
    return 0;
}
