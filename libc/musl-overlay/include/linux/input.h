/*
 * Minimal <linux/input.h> for wasm-posix-kernel.
 *
 * This subset is enough for evdev readers such as Xfbdev KDrive, SDL, and
 * small framebuffer/desktop programs that consume /dev/input/event*.
 * Numeric values mirror upstream Linux uapi.
 *
 * Any change here is part of the kernel ABI - bump ABI_VERSION.
 */
#ifndef _LINUX_INPUT_H
#define _LINUX_INPUT_H 1

#include <stdint.h>

typedef uint16_t __u16;
typedef uint32_t __u32;

struct input_event_time32 {
	int32_t tv_sec;
	int32_t tv_usec;
};

struct input_event {
	struct input_event_time32 time;
	__u16 type;
	__u16 code;
	int32_t value;
};

struct input_absinfo {
	int32_t value;
	int32_t minimum;
	int32_t maximum;
	int32_t fuzz;
	int32_t flat;
	int32_t resolution;
};

#define EV_SYN       0x00
#define EV_KEY       0x01
#define EV_REL       0x02
#define EV_ABS       0x03
#define EV_MSC       0x04
#define EV_SW        0x05
#define EV_LED       0x11
#define EV_SND       0x12
#define EV_REP       0x14
#define EV_FF        0x15
#define EV_PWR       0x16
#define EV_FF_STATUS 0x17
#define EV_MAX       0x1f

#define SYN_REPORT   0

#define KEY_MAX      0x2ff

#define BTN_MOUSE    0x110
#define BTN_LEFT     0x110
#define BTN_RIGHT    0x111
#define BTN_MIDDLE   0x112
#define BTN_SIDE     0x113
#define BTN_EXTRA    0x114
#define BTN_FORWARD  0x115
#define BTN_BACK     0x116
#define BTN_TASK     0x117
#define BTN_JOYSTICK 0x120

#define REL_X        0x00
#define REL_Y        0x01
#define REL_Z        0x02
#define REL_RX       0x03
#define REL_RY       0x04
#define REL_RZ       0x05
#define REL_HWHEEL   0x06
#define REL_DIAL     0x07
#define REL_WHEEL    0x08
#define REL_MISC     0x09
#define REL_MAX      0x0f

#define ABS_X        0x00
#define ABS_Y        0x01
#define ABS_Z        0x02
#define ABS_RX       0x03
#define ABS_RY       0x04
#define ABS_RZ       0x05
#define ABS_THROTTLE 0x06
#define ABS_RUDDER   0x07
#define ABS_WHEEL    0x08
#define ABS_GAS      0x09
#define ABS_BRAKE    0x0a
#define ABS_HAT0X    0x10
#define ABS_HAT0Y    0x11
#define ABS_HAT1X    0x12
#define ABS_HAT1Y    0x13
#define ABS_HAT2X    0x14
#define ABS_HAT2Y    0x15
#define ABS_HAT3X    0x16
#define ABS_HAT3Y    0x17
#define ABS_PRESSURE 0x18
#define ABS_DISTANCE 0x19
#define ABS_TILT_X   0x1a
#define ABS_TILT_Y   0x1b
#define ABS_TOOL_WIDTH 0x1c
#define ABS_VOLUME   0x20
#define ABS_MISC     0x28
#define ABS_MAX      0x3f

#define LED_NUML     0x00
#define LED_CAPSL    0x01
#define LED_SCROLLL  0x02
#define LED_COMPOSE  0x03
#define LED_MAX      0x0f

#define _IOC_NRBITS    8
#define _IOC_TYPEBITS  8
#define _IOC_SIZEBITS 14
#define _IOC_DIRBITS   2

#define _IOC_NRSHIFT      0
#define _IOC_TYPESHIFT    (_IOC_NRSHIFT + _IOC_NRBITS)
#define _IOC_SIZESHIFT    (_IOC_TYPESHIFT + _IOC_TYPEBITS)
#define _IOC_DIRSHIFT     (_IOC_SIZESHIFT + _IOC_SIZEBITS)

#define _IOC_NONE  0U
#define _IOC_WRITE 1U
#define _IOC_READ  2U

#define _IOC(dir,type,nr,size) \
	(((dir) << _IOC_DIRSHIFT) | ((type) << _IOC_TYPESHIFT) | \
	 ((nr) << _IOC_NRSHIFT) | ((size) << _IOC_SIZESHIFT))
#define _IO(type,nr)       _IOC(_IOC_NONE, (type), (nr), 0)
#define _IOR(type,nr,size) _IOC(_IOC_READ, (type), (nr), sizeof(size))
#define _IOW(type,nr,size) _IOC(_IOC_WRITE, (type), (nr), sizeof(size))

#define EVIOCGVERSION _IOR('E', 0x01, int)
#define EVIOCGID      _IOR('E', 0x02, struct input_id)
#define EVIOCGNAME(len) _IOC(_IOC_READ, 'E', 0x06, (len))
#define EVIOCGBIT(ev,len) _IOC(_IOC_READ, 'E', 0x20 + (ev), (len))
#define EVIOCGABS(abs) _IOR('E', 0x40 + (abs), struct input_absinfo)
#define EVIOCGRAB     _IOW('E', 0x90, int)

struct input_id {
	__u16 bustype;
	__u16 vendor;
	__u16 product;
	__u16 version;
};

#define BUS_VIRTUAL 0x06

#endif /* _LINUX_INPUT_H */
