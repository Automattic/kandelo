/*
 * /proc/self/maps must describe the process's real mappings in Linux's
 * format: start-end, perms with s/p for MAP_SHARED/MAP_PRIVATE, file offset,
 * device major:minor, inode, and the pathname of a file mapping.
 *
 * Each case maps something, then finds the line whose start address is the
 * mapping's address and checks every column against what the program itself
 * knows: the flags it passed, the offset it passed, and what fstat() says
 * about the descriptor it mapped. The descriptor is closed before maps is
 * read, because a mapping outlives its descriptor (POSIX mmap()).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>

struct maps_line {
    unsigned long start, end;
    char perms[5];
    unsigned long long offset;
    unsigned major, minor;
    unsigned long inode;
    int header_end;  /* byte index just past the inode column */
    int name_column; /* byte index of the pathname, or -1 */
    char name[256];
};

static int failures;

/* Find the /proc/self/maps line that starts at `addr`. */
static int find_line(void *addr, struct maps_line *out) {
    FILE *maps = fopen("/proc/self/maps", "r");
    if (!maps) {
        printf("FAIL open /proc/self/maps: %s\n", strerror(errno));
        return -1;
    }
    char text[512];
    int found = -1;
    while (fgets(text, sizeof text, maps)) {
        struct maps_line line;
        int consumed = 0;
        if (sscanf(text, "%lx-%lx %4s %llx %x:%x %lu%n %n", &line.start,
                   &line.end, line.perms, &line.offset, &line.major,
                   &line.minor, &line.inode, &line.header_end,
                   &consumed) != 7) {
            printf("FAIL unparsable maps line: %s", text);
            failures++;
            continue;
        }
        if (line.start != (unsigned long)addr) continue;
        size_t len = strlen(text);
        if (len && text[len - 1] == '\n') text[--len] = '\0';
        if ((size_t)consumed < len) {
            line.name_column = consumed;
            snprintf(line.name, sizeof line.name, "%s", text + consumed);
        } else {
            line.name_column = -1;
            line.name[0] = '\0';
        }
        *out = line;
        found = 0;
        break;
    }
    fclose(maps);
    if (found != 0) printf("FAIL no maps line starts at %p\n", addr);
    return found;
}

static void expect(int ok, const char *test, const char *what,
                   const struct maps_line *line) {
    if (ok) return;
    failures++;
    printf("FAIL %s: %s (line: %08lx-%08lx %s %08llx %02x:%02x %lu %s)\n",
           test, what, line->start, line->end, line->perms, line->offset,
           line->major, line->minor, line->inode, line->name);
}

/* Check one mapping's line. `st` is NULL for anonymous memory. */
static int check_mapping(const char *test, void *addr, size_t len,
                         const char *perms, unsigned long long offset,
                         const struct stat *st, const char *name) {
    int before = failures;
    struct maps_line line;
    if (find_line(addr, &line) != 0) {
        failures++;
        return 1;
    }
    expect(line.end >= (unsigned long)addr + len, test, "end before mapping end",
           &line);
    expect(strcmp(line.perms, perms) == 0, test, "perms", &line);
    expect(line.offset == offset, test, "offset", &line);
    if (st) {
        expect(line.major == major(st->st_dev) &&
                   line.minor == minor(st->st_dev),
               test, "device is not fstat's st_dev", &line);
        expect(line.inode == (unsigned long)st->st_ino, test,
               "inode is not fstat's st_ino", &line);
    } else {
        expect(line.major == 0 && line.minor == 0 && line.inode == 0, test,
               "anonymous memory has a device or inode", &line);
    }
    if (name) {
        expect(strcmp(line.name, name) == 0, test, "pathname", &line);
        /* The fixed columns end with a space after the inode. Linux pads
         * them to 25 + sizeof(void *) * 6 - 1 bytes, then writes one more
         * space before the pathname; a longer header gets just that space. */
        int width = 25 + (int)sizeof(void *) * 6 - 1;
        int header = line.header_end + 1;
        expect(line.name_column == (header > width ? header : width) + 1, test,
               "pathname column", &line);
    } else {
        expect(line.name_column == -1, test, "anonymous memory has a name",
               &line);
    }
    if (failures == before) printf("%s: PASS\n", test);
    return failures != before;
}

