/*
 * Subset of <sound/asound.h> matching what crates/shared/src/lib.rs::audio
 * marshals on **wasm32** (musl `unsigned long` = 4 B, `__SND_STRUCT_TIME64`
 * defined). Mirrors upstream alsa-lib UAPI for the fields kandelo's v1
 * ALSA surface implements:
 *
 *   ioctls    PVERSION INFO HW_REFINE HW_PARAMS HW_FREE SW_PARAMS STATUS
 *             PREPARE START DROP PAUSE WRITEI_FRAMES (PCM)
 *             PVERSION CARD_INFO ELEM_LIST (control)
 *
 *   structs (wasm32 sizes)
 *             snd_pcm_hw_params (604B) snd_pcm_sw_params (104B)
 *             snd_pcm_status (128B) snd_pcm_info (288B)
 *             snd_pcm_mmap_status (56B) snd_pcm_mmap_control (12B)
 *             snd_xferi (12B) snd_ctl_card_info (256B)
 *             snd_ctl_elem_id (64B) snd_ctl_elem_list (80B)
 *
 * NOTE: at sysroot-build time, `scripts/build-musl.sh` rm -rf's
 * `$SYSROOT/include/sound/` and symlinks alsa-lib's vendored upstream
 * UAPI in its place. This in-tree header is therefore not what
 * user-space programs compile against; it's an authoring reference
 * documenting which fields the kernel marshals. The layouts here must
 * match alsa-lib's upstream `<sound/uapi/asound.h>` when that file is
 * compiled with `wasm32posix-cc`.
 *
 * Capture, the sequencer, the timer, mixers beyond CARD_INFO/ELEM_LIST,
 * FLOAT_LE/S32_LE formats, and async signal delivery are all omitted —
 * the v1 plan in docs/plans/2026-06-22-dri-alsa-plan.md is playback-only,
 * S16_LE-only, host-driven cadence via kernel_audio_period_tick.
 */
#ifndef _SOUND_ASOUND_H
#define _SOUND_ASOUND_H

#include <stdint.h>
#include <sys/ioctl.h>

