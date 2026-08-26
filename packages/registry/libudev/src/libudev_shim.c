/*
 * libudev_shim.c — libinput-scoped libudev shim for wasm32-posix-kernel.
 *
 * libinput's PATH backend hands every device through a struct udev_device
 * and refuses to configure one (evdev.c evdev_configure_device) unless
 * udev_device_get_property_value() reports ID_INPUT plus at least one
 * ID_INPUT_* class tag. On a real system those tags come from udev's
 * `input_id` builtin, which classifies a device from its evdev EV_/KEY_/
 * REL_/ABS_/INPUT_PROP_ capability bits. This shim reimplements that
 * classification (test_pointers + test_key + the EV_SW / scrollwheel
 * fallbacks, faithful to systemd v255 src/udev/udev-builtin-input_id.c)
 * over EVIOCGBIT/EVIOCGPROP probes, and exposes the result through
 * udev_device_get_property_value. Every other udev call is a thin no-op:
 * ref/unref manage a refcount, the getters return the device's devnode /
 * sysname / syspath, is_initialized is always true, and parent lookups /
 * other properties return NULL (libinput's path backend treats all of
 * those as "use defaults").
 *
 * The one non-obvious piece is device lookup. libinput's path backend
 * stat()s the devnode, keeps only st_rdev, and calls
 * udev_device_new_from_devnum('c', st_rdev) — the path is gone. The
 * kernel reports evdev nodes as char major 13, minor 64+N (ABI v17), so
 * we recover the node by scanning /dev/input/event* for the matching
 * st_rdev, exactly as udev's own devnum→syspath resolution does.
 *
 * See docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
 */
#include <libudev.h>

#include <fcntl.h>
#include <linux/input.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

/* --- evdev constants the ABI-locked minimal sysroot header omits ------
 * The sysroot's <linux/input-event-codes.h> is a deliberately small,
 * kernel-ABI-locked subset (no *_MAX sentinels, no INPUT_PROP_*, no
 * BTN_TOUCH/ABS_MT_*). We define exactly the codes the classification
 * below tests — nothing more — each guarded so a fuller header wins. */
