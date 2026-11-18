#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static volatile unsigned char old_image[4096];
int main(int argc, char **argv) {
    if (argc != 3) return 10;
    const int expected = !strcmp(argv[2], "callback") ? EACCES : ENOMEM;
    const pid_t pid = getpid();
    int fd = open("/tmp/exec-retained", O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (fd < 0) return 11;
    for (unsigned i = 0; i < sizeof old_image; ++i) old_image[i] = (unsigned char)(i * 17 + 3);
    for (int attempt = 0; attempt < 16; ++attempt) {
        errno = 0;
        char *const replacement_argv[] = {"replacement", NULL};
        char *const replacement_env[] = {NULL};
        int result = attempt % 2
            ? syscall(SYS_execveat, AT_FDCWD, "/bin/grouped-exec-target", replacement_argv, replacement_env, 0)
            : execve("/bin/grouped-exec-target", replacement_argv, replacement_env);
        if (result != -1 || errno != expected) {
            fprintf(stderr, "exec failure result=%d errno=%d expected=%d\n", result, errno, expected); return 12;
        }
        if (getpid() != pid || (fcntl(fd, F_GETFD) & FD_CLOEXEC) == 0) return 13;
        for (unsigned i = 0; i < sizeof old_image; ++i) if (old_image[i] != (unsigned char)(i * 17 + 3)) return 14;
        if (write(fd, "x", 1) != 1) return 15;
        printf("exec-returned %d\n", attempt + 1);
        fflush(stdout);
        char ack;
        if (read(0, &ack, 1) != 1 || ack != 'k') return 17;
    }
    if (lseek(fd, 0, SEEK_END) != 16) return 16;
    close(fd);
    printf("grouped-sdk-exec-rollback PASS 16 %s\n", argv[2]);
    return 0;
}
