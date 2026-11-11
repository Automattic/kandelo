#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static struct dirent *next_file(DIR *directory) {
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory))) {
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) return entry;
    }
    assert(errno == 0);
    return NULL;
}

static int check_filesystem(const char *prefix) {
    char source[256], target[256], from[512], to[512];
    snprintf(source, sizeof source, "%s/source", prefix);
    snprintf(target, sizeof target, "%s/target", prefix);
    assert(mkdir(source, 0700) == 0);
    assert(mkdir(target, 0700) == 0);
    for (int index = 0; index < 256; index++) {
        snprintf(from, sizeof from, "%s/file-%04d", source, index);
        FILE *file = fopen(from, "w");
        assert(file);
        assert(fputs("payload", file) >= 0);
        assert(fclose(file) == 0);
    }
    DIR *directory = opendir(source);
    assert(directory);
    struct dirent *entry;
    int moved = 0;
    while ((entry = next_file(directory))) {
        snprintf(from, sizeof from, "%s/%s", source, entry->d_name);
        snprintf(to, sizeof to, "%s/%s", target, entry->d_name);
        assert(rename(from, to) == 0);
        moved++;
    }
    assert(closedir(directory) == 0);
    printf("%s moved=%d\n", prefix, moved);
    fflush(stdout);
    assert(moved == 256);
    assert(rmdir(source) == 0);

    directory = opendir(target);
    assert(directory);
    entry = next_file(directory);
    assert(entry);
    snprintf(to, sizeof to, "%s/%s", target, entry->d_name);
    long cookie = telldir(directory);
    assert(cookie >= 0);
    assert(unlink(to) == 0);
    entry = next_file(directory);
    assert(entry);
    char expected[256];
    snprintf(expected, sizeof expected, "%s", entry->d_name);
    seekdir(directory, cookie);
    entry = next_file(directory);
    assert(entry && strcmp(entry->d_name, expected) == 0);
    rewinddir(directory);
    int removed = 1;
    while ((entry = next_file(directory))) {
        snprintf(to, sizeof to, "%s/%s", target, entry->d_name);
        assert(unlink(to) == 0);
        removed++;
    }
    assert(closedir(directory) == 0);
    assert(removed == 256);
    assert(rmdir(target) == 0);
    return moved;
}

int main(void) {
    int rootfs = check_filesystem("/work");
    int tmpfs = check_filesystem("/tmp");
    printf("directory-cookies: rootfs=%d tmpfs=%d seekdir=ok\n", rootfs, tmpfs);
    return 0;
}