#ifndef EV_SW
#define EV_SW 0x05
#endif
#ifndef EV_MAX
#define EV_MAX 0x1f
#endif
#ifndef KEY_MAX
#define KEY_MAX 0x2ff
#endif
#ifndef REL_MAX
#define REL_MAX 0x0f
#endif
#ifndef ABS_MAX
#define ABS_MAX 0x3f
#endif
#ifndef REL_WHEEL
#define REL_WHEEL 0x08
#endif
#ifndef REL_HWHEEL
#define REL_HWHEEL 0x06
#endif
#ifndef ABS_Z
#define ABS_Z 0x02
#endif
#ifndef ABS_RX
#define ABS_RX 0x03
#endif
#ifndef ABS_PRESSURE
#define ABS_PRESSURE 0x18
#endif
#ifndef ABS_MT_SLOT
#define ABS_MT_SLOT 0x2f
#endif
#ifndef ABS_MT_POSITION_X
#define ABS_MT_POSITION_X 0x35
#endif
#ifndef ABS_MT_POSITION_Y
#define ABS_MT_POSITION_Y 0x36
#endif
#ifndef BTN_MISC
#define BTN_MISC 0x100
#endif
#ifndef BTN_0
#define BTN_0 0x100
#endif
#ifndef BTN_1
#define BTN_1 0x101
#endif
#ifndef BTN_MOUSE
#define BTN_MOUSE 0x110
#endif
#ifndef BTN_JOYSTICK
#define BTN_JOYSTICK 0x120
#endif
#ifndef BTN_TOOL_PEN
#define BTN_TOOL_PEN 0x140
#endif
#ifndef BTN_TOOL_FINGER
#define BTN_TOOL_FINGER 0x145
#endif
#ifndef BTN_TOUCH
#define BTN_TOUCH 0x14a
#endif
#ifndef BTN_STYLUS
#define BTN_STYLUS 0x14b
#endif
#ifndef BTN_DIGI
#define BTN_DIGI 0x140
#endif
#ifndef BTN_DPAD_UP
#define BTN_DPAD_UP 0x220
#endif
#ifndef BTN_DPAD_RIGHT
#define BTN_DPAD_RIGHT 0x223
#endif
#ifndef BTN_TRIGGER_HAPPY
#define BTN_TRIGGER_HAPPY 0x2c0
#endif
#ifndef BTN_TRIGGER_HAPPY1
#define BTN_TRIGGER_HAPPY1 0x2c0
#endif
#ifndef BTN_TRIGGER_HAPPY40
#define BTN_TRIGGER_HAPPY40 0x2e7
#endif
#ifndef KEY_OK
#define KEY_OK 0x160
#endif
#ifndef KEY_ALS_TOGGLE
#define KEY_ALS_TOGGLE 0x230
#endif
/* well-known keyboard keys used by the joystick un-detection heuristic */
#ifndef KEY_LEFTCTRL
#define KEY_LEFTCTRL 29
#endif
#ifndef KEY_CAPSLOCK
#define KEY_CAPSLOCK 58
#endif
#ifndef KEY_NUMLOCK
#define KEY_NUMLOCK 69
#endif
#ifndef KEY_INSERT
#define KEY_INSERT 110
#endif
#ifndef KEY_MUTE
#define KEY_MUTE 113
#endif
#ifndef KEY_CALC
#define KEY_CALC 140
#endif
#ifndef KEY_FILE
#define KEY_FILE 144
#endif
#ifndef KEY_MAIL
#define KEY_MAIL 155
#endif
#ifndef KEY_PLAYPAUSE
#define KEY_PLAYPAUSE 164
#endif
#ifndef KEY_BRIGHTNESSDOWN
#define KEY_BRIGHTNESSDOWN 224
#endif

#define INPUT_PROP_POINTER 0x00
#define INPUT_PROP_DIRECT 0x01
#define INPUT_PROP_POINTING_STICK 0x05
#define INPUT_PROP_ACCELEROMETER 0x06
#define INPUT_PROP_MAX 0x1f

/* EVIOCGPROP is not in the minimal sysroot header; the kernel answers it
 * (returns the zero-filled property bitmap for our virtual devices). */
#ifndef EVIOCGPROP
#define EVIOCGPROP(len) _IOC(_IOC_READ, 'E', 0x09, len)
#endif

/* --- bit-array helpers (mirror the kernel/udev idiom) --- */
#define BITS_PER_LONG (sizeof(unsigned long) * 8)
#define NLONGS(x) (((x) + BITS_PER_LONG - 1) / BITS_PER_LONG)
#define LONG_OF(x) ((x) / BITS_PER_LONG)
static inline int test_bit(unsigned bit, const unsigned long *array) {
	return (array[LONG_OF(bit)] >> (bit % BITS_PER_LONG)) & 1UL;
}

/* --- classification result tags (subset libinput's evdev core reads) --- */
enum {
	ID_INPUT = 1u << 0,
	ID_INPUT_KEY = 1u << 1,
	ID_INPUT_KEYBOARD = 1u << 2,
	ID_INPUT_MOUSE = 1u << 3,
	ID_INPUT_TOUCHPAD = 1u << 4,
	ID_INPUT_TOUCHSCREEN = 1u << 5,
	ID_INPUT_TABLET = 1u << 6,
	ID_INPUT_TABLET_PAD = 1u << 7,
	ID_INPUT_JOYSTICK = 1u << 8,
	ID_INPUT_POINTINGSTICK = 1u << 9,
	ID_INPUT_ACCELEROMETER = 1u << 10,
	ID_INPUT_SWITCH = 1u << 11,
};

/* systemd input_id: test_pointers(). Returns whether any pointer-family
 * tag was set. Faithful to src/udev/udev-builtin-input_id.c. */
