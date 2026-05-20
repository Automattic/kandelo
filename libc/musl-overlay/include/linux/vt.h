/*
 * Minimal <linux/vt.h> for Kandelo's Linux virtual-terminal compatibility.
 *
 * Kandelo does not multiplex real virtual consoles, but fbdev X/SDL-style
 * stacks commonly probe these ioctls while taking a display. The kernel
 * reports one always-active VT and accepts activation/release as no-op
 * compatibility requests.
 */
#ifndef _LINUX_VT_H
#define _LINUX_VT_H 1

#define VT_OPENQRY     0x5600
#define VT_GETMODE     0x5601
#define VT_SETMODE     0x5602
#define VT_GETSTATE    0x5603
#define VT_RELDISP     0x5605
#define VT_ACTIVATE    0x5606
#define VT_WAITACTIVE  0x5607
#define VT_DISALLOCATE 0x5608

#define VT_AUTO    0x00
#define VT_PROCESS 0x01
#define VT_ACKACQ  0x02

struct vt_mode {
	unsigned char mode;
	unsigned char waitv;
	short relsig;
	short acqsig;
	short frsig;
};

struct vt_stat {
	unsigned short v_active;
	unsigned short v_signal;
	unsigned short v_state;
};

#endif /* _LINUX_VT_H */
