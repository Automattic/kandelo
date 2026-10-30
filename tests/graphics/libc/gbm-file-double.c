/* Native tests run on macOS too. Model the new query using actual dup
 * operations, never inode/path equality. Only the test process uses this
 * descriptor registry; actual SDK guests exercise the kernel command. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#define QUERY 1027
struct alias { int fd; uint64_t identity; struct alias *next; };
static struct alias *aliases;
static uint64_t next_identity = 1;
int graphics_gbm_fail_file_query;
static struct alias *observe(int fd) {
    if (fcntl(fd, F_GETFD, 0) < 0) return NULL;
    for (struct alias *a = aliases; a; a = a->next) if (a->fd == fd) return a;
    struct alias *a = calloc(1, sizeof *a); assert(a);
    a->fd = fd; a->identity = next_identity++; a->next = aliases; aliases = a;
    return a;
}
int graphics_gbm_close(int fd) {
    int result = close(fd);
    if (!result) {
        struct alias **slot = &aliases;
        while (*slot && (*slot)->fd != fd) slot = &(*slot)->next;
        if (*slot) { struct alias *a = *slot; *slot = a->next; free(a); }
    }
    return result;
}
int graphics_gbm_dup(int fd) {
    struct alias *source = observe(fd);
    if (!source) return -1;
    int result = dup(fd);
    if (result >= 0) observe(result)->identity = source->identity;
    return result;
}
int graphics_gbm_fcntl(int fd, int command, ...) {
    va_list ap; va_start(ap, command);
    if (command == QUERY) {
        int other = (int)va_arg(ap, unsigned long); va_end(ap);
        if (graphics_gbm_fail_file_query) {
            graphics_gbm_fail_file_query = 0; errno = EIO; return -1;
        }
        struct alias *a = observe(fd), *b = observe(other);
        if (!a || !b) return -1;
        return a->identity == b->identity;
    }
    int arg = command == F_GETFD ? 0 : va_arg(ap, int); va_end(ap);
    struct alias *source = observe(fd);
    if (!source) return -1;
    int result = fcntl(fd, command, arg);
    if (result >= 0 && (command == F_DUPFD || command == F_DUPFD_CLOEXEC))
        observe(result)->identity = source->identity;
    return result;
}
