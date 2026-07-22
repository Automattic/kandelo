#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#define ENTRY_COUNT 192
#define EXPECTED_REAL_ENTRIES (ENTRY_COUNT - 1)

struct linux_dirent64_local {
    uint64_t d_ino;
    int64_t d_off;
    uint16_t d_reclen;
    uint8_t d_type;
    char d_name[];
};

struct enumeration {
    bool entries[ENTRY_COUNT];
    bool renamed;
    bool dot;
    bool dotdot;
    size_t real_count;
    char order[ENTRY_COUNT][32];
};

static void fail(const char *message)
{
    fprintf(stderr, "GETDENTS_BOUNDARY_FAIL: %s (errno=%d: %s)\n",
            message, errno, strerror(errno));
    exit(1);
}

static void entry_path(char *out, size_t out_size, const char *directory, int index)
{
    int written = snprintf(out, out_size, "%s/entry-%03d", directory, index);
    if (written < 0 || (size_t)written >= out_size)
        fail("entry path overflow");
}

static void record_name(struct enumeration *result, const char *name)
{
    if (strcmp(name, ".") == 0) {
        if (result->dot)
            fail("duplicate dot entry");
        result->dot = true;
        return;
    }
    if (strcmp(name, "..") == 0) {
        if (result->dotdot)
            fail("duplicate dot-dot entry");
        result->dotdot = true;
        return;
    }

    if (result->real_count >= EXPECTED_REAL_ENTRIES)
        fail("too many real directory entries");
    if (strlen(name) >= sizeof(result->order[0]))
        fail("directory entry name overflow");
    strcpy(result->order[result->real_count], name);
    result->real_count++;

    if (strcmp(name, "renamed-038") == 0) {
        if (result->renamed)
            fail("duplicate renamed entry");
        result->renamed = true;
        return;
    }

    int index = -1;
    char trailing = '\0';
    if (sscanf(name, "entry-%03d%c", &index, &trailing) != 1 ||
        index < 0 || index >= ENTRY_COUNT)
        fail("unexpected directory entry");
    if (index == 37 || index == 38)
        fail("deleted or renamed source entry remained visible");
    if (result->entries[index])
        fail("duplicate numbered entry");
    result->entries[index] = true;
}

static void verify_enumeration(const struct enumeration *result)
{
    if (!result->dot || !result->dotdot)
        fail("dot entries are incomplete");
    if (!result->renamed)
        fail("renamed entry is missing");
    if (result->real_count != EXPECTED_REAL_ENTRIES)
        fail("real entry count differs from directory state");
    for (int index = 0; index < ENTRY_COUNT; index++) {
        bool expected = index != 37 && index != 38;
        if (result->entries[index] != expected)
            fail("numbered entry set differs from directory state");
    }
}

static size_t consume_dirents(
    const unsigned char *buffer,
    size_t length,
    struct enumeration *result,
    int64_t *last_cookie)
{
    size_t position = 0;
    size_t records = 0;
    while (position < length) {
        if (length - position < 19)
            fail("truncated linux_dirent64 header");
        const struct linux_dirent64_local *entry =
            (const struct linux_dirent64_local *)(buffer + position);
        size_t record_length = entry->d_reclen;
        if (record_length < 24 || record_length % 8 != 0 ||
            record_length > length - position)
            fail("invalid linux_dirent64 record length");
        size_t name_capacity = record_length - 19;
        if (memchr(entry->d_name, '\0', name_capacity) == NULL)
            fail("unterminated linux_dirent64 name");
        record_name(result, entry->d_name);
        if (last_cookie != NULL)
            *last_cookie = entry->d_off;
        position += record_length;
        records++;
    }
    if (position != length)
        fail("linux_dirent64 records do not cover returned bytes");
    return records;
}

static ssize_t getdents64_call(int fd, void *buffer, size_t length)
{
    return syscall(SYS_getdents64, fd, buffer, length);
}

static void enumerate_readdir(DIR *directory, struct enumeration *result)
{
    errno = 0;
    for (;;) {
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0)
                fail("readdir failed");
            break;
        }
        record_name(result, entry->d_name);
    }
}

static const char *next_real_entry(DIR *directory)
{
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0)
                fail("readdir failed while seeking");
            fail("unexpected end of directory while seeking");
        }
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0)
            return entry->d_name;
    }
}