static int test_pointers(const unsigned long *bitmask_ev,
			 const unsigned long *bitmask_abs,
			 const unsigned long *bitmask_key,
			 const unsigned long *bitmask_rel,
			 const unsigned long *bitmask_props, uint32_t *tags) {
	int is_mouse = 0, is_abs_mouse = 0, is_touchpad = 0, is_touchscreen = 0;
	int is_tablet = 0, is_tablet_pad = 0, is_joystick = 0, is_pointing_stick = 0;
	int is_accelerometer = 0;

	int has_keys = test_bit(EV_KEY, bitmask_ev);
	int has_abs_coordinates =
		test_bit(ABS_X, bitmask_abs) && test_bit(ABS_Y, bitmask_abs);
	int has_3d_coordinates =
		has_abs_coordinates && test_bit(ABS_Z, bitmask_abs);
	is_accelerometer = test_bit(INPUT_PROP_ACCELEROMETER, bitmask_props);
	if (!has_keys && has_3d_coordinates)
		is_accelerometer = 1;
	if (is_accelerometer) {
		*tags |= ID_INPUT_ACCELEROMETER;
		return 1;
	}

	is_pointing_stick = test_bit(INPUT_PROP_POINTING_STICK, bitmask_props);
	int has_stylus = test_bit(BTN_STYLUS, bitmask_key);
	int has_pen = test_bit(BTN_TOOL_PEN, bitmask_key);
	int finger_but_no_pen = test_bit(BTN_TOOL_FINGER, bitmask_key) &&
				!test_bit(BTN_TOOL_PEN, bitmask_key);
	int has_mouse_button = 0;
	for (int button = BTN_MOUSE; button < BTN_JOYSTICK && !has_mouse_button;
	     button++)
		has_mouse_button = test_bit(button, bitmask_key);
	int has_rel_coordinates = test_bit(EV_REL, bitmask_ev) &&
				  test_bit(REL_X, bitmask_rel) &&
				  test_bit(REL_Y, bitmask_rel);
	int has_mt_coordinates = test_bit(ABS_MT_POSITION_X, bitmask_abs) &&
				 test_bit(ABS_MT_POSITION_Y, bitmask_abs);
	/* unset fake-MT (device claims every abs axis) */
	if (has_mt_coordinates && test_bit(ABS_MT_SLOT, bitmask_abs) &&
	    test_bit(ABS_MT_SLOT - 1, bitmask_abs))
		has_mt_coordinates = 0;
	int is_direct = test_bit(INPUT_PROP_DIRECT, bitmask_props);
	int has_touch = test_bit(BTN_TOUCH, bitmask_key);
	int has_pad_buttons = test_bit(BTN_0, bitmask_key) &&
			      test_bit(BTN_1, bitmask_key) && !has_pen;
	int has_wheel = test_bit(EV_REL, bitmask_ev) &&
			(test_bit(REL_WHEEL, bitmask_rel) ||
			 test_bit(REL_HWHEEL, bitmask_rel));

	/* joystick button/axis counts */
	int num_joystick_buttons = 0, num_joystick_axes = 0;
	if (!test_bit(BTN_JOYSTICK - 1, bitmask_key)) {
		for (int b = BTN_JOYSTICK; b < BTN_DIGI; b++)
			if (test_bit(b, bitmask_key))
				num_joystick_buttons++;
		for (int b = BTN_TRIGGER_HAPPY1; b <= BTN_TRIGGER_HAPPY40; b++)
			if (test_bit(b, bitmask_key))
				num_joystick_buttons++;
		for (int b = BTN_DPAD_UP; b <= BTN_DPAD_RIGHT; b++)
			if (test_bit(b, bitmask_key))
				num_joystick_buttons++;
	}
	for (int a = ABS_RX; a < ABS_PRESSURE; a++)
		if (test_bit(a, bitmask_abs))
			num_joystick_axes++;

	if (has_abs_coordinates) {
		if (has_stylus || has_pen)
			is_tablet = 1;
		else if (finger_but_no_pen && !is_direct)
			is_touchpad = 1;
		else if (has_mouse_button)
			is_abs_mouse = 1; /* e.g. VMware abs USB mouse */
		else if (has_touch || is_direct)
			is_touchscreen = 1;
		else if (num_joystick_buttons > 0 || num_joystick_axes > 0)
			is_joystick = 1;
	} else if (num_joystick_buttons > 0 || num_joystick_axes > 0) {
		is_joystick = 1;
	}

	if (has_mt_coordinates) {
		if (has_stylus || has_pen)
			is_tablet = 1;
		else if (finger_but_no_pen && !is_direct)
			is_touchpad = 1;
		else if (has_touch || is_direct)
			is_touchscreen = 1;
	}

	if (is_tablet && has_pad_buttons)
		is_tablet_pad = 1;
	if (has_pad_buttons && has_wheel && !has_rel_coordinates) {
		is_tablet = 1;
		is_tablet_pad = 1;
	}
	if (!is_tablet && !is_touchpad && !is_joystick && has_mouse_button &&
	    (has_rel_coordinates || !has_abs_coordinates))
		is_mouse = 1;
	/* (systemd also promotes an i2c mouse to a pointing stick here; our
	 * devices are BUS_VIRTUAL, never i2c, so that branch is omitted.) */

	if (is_joystick) {
		static const unsigned wk[] = {
			KEY_LEFTCTRL, KEY_CAPSLOCK, KEY_NUMLOCK,	KEY_INSERT,
			KEY_MUTE,     KEY_CALC,	    KEY_FILE,		KEY_MAIL,
			KEY_PLAYPAUSE, KEY_BRIGHTNESSDOWN,
		};
		int num_well_known_keys = 0;
		for (unsigned i = 0; i < sizeof(wk) / sizeof(wk[0]); i++)
			if (test_bit(wk[i], bitmask_key))
				num_well_known_keys++;
		if (num_well_known_keys >= 4 ||
		    num_joystick_buttons + num_joystick_axes < 2)
			is_joystick = 0; /* actually a keyboard */
		if (has_wheel && has_pad_buttons)
			is_joystick = 0; /* actually a tablet pad */
	}

	if (is_pointing_stick)
		*tags |= ID_INPUT_POINTINGSTICK;
	if (is_mouse || is_abs_mouse)
		*tags |= ID_INPUT_MOUSE;
	if (is_touchpad)
		*tags |= ID_INPUT_TOUCHPAD;
	if (is_touchscreen)
		*tags |= ID_INPUT_TOUCHSCREEN;
	if (is_joystick)
		*tags |= ID_INPUT_JOYSTICK;
	if (is_tablet)
		*tags |= ID_INPUT_TABLET;
	if (is_tablet_pad)
		*tags |= ID_INPUT_TABLET_PAD;

	return is_tablet || is_mouse || is_abs_mouse || is_touchpad ||
	       is_touchscreen || is_joystick || is_pointing_stick;
}

