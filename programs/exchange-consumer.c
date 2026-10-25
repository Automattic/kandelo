/* A minimal Kandelo exchange consumer, for host/test/exchange-node.test.ts.
 *
 * It holds /run/kandelo/exchange/events, takes one batch, and for each input
 * publishes an uppercased copy through a work session, linked to the input
 * by user.kandelo.derived_from: a regular file (a host Blob) as a stored
 * output, a FIFO (a host stream) as a streamed output. It then marks the
 * batch done and removes it, which settles it on the host. Everything goes through ordinary
 * POSIX calls; the markers it prints let the test follow along. Exits 0 only
 * if every step behaved as the exchange contract says. */
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

#define EXCHANGE "/run/kandelo/exchange"
#define EXCHANGE_MAGIC 0x4B584348

static int failures;

static char first_failure[48];

static void fail(const char *what) {
    fprintf(stderr, "FAIL %s: errno %d (%s)\n", what, errno, strerror(errno));
    if (failures++ == 0) snprintf(first_failure, sizeof first_failure, "%s: errno %d", what, errno);
}

/* One LF-terminated line from the events device; blocks until it exists. */
static int read_line(int fd, char *line, size_t size) {
    size_t used = 0;
    while (used + 1 < size) {
        ssize_t n = read(fd, line + used, 1);
        if (n < 0) return -1;
        if (n == 0) break;
        if (line[used++] == '\n') break;
    }
    line[used] = '\0';
    return (int)used;
}

static void expect_errno(const char *what, int result, int expected) {
    if (result != -1 || errno != expected) {
        fprintf(stderr, "FAIL %s: got %d errno %d, want errno %d\n", what, result, errno, expected);
        if (failures++ == 0) snprintf(first_failure, sizeof first_failure, "%s: errno %d", what, errno);
    }
}

static int publish_upper(const char *input_path, const char *name, const char *input_id) {
    char data[4096];
    struct stat st;
    if (stat(input_path, &st) != 0) { fail("stat input"); return -1; }
    int streamed = S_ISFIFO(st.st_mode);
    int in = open(input_path, O_RDONLY);
    if (in < 0) { fail("open input"); return -1; }
    /* A stream arrives as the host writes it; end-of-file is its end. */
    ssize_t length = 0, n;
    while ((n = read(in, data + length, sizeof data - (size_t)length)) > 0) length += n;
    close(in);
    if (n < 0) { fail("read input"); return -1; }
    printf("EXCH_INPUT name=%s kind=%s bytes=%.*s\n", name, streamed ? "stream" : "file", (int)length, data);

    /* A work session: the clone open creates work/<n>/, owned by us. */
    int clone = open(EXCHANGE "/work/clone", O_RDONLY);
    if (clone < 0) { fail("open work/clone"); return -1; }
    char number[16];
    n = read(clone, number, sizeof number - 1);
    if (n <= 0) { fail("read work/clone"); close(clone); return -1; }
    number[n] = '\0';
    number[strcspn(number, "\n")] = '\0';

    char work[256], outbox[256];
    snprintf(work, sizeof work, EXCHANGE "/work/%s/upper-%s", number, name);
    snprintf(outbox, sizeof outbox, EXCHANGE "/outbox/upper-%s", name);
    for (ssize_t i = 0; i < length; i++) data[i] = (char)toupper((unsigned char)data[i]);
    if (streamed) {
        /* A streamed output: publish the FIFO, then write it as the host reads. */
        if (mkfifo(work, 0600) != 0) { fail("mkfifo"); close(clone); return -1; }
        if (setxattr(work, "user.kandelo.derived_from", input_id, strlen(input_id), 0) != 0)
            fail("set stream derived_from");
        if (rename(work, outbox) != 0) { fail("publish stream"); close(clone); return -1; }
        int out = open(outbox, O_WRONLY); /* blocks until the host reads */
        if (out < 0) { fail("open stream"); close(clone); return -1; }
        for (ssize_t done = 0; done < length;) {
            ssize_t step = length - done < 5 ? length - done : 5;
            ssize_t wrote = write(out, data + done, (size_t)step);
            if (wrote <= 0) { fail("write stream"); break; }
            done += wrote;
        }
        if (fsetxattr(out, "user.kandelo.end", "complete", 8, 0) != 0) fail("end stream");
        expect_errno("write after the end", (int)write(out, "x", 1), EPERM);
        close(out);
        printf("EXCH_PUBLISHED name=upper-%s stream\n", name);
        close(clone);
        return 0;
    }
    int out = open(work, O_WRONLY | O_CREAT | O_EXCL, 0640);
    if (out < 0) { fail("create work file"); close(clone); return -1; }
    if (write(out, data, (size_t)length) != length) fail("write work file");
    if (fsetxattr(out, "user.mime_type", "text/plain", 10, 0) != 0) fail("set mime type");
    if (fsetxattr(out, "user.kandelo.derived_from", input_id, strlen(input_id), 0) != 0)
        fail("set derived_from");
    /* Publishing an open file would let its bytes change under the host. */
    expect_errno("publish while open", rename(work, outbox), EBUSY);
    close(out);
    if (rename(work, outbox) != 0) { fail("publish"); close(clone); return -1; }

    /* Published outputs are frozen and carry their own ID. */
    expect_errno("write a published output", open(outbox, O_WRONLY), EPERM);
    char id[64];
    ssize_t id_length = getxattr(outbox, "user.kandelo.id", id, sizeof id - 1);
    if (id_length < 0) fail("output id"); else id[id_length] = '\0';
    printf("EXCH_PUBLISHED name=upper-%s id=%s\n", name, id_length < 0 ? "?" : id);
    close(clone); /* ends the session; work/<n>/ goes with it */
    return 0;
}