static int make_file(const char *path, size_t len, struct stat *st) {
    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (fd < 0 || ftruncate(fd, (off_t)len) != 0 || fstat(fd, st) != 0) {
        printf("FAIL create %s: %s\n", path, strerror(errno));
        failures++;
        return -1;
    }
    return fd;
}

int main(void) {
    long page = sysconf(_SC_PAGESIZE);
    struct stat st;

    /* A MAP_SHARED file mapping at a nonzero offset. */
    const char *path = "/tmp/proc-maps-file";
    int fd = make_file(path, 4 * page, &st);
    if (fd < 0) return 1;
    void *shared_file = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE,
                             MAP_SHARED, fd, page);
    void *private_file = mmap(NULL, page, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (shared_file == MAP_FAILED || private_file == MAP_FAILED) {
        printf("FAIL mmap file: %s\n", strerror(errno));
        return 1;
    }
    check_mapping("file-shared", shared_file, 2 * page, "rw-s",
                  (unsigned long long)page, &st, path);
    check_mapping("file-private", private_file, page, "r--p", 0, &st, path);

    /* Unmapping the head of a file mapping keeps the tail's file offset. */
    munmap(shared_file, page);
    check_mapping("file-trimmed", (char *)shared_file + page, page, "rw-s",
                  (unsigned long long)(2 * page), &st, path);

    /* A memfd, named as Linux names the unlinked shmem file behind it. */
    int memfd = memfd_create("proc-maps", 0);
    struct stat memfd_st;
    if (memfd < 0 || ftruncate(memfd, page) != 0 ||
        fstat(memfd, &memfd_st) != 0) {
        printf("FAIL memfd: %s\n", strerror(errno));
        return 1;
    }
    void *memfd_map = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_SHARED,
                           memfd, 0);
    close(memfd);
    if (memfd_map == MAP_FAILED) {
        printf("FAIL mmap memfd: %s\n", strerror(errno));
        return 1;
    }
    check_mapping("memfd", memfd_map, page, "rw-s", 0, &memfd_st,
                  "/memfd:proc-maps (deleted)");

    /* A POSIX shared-memory object is a file under /dev/shm. */
    int shm = shm_open("/proc-maps-shm", O_CREAT | O_RDWR, 0600);
    struct stat shm_st;
    if (shm < 0 || ftruncate(shm, page) != 0 || fstat(shm, &shm_st) != 0) {
        printf("FAIL shm_open: %s\n", strerror(errno));
        return 1;
    }
    void *shm_map = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_SHARED, shm,
                         0);
    close(shm);
    if (shm_map == MAP_FAILED) {
        printf("FAIL mmap shm: %s\n", strerror(errno));
        return 1;
    }
    check_mapping("dev-shm", shm_map, page, "rw-s", 0, &shm_st,
                  "/dev/shm/proc-maps-shm");
    shm_unlink("/proc-maps-shm");

    /* Anonymous memory has no device, inode or name. */
    void *anon_private = mmap(NULL, page, PROT_READ | PROT_WRITE,
                              MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    void *anon_shared = mmap(NULL, page, PROT_READ,
                             MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (anon_private == MAP_FAILED || anon_shared == MAP_FAILED) {
        printf("FAIL mmap anonymous: %s\n", strerror(errno));
        return 1;
    }
    check_mapping("anonymous-private", anon_private, page, "rw-p", 0, NULL,
                  NULL);
    check_mapping("anonymous-shared", anon_shared, page, "r--s", 0, NULL,
                  NULL);

    /* A forked child inherits the mappings, and with them their files. */
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL fork: %s\n", strerror(errno));
        return 1;
    }
    if (pid == 0) {
        int bad = check_mapping("fork-child-memfd", memfd_map, page, "rw-s", 0,
                                &memfd_st, "/memfd:proc-maps (deleted)");
        bad |= check_mapping("fork-child-file", private_file, page, "r--p", 0,
                             &st, path);
        fflush(stdout);
        _exit(bad ? 1 : 0);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        printf("FAIL fork child status 0x%x\n", status);
        failures++;
    }

    unlink(path);
    if (failures) {
        printf("PROC_MAPS_FAIL %d\n", failures);
        return 1;
    }
    printf("PROC_MAPS_PASS\n");
    return 0;
}