/* systemd input_id: test_key(). Returns whether a key/keyboard tag set. */
static int test_key(const unsigned long *bitmask_ev,
		    const unsigned long *bitmask_key, uint32_t *tags) {
	if (!test_bit(EV_KEY, bitmask_ev))
		return 0;

	int found = 0;
	/* ordinary KEY_* keys live below BTN_MISC */
	for (unsigned i = 0; i < BTN_MISC / BITS_PER_LONG && !found; i++)
		if (bitmask_key[i])
			found = 1;
	/* two high blocks of non-button keys */
	static const struct {
		unsigned lo, hi;
	} blocks[] = {
		{ KEY_OK, BTN_DPAD_UP },
		{ KEY_ALS_TOGGLE, BTN_TRIGGER_HAPPY },
	};
	for (unsigned b = 0; b < sizeof(blocks) / sizeof(blocks[0]); b++)
		for (unsigned i = blocks[b].lo; i < blocks[b].hi && !found; i++)
			if (test_bit(i, bitmask_key))
				found = 1;

	if (found)
		*tags |= ID_INPUT_KEY;

	/* a full keyboard has the first 32 KEY_ bits (ESC..D), ignoring
	 * KEY_RESERVED at bit 0 */
	if ((bitmask_key[0] & 0xFFFFFFFEUL) == 0xFFFFFFFEUL) {
		*tags |= ID_INPUT_KEYBOARD;
		return 1;
	}
	return found;
}

