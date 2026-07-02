/*
 * dri-smoke — open /dev/dri/renderD128, exercise the v1 GBM dumb-buffer
 * surface end-to-end:
 *
 *   1. DRM_IOCTL_VERSION
 *   2. DRM_IOCTL_GET_CAP(DRM_CAP_DUMB_BUFFER)
 *   3. DRM_IOCTL_GET_CAP(DRM_CAP_PRIME)
 *   4. DRM_IOCTL_MODE_CREATE_DUMB (640x400, bpp=32)
 *   5. DRM_IOCTL_MODE_MAP_DUMB
 *   6. mmap at the returned offset
 *   7. Write a known pixel pattern into the mapped region:
 *        pixel(r, c) = 0xFF000000 | (r << 16) | c
 *   8. DRM_IOCTL_PRIME_HANDLE_TO_FD (export bo as prime fd)
 *
 * Each step's errno path prints a labelled "FAIL: …" and exits 1.
 * On success the program prints "ok\n" and pauses; the test harness
 * inspects host-side state (registry contents, bo binding range in
 * process Memory SAB), then SIGTERMs the program.
 *
 * Used by host/test/dri-smoke.test.ts.
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

/* DRM ioctl numbers — bit-identical with Linux's wasm32 / ilp32 layout.
 * Mirrored from crates/shared/src/lib.rs::dri.
 */
#define DRM_IOCTL_VERSION            0xc0246400u
#define DRM_IOCTL_GET_CAP            0xc010640cu
#define DRM_IOCTL_MODE_CREATE_DUMB   0xc02064b2u
#define DRM_IOCTL_MODE_MAP_DUMB      0xc01064b3u
#define DRM_IOCTL_PRIME_HANDLE_TO_FD 0xc00c642du

#define DRM_CAP_DUMB_BUFFER 0x1u
#define DRM_CAP_PRIME       0x5u

struct drm_version {
    int32_t version_major;
    int32_t version_minor;
    int32_t version_patchlevel;
    uint32_t name_len;
    uint32_t name_ptr;
    uint32_t date_len;
    uint32_t date_ptr;
    uint32_t desc_len;
    uint32_t desc_ptr;
};

struct drm_get_cap {
    uint64_t capability;
    uint64_t value;
};

struct drm_mode_create_dumb {
    uint32_t height;
    uint32_t width;
    uint32_t bpp;
    uint32_t flags;
    uint32_t handle;
    uint32_t pitch;
    uint64_t size;
};

struct drm_mode_map_dumb {
    uint32_t handle;
    uint32_t pad;
    uint64_t offset;
};

struct drm_prime_handle {
    uint32_t handle;
    uint32_t flags;
    int32_t fd;
};

#define FAIL(msg) do { \
    write(2, "FAIL: " msg "\n", sizeof("FAIL: " msg "\n") - 1); \
    return 1; \
} while (0)

int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR);
    if (fd < 0) { perror("open /dev/dri/renderD128"); return 1; }

    /* 1. VERSION */
    struct drm_version v;
    memset(&v, 0, sizeof(v));
    if (ioctl(fd, DRM_IOCTL_VERSION, &v) < 0) {
        perror("DRM_IOCTL_VERSION"); return 1;
    }
    if (v.version_major != 1) FAIL("VERSION major != 1");

    /* 2. GET_CAP(DUMB_BUFFER) — expect value=1 */
    struct drm_get_cap cap;
    cap.capability = DRM_CAP_DUMB_BUFFER;
    cap.value = 0;
    if (ioctl(fd, DRM_IOCTL_GET_CAP, &cap) < 0) {
        perror("DRM_IOCTL_GET_CAP DUMB_BUFFER"); return 1;
    }
    if (cap.value != 1) FAIL("DUMB_BUFFER cap not 1");

    /* 3. GET_CAP(PRIME) — expect IMPORT|EXPORT (=3) */
    cap.capability = DRM_CAP_PRIME;
    cap.value = 0;
    if (ioctl(fd, DRM_IOCTL_GET_CAP, &cap) < 0) {
        perror("DRM_IOCTL_GET_CAP PRIME"); return 1;
    }
    if (cap.value != 3) FAIL("PRIME cap not IMPORT|EXPORT");

    /* 4. CREATE_DUMB 640x400 ARGB8888 */
    struct drm_mode_create_dumb cd;
    memset(&cd, 0, sizeof(cd));
    cd.width = 640;
    cd.height = 400;
    cd.bpp = 32;
    if (ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd) < 0) {
        perror("DRM_IOCTL_MODE_CREATE_DUMB"); return 1;
    }
    if (cd.handle == 0) FAIL("CREATE_DUMB returned handle=0");
    if (cd.pitch != 640 * 4) FAIL("CREATE_DUMB pitch != 640*4");
    if (cd.size != (uint64_t)640 * 400 * 4) FAIL("CREATE_DUMB size mismatch");

    /* 5. MAP_DUMB → mmap offset */
    struct drm_mode_map_dumb md;
    memset(&md, 0, sizeof(md));
    md.handle = cd.handle;
    if (ioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md) < 0) {
        perror("DRM_IOCTL_MODE_MAP_DUMB"); return 1;
    }
    if (md.offset == 0) FAIL("MAP_DUMB returned offset=0");

    /* 6. mmap */
    uint32_t* px = mmap(NULL, cd.size, PROT_READ | PROT_WRITE,
                        MAP_SHARED, fd, (off_t)md.offset);
    if (px == MAP_FAILED) { perror("mmap"); return 1; }

    /* 7. Write the pixel pattern */
    for (uint32_t r = 0; r < cd.height; r++) {
        for (uint32_t c = 0; c < cd.width; c++) {
            px[r * cd.width + c] =
                0xFF000000u | ((uint32_t)r << 16) | (uint32_t)c;
        }
    }

    /* 8. PRIME export */
    struct drm_prime_handle ph;
    memset(&ph, 0, sizeof(ph));
    ph.handle = cd.handle;
    ph.flags = 0;
    if (ioctl(fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, &ph) < 0) {
        perror("DRM_IOCTL_PRIME_HANDLE_TO_FD"); return 1;
    }
    if (ph.fd < 3) FAIL("PRIME_HANDLE_TO_FD returned bogus fd");

    write(1, "ok\n", 3);
    pause();
    return 0;
}