int main(void)
{
    char directory[96];
    int written = -1;
    bool created_directory = false;
    for (int attempt = 0; attempt < 1024; attempt++) {
        written = snprintf(directory, sizeof(directory),
                           "/tmp/getdents-boundary-%ld-%d",
                           (long)getpid(), attempt);
        if (written < 0 || (size_t)written >= sizeof(directory))
            fail("directory path overflow");
        if (mkdir(directory, 0700) == 0) {
            created_directory = true;
            break;
        }
        if (errno != EEXIST)
            fail("mkdir failed");
    }
    if (!created_directory)
        fail("could not find an unused test directory");

    char path[128];
    for (int index = 0; index < ENTRY_COUNT; index++) {
        entry_path(path, sizeof(path), directory, index);
        int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (fd < 0)
            fail("file creation failed");
        if (close(fd) != 0)
            fail("file close failed");
    }
    entry_path(path, sizeof(path), directory, 37);
    if (unlink(path) != 0)
        fail("entry deletion failed");
    char renamed_from[128];
    char renamed_to[128];
    entry_path(renamed_from, sizeof(renamed_from), directory, 38);
    written = snprintf(renamed_to, sizeof(renamed_to), "%s/renamed-038", directory);
    if (written < 0 || (size_t)written >= sizeof(renamed_to))
        fail("renamed path overflow");
    if (rename(renamed_from, renamed_to) != 0)
        fail("entry rename failed");

    int fd = open(directory, O_RDONLY | O_DIRECTORY);
    if (fd < 0)
        fail("directory open failed");

    struct enumeration small = {0};
    unsigned char prefix[48];
    ssize_t length = getdents64_call(fd, prefix, sizeof(prefix));
    if (length != (ssize_t)sizeof(prefix))
        fail("two-entry exact-fit prefix failed");
    if (consume_dirents(prefix, (size_t)length, &small, NULL) != 2 ||
        !small.dot || !small.dotdot || small.real_count != 0)
        fail("exact-fit prefix did not contain only dot entries");

    unsigned char one_byte_short[31];
    errno = 0;
    if (getdents64_call(fd, one_byte_short, sizeof(one_byte_short)) != -1 ||
        errno != EINVAL)
        fail("one-byte-short pending entry did not return EINVAL");

    unsigned char one_entry[32];
    for (;;) {
        length = getdents64_call(fd, one_entry, sizeof(one_entry));
        if (length < 0)
            fail("small-buffer getdents64 failed");
        if (length == 0)
            break;
        if (length != (ssize_t)sizeof(one_entry) ||
            consume_dirents(one_entry, (size_t)length, &small, NULL) != 1)
            fail("exact-fit host entry failed");
    }
    verify_enumeration(&small);
    if (getdents64_call(fd, one_entry, sizeof(one_entry)) != 0)
        fail("repeated getdents64 EOF was not stable");

    if (lseek(fd, 0, SEEK_SET) != 0)
        fail("directory rewind with lseek failed");
    struct enumeration repeated = {0};
    unsigned char two_entries[64];
    for (;;) {
        length = getdents64_call(fd, two_entries, sizeof(two_entries));
        if (length < 0)
            fail("repeated-buffer getdents64 failed");
        if (length == 0)
            break;
        consume_dirents(two_entries, (size_t)length, &repeated, NULL);
    }
    verify_enumeration(&repeated);
    if (repeated.real_count != small.real_count)
        fail("small and repeated-buffer enumerations disagree");
    for (size_t index = 0; index < small.real_count; index++) {
        if (strcmp(repeated.order[index], small.order[index]) != 0)
            fail("directory order changed across rewind");
    }

    if (lseek(fd, 0, SEEK_SET) != 0)
        fail("second directory rewind failed");
    struct enumeration cookie_prefix = {0};
    unsigned char three_entries[80];
    int64_t cookie = -1;
    length = getdents64_call(fd, three_entries, sizeof(three_entries));
    if (length != (ssize_t)sizeof(three_entries) ||
        consume_dirents(three_entries, (size_t)length, &cookie_prefix, &cookie) != 3 ||
        cookie_prefix.real_count != 1 || cookie < 0)
        fail("d_off cookie prefix failed");
    if (lseek(fd, cookie, SEEK_SET) != cookie)
        fail("directory cookie seek failed");
    struct enumeration after_cookie = {0};
    length = getdents64_call(fd, one_entry, sizeof(one_entry));
    if (length != (ssize_t)sizeof(one_entry) ||
        consume_dirents(one_entry, (size_t)length, &after_cookie, NULL) != 1 ||
        after_cookie.real_count != 1 ||
        strcmp(after_cookie.order[0], small.order[1]) != 0)
        fail("directory cookie resumed at the wrong entry");
    if (close(fd) != 0)
        fail("directory fd close failed");

    DIR *stream = opendir(directory);
    if (stream == NULL)
        fail("opendir failed");
    struct enumeration libc_first = {0};
    enumerate_readdir(stream, &libc_first);
    verify_enumeration(&libc_first);
    rewinddir(stream);
    struct enumeration libc_rewound = {0};
    enumerate_readdir(stream, &libc_rewound);
    verify_enumeration(&libc_rewound);
    for (size_t index = 0; index < libc_first.real_count; index++) {
        if (strcmp(libc_first.order[index], libc_rewound.order[index]) != 0)
            fail("readdir order changed after rewinddir");
    }

    rewinddir(stream);
    const char *first = next_real_entry(stream);
    char first_copy[32];
    strcpy(first_copy, first);
    long stream_cookie = telldir(stream);
    if (stream_cookie < 0)
        fail("telldir failed");
    const char *second = next_real_entry(stream);
    char second_copy[32];
    strcpy(second_copy, second);
    seekdir(stream, stream_cookie);
    const char *resumed = next_real_entry(stream);
    if (strcmp(resumed, second_copy) != 0 || strcmp(first_copy, second_copy) == 0)
        fail("seekdir did not resume after the saved entry");
    if (closedir(stream) != 0)
        fail("closedir failed");

    for (int index = 0; index < ENTRY_COUNT; index++) {
        if (index == 37 || index == 38)
            continue;
        entry_path(path, sizeof(path), directory, index);
        if (unlink(path) != 0)
            fail("cleanup unlink failed");
    }
    if (unlink(renamed_to) != 0 || rmdir(directory) != 0)
        fail("directory cleanup failed");

    puts("GETDENTS_BOUNDARY_PASS");
    return 0;
}