/* Probe an open evdev fd and produce the ID_INPUT* tag set, mirroring
 * udev's input_id builtin driver. */
static uint32_t classify_evdev(int fd) {
	unsigned long ev[NLONGS(EV_MAX + 1)];
	unsigned long key[NLONGS(KEY_MAX + 1)];
	unsigned long rel[NLONGS(REL_MAX + 1)];
	unsigned long abs[NLONGS(ABS_MAX + 1)];
	unsigned long prop[NLONGS(INPUT_PROP_MAX + 1)];
	memset(ev, 0, sizeof ev);
	memset(key, 0, sizeof key);
	memset(rel, 0, sizeof rel);
	memset(abs, 0, sizeof abs);
	memset(prop, 0, sizeof prop);

	if (ioctl(fd, EVIOCGBIT(0, sizeof ev), ev) < 0)
		return 0; /* not an evdev device */
	ioctl(fd, EVIOCGBIT(EV_KEY, sizeof key), key);
	ioctl(fd, EVIOCGBIT(EV_REL, sizeof rel), rel);
	ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs), abs);
	ioctl(fd, EVIOCGPROP(sizeof prop), prop);

	uint32_t tags = ID_INPUT; /* has an ev bitmap → an input device */
	test_pointers(ev, abs, key, rel, prop, &tags);
	test_key(ev, key, &tags);
	/* scrollwheel-only devices count as keys */
	if (!(tags & (ID_INPUT_MOUSE | ID_INPUT_TOUCHPAD | ID_INPUT_TOUCHSCREEN |
		      ID_INPUT_TABLET | ID_INPUT_JOYSTICK |
		      ID_INPUT_POINTINGSTICK | ID_INPUT_ACCELEROMETER)) &&
	    !(tags & ID_INPUT_KEY) && test_bit(EV_REL, ev) &&
	    (test_bit(REL_WHEEL, rel) || test_bit(REL_HWHEEL, rel)))
		tags |= ID_INPUT_KEY;
	if (test_bit(EV_SW, ev))
		tags |= ID_INPUT_SWITCH;
	return tags;
}

/* --- opaque objects --- */
struct udev {
	int refcount;
};

struct udev_device {
	int refcount;
	struct udev *udev;
	uint32_t tags;
	char devnode[64]; /* "/dev/input/eventN" */
	char sysname[32]; /* "eventN" */
	char syspath[64]; /* "/sys/class/input/eventN" */
};

/* Map a property key to its tag bit; 0 for keys we don't synthesize. */
static uint32_t tag_for_key(const char *key) {
	if (!strcmp(key, "ID_INPUT")) return ID_INPUT;
	if (!strcmp(key, "ID_INPUT_KEY")) return ID_INPUT_KEY;
	if (!strcmp(key, "ID_INPUT_KEYBOARD")) return ID_INPUT_KEYBOARD;
	if (!strcmp(key, "ID_INPUT_MOUSE")) return ID_INPUT_MOUSE;
	if (!strcmp(key, "ID_INPUT_TOUCHPAD")) return ID_INPUT_TOUCHPAD;
	if (!strcmp(key, "ID_INPUT_TOUCHSCREEN")) return ID_INPUT_TOUCHSCREEN;
	if (!strcmp(key, "ID_INPUT_TABLET")) return ID_INPUT_TABLET;
	if (!strcmp(key, "ID_INPUT_TABLET_PAD")) return ID_INPUT_TABLET_PAD;
	if (!strcmp(key, "ID_INPUT_JOYSTICK")) return ID_INPUT_JOYSTICK;
	if (!strcmp(key, "ID_INPUT_POINTINGSTICK")) return ID_INPUT_POINTINGSTICK;
	if (!strcmp(key, "ID_INPUT_ACCELEROMETER")) return ID_INPUT_ACCELEROMETER;
	if (!strcmp(key, "ID_INPUT_SWITCH")) return ID_INPUT_SWITCH;
	return 0;
}

