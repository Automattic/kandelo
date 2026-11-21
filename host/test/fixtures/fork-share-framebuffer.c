#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    int fd = open("/dev/fb0", O_RDWR);
    struct fb_var_screeninfo v;
    struct fb_fix_screeninfo f;
    if (fd < 0 || ioctl(fd, FBIOGET_VSCREENINFO, &v) < 0 || ioctl(fd, FBIOGET_FSCREENINFO, &f) < 0) { perror("fb0"); return 3; }
    uint32_t *px = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return 4; }
    uint32_t n = v.xres * v.yres;
    for (uint32_t i = 0; i < n; i++) px[i] = 0xFF111111u;

    int go[2];
    if (pipe(go)) return 5;
    pid_t child = fork();
    if (child == 0) {
        int bad = 0;
        char byte;
        read(go[0], &byte, 1);
        for (uint32_t i = 0; i < n; i++) if (px[i] != 0xFF111111u) bad = 1;
        for (uint32_t i = 0; i < n; i++) px[i] = 0xFF333333u;
        _exit(bad ? 1 : 42);
    }
    for (uint32_t i = 0; i < n; i++) px[i] = 0xFF222222u;
    write(go[1], "x", 1);
    int status = -1;
    int code = waitpid(child, &status, 0) == child && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    int failed = code != 42;
    for (uint32_t i = 0; i < n; i++) if (px[i] != 0xFF222222u) failed |= 2;
    printf("parent child=%d failed=%d\n", code, failed);
    fflush(stdout);
    usleep(300000);
    return failed;
}
