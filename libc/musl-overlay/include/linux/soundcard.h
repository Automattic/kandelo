/*
 * Minimal <linux/soundcard.h> for wasm-posix-kernel.
 *
 * This exposes the OSS subset implemented by /dev/dsp. The ioctl values
 * match Linux so existing OSS-targeted code can compile unchanged; the
 * kernel accepts unsupported operations with ENOTTY.
 */
#ifndef _LINUX_SOUNDCARD_H
#define _LINUX_SOUNDCARD_H 1

#include <stdint.h>

typedef struct audio_buf_info {
    int fragments;
    int fragstotal;
    int fragsize;
    int bytes;
} audio_buf_info;

#define SNDCTL_DSP_RESET       0x00005000
#define SNDCTL_DSP_SYNC        0x00005001
#define SNDCTL_DSP_SPEED       0xc0045002
#define SNDCTL_DSP_STEREO      0xc0045003
#define SNDCTL_DSP_GETBLKSIZE  0xc0045004
#define SNDCTL_DSP_SETFMT      0xc0045005
#define SNDCTL_DSP_CHANNELS    0xc0045006
#define SNDCTL_DSP_SETFRAGMENT 0xc004500a
#define SNDCTL_DSP_GETFMTS     0x8004500b
#define SNDCTL_DSP_GETOSPACE   0x8010500c
#define SNDCTL_DSP_GETISPACE   0x8010500d
#define SNDCTL_DSP_GETCAPS     0x8004500f
#define SNDCTL_DSP_GETTRIGGER  0x80045010
#define SNDCTL_DSP_SETTRIGGER  0x40045010
#define SNDCTL_DSP_SETDUPLEX   0x00005016

#define AFMT_QUERY  0x00000000
#define AFMT_MU_LAW 0x00000001
#define AFMT_A_LAW  0x00000002
#define AFMT_IMA_ADPCM 0x00000004
#define AFMT_U8     0x00000008
#define AFMT_S16_LE 0x00000010
#define AFMT_S16_BE 0x00000020
#define AFMT_S8     0x00000040
#define AFMT_U16_LE 0x00000080
#define AFMT_U16_BE 0x00000100
#define AFMT_MPEG   0x00000200

#define DSP_CAP_REVISION 0x000000ff
#define DSP_CAP_DUPLEX   0x00000100
#define DSP_CAP_REALTIME 0x00000200
#define DSP_CAP_BATCH    0x00000400
#define DSP_CAP_COPROC   0x00000800
#define DSP_CAP_TRIGGER  0x00001000
#define DSP_CAP_MMAP     0x00002000
#define DSP_CAP_MULTI    0x00004000
#define DSP_CAP_BIND     0x00008000

#define PCM_ENABLE_INPUT  0x00000001
#define PCM_ENABLE_OUTPUT 0x00000002

#define SOUND_MIXER_VOLUME  0
#define SOUND_MIXER_PCM     4
#define SOUND_MIXER_RECLEV  11
#define SOUND_MIXER_IGAIN   12
#define SOUND_MIXER_DEVMASK 0xfe

#define MIXER_READ(dev)  (0x80044d00 | (dev))
#define MIXER_WRITE(dev) (0xc0044d00 | (dev))
#define SOUND_MIXER_READ_DEVMASK MIXER_READ(SOUND_MIXER_DEVMASK)

#endif /* _LINUX_SOUNDCARD_H */
