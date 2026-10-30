#define _GNU_SOURCE
#include <ctype.h>
#include <fcntl.h>
#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int trusted_path(const char *path, int directory) {
    struct stat metadata;
    if (lstat(path, &metadata) != 0) return 0;
    return metadata.st_uid == 0 && (metadata.st_mode & 0022) == 0 &&
        (directory ? S_ISDIR(metadata.st_mode) : S_ISREG(metadata.st_mode));
}

int main(int argc, char **argv) {
    int listing = argc == 2 && (!strcmp(argv[1], "list") || !strcmp(argv[1], "inspect"));
    if (!listing && argc != 3) {
        fputs("Usage: kandelo-service list|inspect | start|stop|enable|disable|status activity\n", stderr);
        return 2;
    }
    if (!listing && strcmp(argv[1], "start") && strcmp(argv[1], "stop") &&
        strcmp(argv[1], "enable") && strcmp(argv[1], "disable") &&
        strcmp(argv[1], "status")) return 2;
    if (!listing) {
        size_t length = strlen(argv[2]);
        if (!length || length > 64 || argv[2][0] < 'a' || argv[2][0] > 'z') return 2;
        for (size_t index = 0; index < length; index++) {
            unsigned char character = (unsigned char) argv[2][index];
            if (!(character >= 'a' && character <= 'z') && !isdigit(character) && character != '-') return 2;
        }
    }
    uid_t caller = getuid();
    struct passwd *account = getpwnam("maker");
    if (geteuid() != 0 || (caller != 0 && (!account || account->pw_uid != caller))) {
        fputs("Only the machine's maker account may control its service activities\n", stderr);
        return 1;
    }
    const char *directories[] = { "/", "/usr", "/usr/local", "/usr/local/libexec", "/etc", "/etc/dinit.d", "/etc/kandelo", "/run", "/run/kandelo-services", NULL };
    for (size_t index = 0; directories[index]; index++) {
        if (!trusted_path(directories[index], 1)) {
            fputs("Service control requires root-owned, non-writable configuration paths\n", stderr);
            return 1;
        }
    }
    if (!trusted_path("/usr/local/libexec/kandelo-service", 0)) return 1;
    if (setgroups(0, NULL) || setresgid(0, 0, 0) || setresuid(0, 0, 0)) {
        perror("kandelo-service: credentials");
        return 1;
    }
    if (!listing && strcmp(argv[1], "status")) {
        int lock = open("/run/kandelo-services/activity.lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
        struct flock operation = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0 };
        if (lock < 0 || fcntl(lock, F_SETLK, &operation) != 0) {
            fputs("Another service transition is in progress or its lock cannot be opened\n", stderr);
            return 1;
        }
    }
    char *command[] = { "/bin/sh", "/usr/local/libexec/kandelo-service", argv[1], argv[2], NULL };
    char *environment[] = { "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin", "HOME=/root", "USER=root", "LOGNAME=root", "TMPDIR=/tmp", NULL };
    execve(command[0], command, environment);
    perror("kandelo-service: exec");
    return 1;
}
