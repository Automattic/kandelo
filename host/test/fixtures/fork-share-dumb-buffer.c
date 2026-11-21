#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define DRM_IOCTL_MODE_CREATE_DUMB 0xc02064b2u
#define DRM_IOCTL_MODE_MAP_DUMB    0xc01064b3u
#define W 64
#define H 64
#define N (W * H)

struct drm_mode_create_dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct drm_mode_map_dumb { uint32_t handle, pad; uint64_t offset; };

static uint32_t *map(int fd, uint32_t handle, size_t size) {
    struct drm_mode_map_dumb md = { .handle = handle };
    if (ioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md) < 0) return MAP_FAILED;
    return mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, (off_t)md.offset);
}

static void wait_byte(int fd) {
    struct pollfd p = { .fd = fd, .events = POLLIN };
    char byte;
    while (poll(&p, 1, -1) != 1) {}
    read(fd, &byte, 1);
}

int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR);
    struct drm_mode_create_dumb cd = { .width = W, .height = H, .bpp = 32 };
    if (fd < 0 || ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd) < 0) { perror("create"); return 3; }
    uint32_t *px = map(fd, cd.handle, cd.size);
    if (px == MAP_FAILED) { perror("mmap"); return 4; }
    static uint32_t heap[N];
    for (int i = 0; i < N; i++) { px[i] = 0xA0000000u | i; heap[i] = i; }

    int to_parent[2], to_child[2];
    if (pipe(to_parent) || pipe(to_child)) return 5;
    pid_t child = fork();
    if (child == 0) {
        int bad = 0;
        for (int i = 0; i < N; i++) if (px[i] != (0xA0000000u | i) || heap[i] != (uint32_t)i) bad |= 1;
        for (int i = 0; i < N / 2; i++) { px[i] = 0xB0000000u | i; heap[i] = 7; }
        write(to_parent[1], "x", 1);
        wait_byte(to_child[0]);
        for (int i = 0; i < N / 2; i++) if (px[i] != (0xB0000000u | i)) bad |= 2;
        for (int i = N / 2; i < N; i++) if (px[i] != (0xC0000000u | i)) bad |= 4;
        _exit(bad ? bad : 42);
    }
    int failed = 0;
    for (int i = N / 2; i < N; i++) { px[i] = 0xC0000000u | i; heap[i] = 9; }
    wait_byte(to_parent[0]);
    for (int i = 0; i < N / 2; i++) if (px[i] != (0xB0000000u | i) || heap[i] != (uint32_t)i) failed |= 1;
    for (int i = N / 2; i < N; i++) if (px[i] != (0xC0000000u | i)) failed |= 2;
    write(to_child[1], "x", 1);
    int status = -1;
    int code = waitpid(child, &status, 0) == child && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    if (code != 42) failed |= 4;
    uint32_t *alias = map(fd, cd.handle, cd.size);
    if (alias == MAP_FAILED) failed |= 8;
    else for (int i = 0; i < N; i++) if (alias[i] != ((i < N / 2 ? 0xB0000000u : 0xC0000000u) | i)) failed |= 16;
    printf("parent child=%d failed=%d\n", code, failed);
    return failed;
}