/* ==================== public API ==================== */

struct udev *udev_new(void) {
	struct udev *u = calloc(1, sizeof *u);
	if (u)
		u->refcount = 1;
	return u;
}

struct udev *udev_unref(struct udev *udev) {
	if (udev && --udev->refcount <= 0)
		free(udev);
	return NULL;
}

struct udev_device *udev_device_ref(struct udev_device *d) {
	if (d)
		d->refcount++;
	return d;
}

struct udev_device *udev_device_unref(struct udev_device *d) {
	if (d && --d->refcount <= 0)
		free(d);
	return NULL;
}

struct udev_device *udev_device_new_from_devnum(struct udev *udev, char type,
						dev_t devnum) {
	if (!udev || type != 'c')
		return NULL;

	/* Recover the devnode: libinput dropped the path and kept only the
	 * devnum, so find the evdev node whose st_rdev matches. */
	char path[64];
	int index = -1;
	for (int n = 0; n < 32; n++) {
		snprintf(path, sizeof path, "/dev/input/event%d", n);
		struct stat st;
		if (stat(path, &st) < 0)
			continue;
		if (st.st_rdev == devnum) {
			index = n;
			break;
		}
	}
	if (index < 0)
		return NULL;

	int fd = open(path, O_RDONLY | O_NONBLOCK);
	if (fd < 0)
		return NULL;
	uint32_t tags = classify_evdev(fd);
	close(fd);

	struct udev_device *d = calloc(1, sizeof *d);
	if (!d)
		return NULL;
	d->refcount = 1;
	d->udev = udev;
	d->tags = tags;
	snprintf(d->devnode, sizeof d->devnode, "/dev/input/event%d", index);
	snprintf(d->sysname, sizeof d->sysname, "event%d", index);
	snprintf(d->syspath, sizeof d->syspath, "/sys/class/input/event%d",
		 index);
	return d;
}

/* Quirks-only lookup by syspath. Quirks are optional tuning; returning
 * NULL makes libinput fall back to its built-in defaults. */
struct udev_device *udev_device_new_from_syspath(struct udev *udev,
						 const char *syspath) {
	(void) udev;
	(void) syspath;
	return NULL;
}

struct udev *udev_device_get_udev(struct udev_device *d) {
	return d ? d->udev : NULL;
}

/* Our devices carry every ID_INPUT* tag directly (no parent walk). */
struct udev_device *udev_device_get_parent(struct udev_device *d) {
	(void) d;
	return NULL;
}

struct udev_device *
udev_device_get_parent_with_subsystem_devtype(struct udev_device *d,
					      const char *subsystem,
					      const char *devtype) {
	(void) d;
	(void) subsystem;
	(void) devtype;
	return NULL;
}

const char *udev_device_get_devnode(struct udev_device *d) {
	return d ? d->devnode : NULL;
}

const char *udev_device_get_syspath(struct udev_device *d) {
	return d ? d->syspath : NULL;
}

const char *udev_device_get_sysname(struct udev_device *d) {
	return d ? d->sysname : NULL;
}

int udev_device_get_is_initialized(struct udev_device *d) {
	(void) d;
	return 1;
}

const char *udev_device_get_property_value(struct udev_device *d,
					   const char *key) {
	if (!d || !key)
		return NULL;
	uint32_t bit = tag_for_key(key);
	if (bit && (d->tags & bit))
		return "1";
	/* Every other property (ID_SEAT, WL_SEAT, WL_OUTPUT, MOUSE_DPI,
	 * LIBINPUT_*, calibration, …) is unset → libinput uses defaults. */
	return NULL;
}