int main(void) {
    struct statfs fs;
    if (statfs(EXCHANGE, &fs) != 0) fail("statfs");
    else if ((unsigned long)fs.f_type != EXCHANGE_MAGIC) {
        fprintf(stderr, "FAIL f_type 0x%lx\n", (unsigned long)fs.f_type);
        failures++;
    }

    int events = open(EXCHANGE "/events", O_RDONLY);
    if (events < 0) { fail("open events"); return 1; }
    expect_errno("second consumer", open(EXCHANGE "/events", O_RDONLY), EBUSY);
    printf("EXCH_CONSUMER\n");
    fflush(stdout);

    char line[128];
    char batch[64] = "";
    while (batch[0] == '\0') {
        if (read_line(events, line, sizeof line) <= 0) { fail("read events"); return 1; }
        printf("EXCH_EVENT %s", line);
        if (strncmp(line, "batch ", 6) == 0) {
            snprintf(batch, sizeof batch, "%.*s", (int)strcspn(line + 6, "\n"), line + 6);
        }
    }
    fflush(stdout);

    char dir[256];
    snprintf(dir, sizeof dir, EXCHANGE "/inbox/%s", batch);
    DIR *listing = opendir(dir);
    if (!listing) { fail("open batch"); return 1; }
    struct dirent *entry;
    char names[16][128];
    int count = 0;
    while ((entry = readdir(listing)) && count < 16) {
        if (entry->d_name[0] == '.') continue;
        snprintf(names[count++], sizeof names[0], "%s", entry->d_name);
    }
    closedir(listing);

    for (int i = 0; i < count; i++) {
        char path[512], id[64], mime[64];
        snprintf(path, sizeof path, "%s/%s", dir, names[i]);
        ssize_t id_length = getxattr(path, "user.kandelo.id", id, sizeof id - 1);
        ssize_t mime_length = getxattr(path, "user.mime_type", mime, sizeof mime - 1);
        if (id_length < 0) { fail("input id"); continue; }
        /* A MIME type is optional metadata: absent is ENODATA. */
        if (mime_length < 0 && errno != ENODATA) { fail("input mime type"); continue; }
        id[id_length] = '\0';
        if (mime_length < 0) snprintf(mime, sizeof mime, "-");
        else mime[mime_length] = '\0';
        printf("EXCH_INPUT_ATTRS name=%s id=%s mime=%s\n", names[i], id, mime);
        /* Inputs are the host's bytes: read-only to everyone. */
        expect_errno("write an input", open(path, O_WRONLY | O_NONBLOCK), EPERM);
        publish_upper(path, names[i], id);
    }

    /* The batch's status says what happened, so the host can show it. */
    char status[64];
    if (failures == 0) snprintf(status, sizeof status, "done");
    else snprintf(status, sizeof status, "failed: %s", first_failure);
    if (setxattr(dir, "user.kandelo.status", status, strlen(status), 0) != 0) fail("set status");
    for (int i = 0; i < count; i++) {
        char path[512];
        snprintf(path, sizeof path, "%s/%s", dir, names[i]);
        if (unlink(path) != 0) fail("remove input");
    }
    if (rmdir(dir) != 0) fail("remove batch");
    close(events);

    printf(failures == 0 ? "EXCH_DONE\n" : "EXCH_FAILED\n");
    return failures == 0 ? 0 : 1;
}
