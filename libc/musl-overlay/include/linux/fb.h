/*
 * Minimal <linux/fb.h> for wasm-posix-kernel.
 *
 * The real Linux header carries a lot of Linux-specific details
 * (acceleration, vt-switch, etc.) we don't implement and don't expose
 * to user-space programs. This subset matches the structures and ioctls
 * that the kernel marshals via crates/shared/src/lib.rs::fbdev.
 *
 * Programs using these structs and ioctls work unmodified against our
 * `/dev/fb0` device. Field offsets, sizes, and ioctl numbers
 * mirror upstream Linux so binary compatibility is preserved.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_FB_H
#define _LINUX_FB_H 1

#include <stdint.h>

typedef uint8_t  __u8;
typedef uint16_t __u16;
typedef uint32_t __u32;
typedef uint64_t __u64;

/* Variable-screen-info ioctl numbers (subset; the kernel returns ENOTTY
 * for anything not on this list). */
#define FBIOGET_VSCREENINFO 0x4600
#define FBIOPUT_VSCREENINFO 0x4601
#define FBIOGET_FSCREENINFO 0x4602
#define FBIOGETCMAP         0x4604
#define FBIOPUTCMAP         0x4605
#define FBIOPAN_DISPLAY     0x4606
#define FBIOBLANK           0x4611
#define FBIO_WAITFORVSYNC   0x40044620

#define FB_BLANK_UNBLANK    0
#define FB_BLANK_NORMAL     1
#define FB_BLANK_VSYNC_SUSPEND 2
#define FB_BLANK_HSYNC_SUSPEND 3
#define FB_BLANK_POWERDOWN  4

/* fb_fix_screeninfo.type */
#define FB_TYPE_PACKED_PIXELS      0
#define FB_TYPE_PLANES             1
#define FB_TYPE_INTERLEAVED_PLANES 2
#define FB_TYPE_TEXT               3
#define FB_TYPE_VGA_PLANES         4
#define FB_TYPE_FOURCC             5

/* fb_fix_screeninfo.visual */
#define FB_VISUAL_MONO01              0
#define FB_VISUAL_MONO10              1
#define FB_VISUAL_TRUECOLOR           2
#define FB_VISUAL_PSEUDOCOLOR         3
#define FB_VISUAL_DIRECTCOLOR         4
#define FB_VISUAL_STATIC_PSEUDOCOLOR  5
#define FB_VISUAL_FOURCC              6

/* fb_var_screeninfo.activate */
#define FB_ACTIVATE_NOW           0
#define FB_ACTIVATE_NXTOPEN       1
#define FB_ACTIVATE_TEST          2
#define FB_ACTIVATE_MASK          15
#define FB_ACTIVATE_VBL           16
#define FB_CHANGE_CMAP_VBL        32
#define FB_ACTIVATE_ALL           64
#define FB_ACTIVATE_FORCE         128
#define FB_ACTIVATE_INV_MODE      256

/* fb_var_screeninfo.sync */
#define FB_SYNC_HOR_HIGH_ACT      1
#define FB_SYNC_VERT_HIGH_ACT     2
#define FB_SYNC_EXT               4
#define FB_SYNC_COMP_HIGH_ACT     8
#define FB_SYNC_BROADCAST         16
#define FB_SYNC_ON_GREEN          32

struct fb_bitfield {
    uint32_t offset;
    uint32_t length;
    uint32_t msb_right;
};

struct fb_var_screeninfo {
    uint32_t xres;
    uint32_t yres;
    uint32_t xres_virtual;
    uint32_t yres_virtual;
    uint32_t xoffset;
    uint32_t yoffset;
    uint32_t bits_per_pixel;
    uint32_t grayscale;
    struct fb_bitfield red;
    struct fb_bitfield green;
    struct fb_bitfield blue;
    struct fb_bitfield transp;
    uint32_t nonstd;
    uint32_t activate;
    uint32_t height;
    uint32_t width;
    uint32_t accel_flags;
    uint32_t pixclock;
    uint32_t left_margin;
    uint32_t right_margin;
    uint32_t upper_margin;
    uint32_t lower_margin;
    uint32_t hsync_len;
    uint32_t vsync_len;
    uint32_t sync;
    uint32_t vmode;
    uint32_t rotate;
    uint32_t colorspace;
    uint32_t reserved[4];
};

struct fb_cmap {
    uint32_t start;
    uint32_t len;
    uint16_t *red;
    uint16_t *green;
    uint16_t *blue;
    uint16_t *transp;
};

struct fb_fix_screeninfo {
    char     id[16];
    uint32_t smem_start;     /* address-shaped on real Linux; 0 here */
    uint32_t smem_len;
    uint32_t type;
    uint32_t type_aux;
    uint32_t visual;
    uint16_t xpanstep;
    uint16_t ypanstep;
    uint16_t ywrapstep;
    uint16_t _pad;           /* 16-bit padding before line_length */
    uint32_t line_length;
    uint32_t mmio_start;     /* always 0 here */
    uint32_t mmio_len;
    uint32_t accel;
    uint16_t capabilities;
    uint16_t reserved[3];
    uint8_t  _pad_to_80[12]; /* aligns to upstream's 80-byte size */
};

#endif /* _LINUX_FB_H */
