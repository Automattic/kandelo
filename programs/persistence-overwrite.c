#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static unsigned char large_write[2 * 1024 * 1024];
static unsigned char verify_buffer[4096];

int main(int argc, char **argv) {
    int change_config = argc >= 2 && strcmp(argv[1], "change-boot-config") == 0;
    int restore_config = argc >= 2 && strcmp(argv[1], "restore-boot-config") == 0;
    if (change_config || restore_config) {
        int fd = open("/etc/kandelo/demo.json", O_RDWR);
        if (fd < 0) return 152;
        char bytes[4096];
        ssize_t count = pread(fd, bytes, sizeof(bytes) - 1, 0);
        if (count <= 0) return 153;
        bytes[count] = '\0';
        char *match = strstr(bytes, change_config
            ? "\"defaultProfile\":\"probe\""
            : "\"defaultProfile\":\"other\"");
        if (match == NULL) return 154;
        off_t offset = match - bytes + strlen("\"defaultProfile\":\"");
        if (pwrite(fd, change_config ? "other" : "probe", 5, offset) != 5) return 155;
        return fsync(fd) == 0 && close(fd) == 0 ? 0 : 156;
    }
    int change_session = argc >= 2 && strcmp(argv[1], "change-terminal-session") == 0;
    int restore_session = argc >= 2 && strcmp(argv[1], "restore-terminal-session") == 0;
    if (change_session || restore_session) {
        int fd = open("/etc/kandelo/experimental-terminal-session.json", O_RDWR);
        if (fd < 0) return 157;
        char bytes[4096];
        ssize_t count = pread(fd, bytes, sizeof(bytes) - 1, 0);
        if (count <= 0) return 158;
        bytes[count] = '\0';
        char *path = strstr(bytes, "persistence-overwrite");
        char *argv = path == NULL ? NULL : strstr(path + 1,
            change_session ? "persistence-overwrite" : "persistence-overwritE");
        if (argv == NULL) return 159;
        off_t offset = argv - bytes + strlen("persistence-overwrite") - 1;
        if (pwrite(fd, change_session ? "E" : "e", 1, offset) != 1) return 160;
        return fsync(fd) == 0 && close(fd) == 0 ? 0 : 161;
    }
    if (argc >= 2 && strcmp(argv[1], "change-dinit-closure") == 0) {
        int fd = open("/etc/dinit.d/boot", O_RDWR);
        if (fd < 0) return 162;
        char bytes[4096];
        ssize_t count = pread(fd, bytes, sizeof(bytes) - 1, 0);
        if (count <= 0) return 163;
        bytes[count] = '\0';
        char *match = strstr(bytes, "depends-on = alpha");
        if (match == NULL) return 164;
        off_t offset = match - bytes + strlen("depends-on = ");
        if (pwrite(fd, "bravo", 5, offset) != 5) return 165;
        return fsync(fd) == 0 && close(fd) == 0 ? 0 : 166;
    }
    if (argc >= 2 && strcmp(argv[1], "create-socket") == 0) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return 145;
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        strcpy(address.sun_path, "/persistent-socket");
        socklen_t length = offsetof(struct sockaddr_un, sun_path) + strlen(address.sun_path) + 1;
        if (bind(fd, (const struct sockaddr *)&address, length) != 0) return 146;
        return close(fd) == 0 ? 0 : 147;
    }
    if (argc >= 2 && strcmp(argv[1], "verify-socket") == 0) {
        struct stat metadata;
        if (lstat("/persistent-socket", &metadata) != 0 || !S_ISSOCK(metadata.st_mode)) return 148;
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return 149;
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        strcpy(address.sun_path, "/persistent-socket");
        socklen_t length = offsetof(struct sockaddr_un, sun_path) + strlen(address.sun_path) + 1;
        if (connect(fd, (const struct sockaddr *)&address, length) != -1 || errno != ECONNREFUSED) return 150;
        return close(fd) == 0 ? 0 : 151;
    }
    if (argc >= 2 && strcmp(argv[1], "create-fifo") == 0) {
        return mkfifo("/persistent-fifo", 0640) == 0 ? 0 : 142;
    }
    if (argc >= 2 && strcmp(argv[1], "verify-fifo") == 0) {
        struct stat metadata;
        if (lstat("/persistent-fifo", &metadata) != 0 || !S_ISFIFO(metadata.st_mode)
            || (metadata.st_mode & 0777) != 0640) return 143;
        int fd = open("/persistent-fifo", O_RDONLY | O_NONBLOCK);
        return fd >= 0 && close(fd) == 0 ? 0 : 144;
    }
    if (argc >= 2 && strcmp(argv[1], "quota-write") == 0) {
        int fd = open("/state", O_RDWR);
        if (fd < 0) return 108;
        if (pwrite(fd, "XY", 2, 0) != 2) return 109;
        if (fsync(fd) != -1 || errno != ENOSPC) return 110;
        char bytes[2];
        if (pread(fd, bytes, sizeof(bytes), 0) != (ssize_t)sizeof(bytes) || memcmp(bytes, "XY", 2) != 0) return 111;
        close(fd);
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "quota-evict") == 0) {
        int fd = open("/large", O_RDWR);
        if (fd < 0) return 112;
        const size_t cached_bytes = 64 * 4096;
        memset(large_write, 'X', cached_bytes + 4096);
        if (pwrite(fd, large_write, cached_bytes + 4096, 0) != (ssize_t)cached_bytes) return 113;
        if (fdatasync(fd) != -1 || errno != ENOSPC) return 114;
        unsigned char first;
        unsigned char unwritten;
        if (pread(fd, &first, 1, 0) != 1 || first != 'X') return 115;
        if (pread(fd, &unwritten, 1, cached_bytes) != 1 || unwritten != 0) return 116;
        close(fd);
        return 0;
    }
    int set_metadata = argc >= 2 && strcmp(argv[1], "set-metadata") == 0;
    int verify_metadata = argc >= 2 && strcmp(argv[1], "verify-metadata") == 0;
    if (set_metadata || verify_metadata) {
        if (set_metadata) {
            int fd = open("/created-link", O_RDONLY);
            if (fd < 0) return 94;
            if (fchmod(fd, 0600) != 0 || close(fd) != 0) return 95;
            const struct timespec times[2] = {{123456, 234}, {234567, 345}};
            return utimensat(AT_FDCWD, "/created-link", times, 0) == 0 ? 0 : 96;
        }
        struct stat metadata;
        if (stat("/created-link", &metadata) != 0) return 97;
        if ((metadata.st_mode & 0777) != 0600 || metadata.st_atim.tv_sec != 123456 || metadata.st_atim.tv_nsec != 234) return 98;
        if (metadata.st_mtim.tv_sec != 234567 || metadata.st_mtim.tv_nsec != 345) return 99;
        return 0;
    }
    int replace_open = argc >= 2 && strcmp(argv[1], "replace-open") == 0;
    int verify_replacement = argc >= 2 && strcmp(argv[1], "verify-replacement") == 0;
    if (replace_open || verify_replacement) {
        if (replace_open) {
            int displaced = open("/replacement", O_CREAT | O_EXCL | O_RDWR, 0644);
            if (displaced < 0) return 126;
            if (write(displaced, "OLD", 3) != 3 || fsync(displaced) != 0) return 127;
            struct stat old_metadata;
            if (fstat(displaced, &old_metadata) != 0 || old_metadata.st_nlink != 1) return 128;
            if (rename("/created-link", "/replacement") != 0) return 129;
            if (fstat(displaced, &old_metadata) != 0 || old_metadata.st_nlink != 0) return 130;
            if (pwrite(displaced, "GONE", 4, 0) != 4 || fsync(displaced) != 0) return 131;
            char old_bytes[4];
            if (pread(displaced, old_bytes, sizeof(old_bytes), 0) != (ssize_t)sizeof(old_bytes)
                || memcmp(old_bytes, "GONE", sizeof(old_bytes)) != 0) return 132;
            int named = open("/replacement", O_RDONLY);
            if (named < 0) return 133;
            struct stat named_metadata;
            if (fstat(named, &named_metadata) != 0 || named_metadata.st_ino == old_metadata.st_ino
                || named_metadata.st_nlink != 1 || named_metadata.st_size != 3) return 134;
            char named_bytes[3];
            if (pread(named, named_bytes, sizeof(named_bytes), 0) != (ssize_t)sizeof(named_bytes)
                || memcmp(named_bytes, "\0\0\0", sizeof(named_bytes)) != 0) return 135;
            return close(named) == 0 && close(displaced) == 0 ? 0 : 136;
        }
        struct stat missing;
        if (stat("/created-link", &missing) != -1 || errno != ENOENT) return 137;
        struct stat metadata;
        if (stat("/replacement", &metadata) != 0 || metadata.st_nlink != 1 || metadata.st_size != 3
            || (metadata.st_mode & 0777) != 0600 || metadata.st_mtim.tv_sec != 234567) return 138;
        int named = open("/replacement", O_RDONLY);
        if (named < 0) return 139;
        char named_bytes[3];
        if (pread(named, named_bytes, sizeof(named_bytes), 0) != (ssize_t)sizeof(named_bytes)
            || memcmp(named_bytes, "\0\0\0", sizeof(named_bytes)) != 0) return 140;
        return close(named) == 0 ? 0 : 141;
    }
    int create_tree = argc >= 2 && strcmp(argv[1], "create-tree") == 0;
    int verify_tree = argc >= 2 && strcmp(argv[1], "verify-tree") == 0;
    int verify_tree_moved = argc >= 2 && strcmp(argv[1], "verify-tree-moved") == 0;
    int verify_tree_removed = argc >= 2 && strcmp(argv[1], "verify-tree-removed") == 0;
    if (create_tree || verify_tree || verify_tree_moved || verify_tree_removed) {
        if (create_tree) {
            const struct timespec old_times[2] = {{1, 0}, {1, 0}};
            if (utimensat(AT_FDCWD, "/", old_times, 0) != 0) return 100;
            if (mkdir("/persist-tree", 0750) != 0) return 80;
            if (mkdir("/persist-tree/nested", 0700) != 0) return 81;
            if (utimensat(AT_FDCWD, "/persist-tree/nested", old_times, 0) != 0) return 101;
            int fd = open("/persist-tree/nested/file", O_CREAT | O_WRONLY, 0640);
            if (fd < 0) return 82;
            if (write(fd, "TREE", 4) != 4 || fsync(fd) != 0 || close(fd) != 0) return 83;
            return symlink("file", "/persist-tree/nested/link") == 0 ? 0 : 84;
        }
        if (verify_tree_removed) {
            struct stat missing;
            return lstat("/persist-moved", &missing) == -1 && errno == ENOENT ? 0 : 85;
        }
        const char *parent = verify_tree ? "/persist-tree" : "/persist-moved";
        const char *link_path = verify_tree ? "/persist-tree/nested/link" : "/persist-moved/nested/link";
        struct stat metadata;
        if (stat(parent, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_nlink != 3) return 86;
        if (stat("/", &metadata) != 0 || metadata.st_mtim.tv_sec <= 1) return 102;
        if (stat(verify_tree ? "/persist-tree/nested" : "/persist-moved/nested", &metadata) != 0 || metadata.st_mtim.tv_sec <= 1) return 103;
        int fd = open(link_path, O_RDONLY);
        if (fd < 0) return 87;
        char bytes[4];
        if (read(fd, bytes, sizeof(bytes)) != 4 || memcmp(bytes, "TREE", 4) != 0 || close(fd) != 0) return 88;
        if (verify_tree) return rename(parent, "/persist-moved") == 0 ? 0 : 89;
        if (unlink("/persist-moved/nested/link") != 0) return 90;
        if (unlink("/persist-moved/nested/file") != 0) return 91;
        if (rmdir("/persist-moved/nested") != 0) return 92;
        return rmdir("/persist-moved") == 0 ? 0 : 93;
    }
    int create_symlink = argc >= 2 && strcmp(argv[1], "create-symlink") == 0;
    int verify_symlink = argc >= 2 && strcmp(argv[1], "verify-symlink") == 0;
    int verify_symlink_moved = argc >= 2 && strcmp(argv[1], "verify-symlink-moved") == 0;
    if (create_symlink || verify_symlink || verify_symlink_moved) {
        if (create_symlink) return symlink("/alias", "/state-link") == 0 ? 0 : 73;
        const char *path = verify_symlink_moved ? "/state-link-moved" : "/state-link";
        char target[32];
        if (readlink(path, target, sizeof(target)) != 6 || memcmp(target, "/alias", 6) != 0) return 74;
        struct stat metadata;
        if (lstat(path, &metadata) != 0 || !S_ISLNK(metadata.st_mode)) return 75;
        int fd = open(path, O_RDONLY);
        if (fd < 0) return 76;
        if (close(fd) != 0) return 77;
        if (verify_symlink) return rename(path, "/state-link-moved") == 0 ? 0 : 78;
        return unlink(path) == 0 ? 0 : 79;
    }
    int create_file = argc >= 2 && strcmp(argv[1], "create-file") == 0;
    int verify_created = argc >= 2 && strcmp(argv[1], "verify-created") == 0;
    int verify_created_shrunk = argc >= 2 && strcmp(argv[1], "verify-created-shrunk") == 0;
    int verify_created_link = argc >= 2 && strcmp(argv[1], "verify-created-link") == 0;
    if (create_file || verify_created || verify_created_shrunk || verify_created_link) {
        off_t offset = 8LL * 1024 * 1024 * 1024 + 7;
        if (create_file) {
            int fd = open("/created", O_CREAT | O_EXCL | O_RDWR, 0640);
            if (fd < 0) return 53;
            if (pwrite(fd, "NEWW", 4, offset) != 4) return 54;
            if (fsync(fd) != 0) return 55;
            return close(fd) == 0 ? 0 : 56;
        }
        const char *path = verify_created_link ? "/created-link" : "/created";
        int fd = open(path, verify_created ? O_RDWR | O_APPEND : O_RDONLY);
        if (fd < 0) return 57;
        struct stat metadata;
        if (fstat(fd, &metadata) != 0) return 58;
        if (verify_created) {
            if (metadata.st_size != offset + 4) return 59;
            if (write(fd, "!", 1) != 1) return 60;
            if (fstat(fd, &metadata) != 0 || metadata.st_size != offset + 5) return 61;
            unsigned char bytes[5];
            if (pread(fd, bytes, sizeof(bytes), offset) != (ssize_t)sizeof(bytes)) return 62;
            if (memcmp(bytes, "NEWW!", sizeof(bytes)) != 0) return 63;
            if (ftruncate(fd, 3) != 0 || fsync(fd) != 0) return 64;
        } else {
            if (metadata.st_size != 3) return 65;
            unsigned char bytes[3];
            if (pread(fd, bytes, sizeof(bytes), 0) != (ssize_t)sizeof(bytes)) return 66;
            if (memcmp(bytes, "\0\0\0", sizeof(bytes)) != 0) return 67;
            if (verify_created_shrunk) {
                if (link("/created", "/created-link") != 0) return 68;
                if (rename("/created", "/created-moved") != 0) return 69;
                if (unlink("/created-moved") != 0) return 70;
            } else if (metadata.st_nlink != 1) {
                return 71;
            }
        }
        return close(fd) == 0 ? 0 : 72;
    }
    int rename_state = argc >= 2 && strcmp(argv[1], "rename-state") == 0;
    int verify_rename = argc >= 2 && strcmp(argv[1], "verify-rename") == 0;
    int unlink_state = argc >= 2 && strcmp(argv[1], "unlink-state") == 0;
    int verify_unlink = argc >= 2 && strcmp(argv[1], "verify-unlink") == 0;
    if (rename_state || verify_rename || unlink_state || verify_unlink) {
        if (rename_state) {
            if (link("/state", "/alias") != 0) return 45;
            if (rename("/state", "/moved") != 0) return 32;
        }
        if (verify_unlink) {
            if (open("/state", O_RDONLY) >= 0 || errno != ENOENT) return 33;
            if (open("/moved", O_RDONLY) >= 0 || errno != ENOENT) return 34;
            int alias = open("/alias", O_RDONLY);
            if (alias < 0) return 46;
            struct stat alias_metadata;
            if (fstat(alias, &alias_metadata) != 0 || alias_metadata.st_nlink != 1) return 47;
            return close(alias) == 0 ? 0 : 48;
        }
        if (open("/state", O_RDONLY) >= 0 || errno != ENOENT) return 35;
        int fd = open("/moved", O_RDONLY);
        if (fd < 0) return 36;
        off_t offset = 8LL * 1024 * 1024 * 1024 + 7;
        struct stat metadata;
        if (fstat(fd, &metadata) != 0 || metadata.st_size != offset + 4) return 37;
        int alias = open("/alias", O_RDONLY);
        if (alias < 0) return 49;
        struct stat alias_metadata;
        if (fstat(alias, &alias_metadata) != 0 || alias_metadata.st_ino != metadata.st_ino || alias_metadata.st_nlink != 2) return 50;
        if (close(alias) != 0) return 51;
        unsigned char bytes[4];
        if (pread(fd, bytes, sizeof(bytes), offset) != (ssize_t)sizeof(bytes)) return 38;
        if (memcmp(bytes, "\0\0\0\0", sizeof(bytes)) != 0) return 39;
        if (unlink_state) {
            if (unlink("/moved") != 0) return 40;
            if (open("/moved", O_RDONLY) >= 0 || errno != ENOENT) return 41;
            if (fstat(fd, &metadata) != 0 || metadata.st_nlink != 1) return 52;
            if (pread(fd, bytes, sizeof(bytes), offset) != (ssize_t)sizeof(bytes)) return 42;
            if (memcmp(bytes, "\0\0\0\0", sizeof(bytes)) != 0) return 43;
        }
        return close(fd) == 0 ? 0 : 44;
    }
    int resize = argc >= 2 && strcmp(argv[1], "resize") == 0;
    int verify_resize = argc >= 2 && strcmp(argv[1], "verify-resize") == 0;
    int verify_zero = argc >= 2 && strcmp(argv[1], "verify-zero") == 0;
    if (resize || verify_resize || verify_zero) {
        int fd = open("/state", O_RDWR | (resize ? O_TRUNC : 0));
        if (fd < 0) return 19;
        off_t offset = 8LL * 1024 * 1024 * 1024 + 7;
        if (resize) {
            struct stat metadata;
            if (fstat(fd, &metadata) != 0 || metadata.st_size != 0) return 20;
            if (pwrite(fd, "GROW", 4, offset) != 4) return 21;
        } else {
            struct stat metadata;
            if (fstat(fd, &metadata) != 0 || metadata.st_size != offset + 4) return 22;
            unsigned char prefix[8];
            if (pread(fd, prefix, sizeof(prefix), 0) != (ssize_t)sizeof(prefix)) return 30;
            if (memcmp(prefix, "\0\0\0\0\0\0\0\0", sizeof(prefix)) != 0) return 31;
            unsigned char bytes[4];
            if (pread(fd, bytes, sizeof(bytes), offset) != (ssize_t)sizeof(bytes)) return 23;
            if (verify_resize && memcmp(bytes, "GROW", 4) != 0) return 24;
            if (verify_zero && memcmp(bytes, "\0\0\0\0", 4) != 0) return 25;
            if (verify_resize) {
                if (ftruncate(fd, 2) != 0) return 26;
                if (ftruncate(fd, offset + 4) != 0) return 27;
            }
        }
        if (fsync(fd) != 0) return 28;
        return close(fd) == 0 ? 0 : 29;
    }
    int orphan_many = argc >= 2 && strcmp(argv[1], "orphan-many") == 0;
    int open_orphan_many = argc >= 2 && strcmp(argv[1], "open-orphan-many") == 0;
    int verify_orphan_many = argc >= 2 && strcmp(argv[1], "verify-orphan-many") == 0;
    int orphan = -1;
    if (orphan_many || open_orphan_many) {
        orphan = open("/orphan", O_CREAT | O_EXCL | O_RDWR, 0640);
        if (orphan < 0) return 104;
        if ((open_orphan_many
                ? pwrite(orphan, "HELD", 4, 0) != 4
                : pwrite(orphan, large_write, 4096, 0) != 4096)
            || fsync(orphan) != 0) return 105;
        if (unlink("/orphan") != 0) return 106;
        struct stat orphan_metadata;
        if (fstat(orphan, &orphan_metadata) != 0 || orphan_metadata.st_nlink != 0) return 117;
        if (orphan_many && close(orphan) != 0) return 118;
    }
    if (verify_orphan_many) {
        struct stat missing;
        if (stat("/orphan", &missing) != -1 || errno != ENOENT) return 107;
    }
    int verify_many = argc >= 2 && (strcmp(argv[1], "verify-many") == 0 || verify_orphan_many);
    int write_many = argc >= 2 && (strcmp(argv[1], "many") == 0 || orphan_many || open_orphan_many);
    if (verify_many || write_many) {
        int large_fd = open("/large", O_RDWR);
        if (large_fd < 0) return 12;
        struct stat metadata;
        if (fstat(large_fd, &metadata) != 0 || metadata.st_size < 32 * 1024 * 1024) return 13;
        for (int chunk = 0; chunk < 16; chunk++) {
            for (size_t index = 0; index < sizeof(large_write); index++) {
                large_write[index] = (unsigned char)((index / 4096) ^ index ^ chunk ^ 0x5a);
            }
            off_t offset = (off_t)chunk * (off_t)sizeof(large_write);
            if (verify_many) {
                for (size_t index = 0; index < sizeof(large_write); index += sizeof(verify_buffer)) {
                    if (pread(large_fd, verify_buffer, sizeof(verify_buffer), offset + (off_t)index) != (ssize_t)sizeof(verify_buffer)) return 14;
                    if (memcmp(verify_buffer, large_write + index, sizeof(verify_buffer)) != 0) return 15;
                }
            } else if (pwrite(large_fd, large_write, sizeof(large_write), offset) != (ssize_t)sizeof(large_write)) {
                return 16;
            }
        }
        if (!verify_many && fsync(large_fd) != 0) return 17;
        if (open_orphan_many) {
            int released = 0;
            for (int attempt = 0; attempt < 600; attempt++) {
                int marker = open("/release", O_RDONLY);
                if (marker >= 0) {
                    if (close(marker) != 0) return 119;
                    released = 1;
                    break;
                }
                if (errno != ENOENT) return 120;
                const struct timespec pause = {0, 100 * 1000 * 1000};
                if (nanosleep(&pause, NULL) != 0) return 121;
            }
            if (!released) return 122;
            char held[4];
            struct stat orphan_metadata;
            if (pread(orphan, held, sizeof(held), 0) != (ssize_t)sizeof(held) || memcmp(held, "HELD", sizeof(held)) != 0) return 123;
            if (fstat(orphan, &orphan_metadata) != 0 || orphan_metadata.st_nlink != 0) return 124;
            if (close(orphan) != 0 || unlink("/release") != 0) return 125;
        }
        return close(large_fd) == 0 ? 0 : 18;
    }
    int verify_tail = argc >= 2 && strcmp(argv[1], "verify-large-tail") == 0;
    int write_tail = argc >= 2 && strcmp(argv[1], "large-tail") == 0;
    if (verify_tail || write_tail || (argc >= 2 && strcmp(argv[1], "large") == 0)) {
        int large_fd = open("/large", O_RDWR);
        if (large_fd < 0) return 5;
        off_t offset = 13;
        if (verify_tail || write_tail) {
            struct stat metadata;
            if (fstat(large_fd, &metadata) != 0 || metadata.st_size < (off_t)sizeof(large_write) + 13) return 9;
            offset = metadata.st_size - (off_t)sizeof(large_write) - 13;
        }
        for (size_t index = 0; index < sizeof(large_write); index++) {
            large_write[index] = (unsigned char)((index / 4096) ^ index);
        }
        if (verify_tail) {
            for (size_t index = 0; index < sizeof(large_write); index += sizeof(verify_buffer)) {
                if (pread(large_fd, verify_buffer, sizeof(verify_buffer), offset + (off_t)index) != (ssize_t)sizeof(verify_buffer)) return 10;
                if (memcmp(verify_buffer, large_write + index, sizeof(verify_buffer)) != 0) return 11;
            }
        } else {
            if (pwrite(large_fd, large_write, sizeof(large_write), offset) != (ssize_t)sizeof(large_write)) return 6;
            if (fsync(large_fd) != 0) return 7;
        }
        return close(large_fd) == 0 ? 0 : 8;
    }
    int fd = open("/state", O_RDWR);
    if (fd < 0) return 1;
    if (pwrite(fd, "XY", 2, 0) != 2) return 2;
    if ((argc < 2 || argv[1][0] != 'u') && fsync(fd) != 0) return 3;
    return close(fd) == 0 ? 0 : 4;
}