#ifdef __cplusplus
extern "C" {
#endif

/* wasm32 musl: `unsigned long` = 4 B, so snd_pcm_uframes_t = u32. */
typedef uint32_t snd_pcm_uframes_t;
typedef int32_t  snd_pcm_sframes_t;

/* --- PCM state ------------------------------------------------------- */

#define SNDRV_PCM_STATE_OPEN      0
#define SNDRV_PCM_STATE_SETUP     1
#define SNDRV_PCM_STATE_PREPARED  2
#define SNDRV_PCM_STATE_RUNNING   3
#define SNDRV_PCM_STATE_XRUN      4
#define SNDRV_PCM_STATE_DRAINING  5
#define SNDRV_PCM_STATE_PAUSED    6
#define SNDRV_PCM_STATE_SUSPENDED 7
#define SNDRV_PCM_STATE_DISCONNECTED 8

/* --- PCM format (v1 ships S16_LE only; the others are listed for ABI
 *     symmetry with the kernel-side `audio::` module). ----------------- */

#define SNDRV_PCM_FORMAT_S8        0
#define SNDRV_PCM_FORMAT_U8        1
#define SNDRV_PCM_FORMAT_S16_LE    2
#define SNDRV_PCM_FORMAT_S16_BE    3
#define SNDRV_PCM_FORMAT_U16_LE    4
#define SNDRV_PCM_FORMAT_U16_BE    5
#define SNDRV_PCM_FORMAT_S24_LE    6
#define SNDRV_PCM_FORMAT_S24_BE    7
#define SNDRV_PCM_FORMAT_U24_LE    8
#define SNDRV_PCM_FORMAT_U24_BE    9
#define SNDRV_PCM_FORMAT_S32_LE   10
#define SNDRV_PCM_FORMAT_S32_BE   11
#define SNDRV_PCM_FORMAT_U32_LE   12
#define SNDRV_PCM_FORMAT_U32_BE   13
#define SNDRV_PCM_FORMAT_FLOAT_LE 14

#define SNDRV_PCM_SUBFORMAT_STD   0

/* --- PCM access ------------------------------------------------------- */

#define SNDRV_PCM_ACCESS_MMAP_INTERLEAVED    0
#define SNDRV_PCM_ACCESS_MMAP_NONINTERLEAVED 1
#define SNDRV_PCM_ACCESS_MMAP_COMPLEX        2
#define SNDRV_PCM_ACCESS_RW_INTERLEAVED      3
#define SNDRV_PCM_ACCESS_RW_NONINTERLEAVED   4

/* --- PCM stream direction -------------------------------------------- */

#define SNDRV_PCM_STREAM_PLAYBACK 0
#define SNDRV_PCM_STREAM_CAPTURE  1

/* --- snd_pcm_hw_params parameter indices ----------------------------- *
 * The Linux UAPI splits hw_params into three masks + thirteen intervals,
 * indexed by these enums. Kandelo's kernel reads PARAM_ACCESS (0),
 * PARAM_FORMAT (1), PARAM_SUBFORMAT (2) from masks[] and PARAM_CHANNELS
 * (2), PARAM_RATE (3), PARAM_PERIOD_SIZE (5), PARAM_PERIODS (7),
 * PARAM_BUFFER_SIZE (9) from intervals[]. See refine_hw_params() in
 * crates/kernel/src/audio/pcm_ioctl.rs.
 */

#define SNDRV_PCM_HW_PARAM_ACCESS       0
#define SNDRV_PCM_HW_PARAM_FORMAT       1
#define SNDRV_PCM_HW_PARAM_SUBFORMAT    2
#define SNDRV_PCM_HW_PARAM_FIRST_MASK   SNDRV_PCM_HW_PARAM_ACCESS
#define SNDRV_PCM_HW_PARAM_LAST_MASK    SNDRV_PCM_HW_PARAM_SUBFORMAT

#define SNDRV_PCM_HW_PARAM_SAMPLE_BITS  8
#define SNDRV_PCM_HW_PARAM_FRAME_BITS   9
#define SNDRV_PCM_HW_PARAM_CHANNELS    10
#define SNDRV_PCM_HW_PARAM_RATE        11
#define SNDRV_PCM_HW_PARAM_PERIOD_TIME 12
#define SNDRV_PCM_HW_PARAM_PERIOD_SIZE 13
#define SNDRV_PCM_HW_PARAM_PERIOD_BYTES 14
#define SNDRV_PCM_HW_PARAM_PERIODS     15
#define SNDRV_PCM_HW_PARAM_BUFFER_TIME 16
#define SNDRV_PCM_HW_PARAM_BUFFER_SIZE 17
#define SNDRV_PCM_HW_PARAM_BUFFER_BYTES 18
#define SNDRV_PCM_HW_PARAM_TICK_TIME   19
#define SNDRV_PCM_HW_PARAM_FIRST_INTERVAL SNDRV_PCM_HW_PARAM_SAMPLE_BITS
#define SNDRV_PCM_HW_PARAM_LAST_INTERVAL SNDRV_PCM_HW_PARAM_TICK_TIME

/* The kernel indexes masks[] and intervals[] starting at PARAM_ACCESS=0
 * and PARAM_SAMPLE_BITS=0 respectively, so userspace helpers subtract
 * the first-* offsets when picking a slot. */
#define WPK_ALSA_MASK_INDEX(name)     ((name) - SNDRV_PCM_HW_PARAM_FIRST_MASK)
#define WPK_ALSA_INTERVAL_INDEX(name) ((name) - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL)

/* --- mmap page offsets (passed as the mmap(2) offset arg) ------------ *
 * v1 mmap policy (per handoff-39): direct mmap(STATUS|CONTROL) returns
 * anonymous user pages with no kernel-side mirror. WRITEI_FRAMES is the
 * only data path. mmap-of-DATA is a future API surface; v1 demos must
 * not rely on it. */

#define SNDRV_PCM_MMAP_OFFSET_DATA    0x00000000UL
#define SNDRV_PCM_MMAP_OFFSET_STATUS  0x80000000UL
#define SNDRV_PCM_MMAP_OFFSET_CONTROL 0x81000000UL

/* --- snd_interval ----------------------------------------------------- *
 * Linux packs four flag bits (openmin / openmax / integer / empty) into
 * a trailing u32. We keep them as a plain u32 here so the struct size
 * matches the kernel-side WpkSndInterval (12B) byte-for-byte. */

struct snd_interval {
    uint32_t min;
    uint32_t max;
    /* bit 0 = openmin, 1 = openmax, 2 = integer, 3 = empty */
    uint32_t flags;
};

/* --- snd_pcm_hw_params (604 bytes on wasm32) ------------------------- */

struct snd_pcm_hw_params {
    uint32_t            flags;
    uint32_t            masks[64];           /* 8 snd_mask × u32[8] */
    struct snd_interval intervals[21];       /* 12 active + 9 reserved */
    uint32_t            rmask;
    uint32_t            cmask;
    uint32_t            info;
    uint32_t            msbits;
    uint32_t            rate_num;
    uint32_t            rate_den;
    uint32_t            fifo_size;           /* snd_pcm_uframes_t */
    uint8_t             reserved[64];
};

/* --- snd_pcm_sw_params (104 bytes on wasm32) ------------------------- */

struct snd_pcm_sw_params {
    uint32_t tstamp_mode;
    uint32_t period_step;
    uint32_t sleep_min;
    uint32_t avail_min;                 /* snd_pcm_uframes_t */
    uint32_t xfer_align;
    uint32_t start_threshold;
    uint32_t stop_threshold;
    uint32_t silence_threshold;
    uint32_t silence_size;
    uint32_t boundary;
    uint32_t proto;
    uint32_t tstamp_type;
    uint8_t  reserved[56];
};

/* --- snd_pcm_status (128 bytes on wasm32) ---------------------------- *
 * timespec on wasm32 musl: { int64_t tv_sec; int32_t tv_nsec; } + 4 B
 * trailing pad so the next i64 field is 8-aligned (`__alignof__(long
 * long) = 8`). Each timespec slot is therefore i64 sec + i32 nsec +
 * 4 B pad = 16 B. */

struct snd_pcm_status {
    uint32_t state;
    uint32_t _pad1;                     /* __time_pad */
    int64_t  trigger_tstamp_sec;
    int32_t  trigger_tstamp_nsec;
    uint32_t _trigger_tstamp_pad;
    int64_t  tstamp_sec;
    int32_t  tstamp_nsec;
    uint32_t _tstamp_pad;
    uint32_t appl_ptr;                  /* snd_pcm_uframes_t */
    uint32_t hw_ptr;
    int32_t  delay;                     /* snd_pcm_sframes_t */
    uint32_t avail;
    uint32_t avail_max;
    uint32_t overrange;
    uint32_t suspended_state;
    uint32_t audio_tstamp_data;
    int64_t  audio_tstamp_sec;
    int32_t  audio_tstamp_nsec;
    uint32_t _audio_tstamp_pad;
    int64_t  driver_tstamp_sec;
    int32_t  driver_tstamp_nsec;
    uint32_t _driver_tstamp_pad;
    uint32_t audio_tstamp_accuracy;
    uint8_t  reserved[20];
};

/* --- snd_pcm_info (288 bytes) ---------------------------------------- */

struct snd_pcm_info {
    uint32_t device;
    uint32_t subdevice;
    int32_t  stream;
    int32_t  card;
    uint8_t  id[64];
    uint8_t  name[80];
    uint8_t  subname[32];
    uint32_t dev_class;
    uint32_t dev_subclass;
    uint32_t subdevices_count;
    uint32_t subdevices_avail;
    uint8_t  sync[16];
    uint8_t  reserved[64];
};

/* --- snd_pcm_mmap_status64 (56B on wasm32) — kernel-writes, userspace-reads.
 * Mapped at SNDRV_PCM_MMAP_OFFSET_STATUS_NEW. */

struct snd_pcm_mmap_status {
    uint32_t state;
    uint32_t _pad1;                     /* 64-bit alignment */
    uint32_t hw_ptr;                    /* snd_pcm_uframes_t */
    uint32_t _pad_after_hw_ptr;
    int64_t  tstamp_sec;
    int32_t  tstamp_nsec;
    uint32_t _tstamp_pad;
    uint32_t suspended_state;
    uint32_t _pad3;
    int64_t  audio_tstamp_sec;
    int32_t  audio_tstamp_nsec;
    uint32_t _audio_tstamp_pad;
};

/* --- snd_pcm_mmap_control64 (12B on wasm32) — userspace-writes,
 * kernel-reads. Mapped at SNDRV_PCM_MMAP_OFFSET_CONTROL_NEW. */

struct snd_pcm_mmap_control {
    uint32_t appl_ptr;
    uint32_t avail_min;
    uint32_t _pad_after;                /* __pad_after_uframe */
};

/* --- snd_xferi (12B on wasm32) — argument to WRITEI_FRAMES/READI_FRAMES.
 * snd_pcm_sframes_t = signed long = 4 B; void* = 4 B; snd_pcm_uframes_t = 4 B. */

struct snd_xferi {
    int32_t  result;
    uint32_t buf;
    uint32_t frames;
};

/* --- snd_ctl_card_info (256B) ---------------------------------------- */

struct snd_ctl_card_info {
    int32_t card;
    int32_t pad;
    uint8_t id[16];
    uint8_t driver[16];
    uint8_t name[32];
    uint8_t longname[80];
    uint8_t reserved_[16];
    uint8_t mixername[80];
    uint8_t components[8];
};

/* --- snd_ctl_elem_id (64B) ------------------------------------------- */

struct snd_ctl_elem_id {
    uint32_t numid;
    uint32_t iface;
    uint32_t device;
    uint32_t subdevice;
    uint8_t  name[44];
    uint32_t index;
};

/* --- snd_ctl_elem_list (80B) ----------------------------------------- */

struct snd_ctl_elem_list {
    uint32_t offset;
    uint32_t space;
    uint32_t used;
    uint32_t count;
    uint64_t pids;
    uint8_t  reserved[50];
};

/* --- PCM ioctl numbers ('A' magic) ----------------------------------- *
 * Verbatim Linux UAPI v6.10. The kernel-side `audio::` module pins these
 * via static-assert against `ioc(...)` to fail loudly if the in-tree
 * struct sizes drift. */

#define SNDRV_PCM_IOCTL_PVERSION       _IOR('A', 0x00, int)
#define SNDRV_PCM_IOCTL_INFO           _IOR('A', 0x01, struct snd_pcm_info)
#define SNDRV_PCM_IOCTL_HW_REFINE      _IOWR('A', 0x10, struct snd_pcm_hw_params)
#define SNDRV_PCM_IOCTL_HW_PARAMS      _IOWR('A', 0x11, struct snd_pcm_hw_params)
#define SNDRV_PCM_IOCTL_HW_FREE        _IO('A', 0x12)
#define SNDRV_PCM_IOCTL_SW_PARAMS      _IOWR('A', 0x13, struct snd_pcm_sw_params)
#define SNDRV_PCM_IOCTL_STATUS         _IOR('A', 0x20, struct snd_pcm_status)
#define SNDRV_PCM_IOCTL_PREPARE        _IO('A', 0x40)
#define SNDRV_PCM_IOCTL_START          _IO('A', 0x42)
#define SNDRV_PCM_IOCTL_DROP           _IO('A', 0x43)
#define SNDRV_PCM_IOCTL_PAUSE          _IOW('A', 0x45, int)
#define SNDRV_PCM_IOCTL_WRITEI_FRAMES  _IOW('A', 0x50, struct snd_xferi)

/* --- Control ioctl numbers ('U' magic) ------------------------------- */

#define SNDRV_CTL_IOCTL_PVERSION       _IOR('U', 0x00, int)
#define SNDRV_CTL_IOCTL_CARD_INFO      _IOR('U', 0x01, struct snd_ctl_card_info)
#define SNDRV_CTL_IOCTL_ELEM_LIST      _IOWR('U', 0x10, struct snd_ctl_elem_list)

#ifdef __cplusplus
}
#endif

#endif /* _SOUND_ASOUND_H */
