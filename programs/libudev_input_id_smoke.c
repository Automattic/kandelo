/*
 * libudev shim + input_id smoke test (PR5b), driven by
 * host/test/libudev-input-id-smoke.test.ts.
 *
 * Reproduces libinput's path-backend device creation exactly: stat the
 * devnode, hand ONLY the resulting st_rdev to
 * udev_device_new_from_devnum('c', rdev) (libinput drops the path), then
 * read back the ID_INPUT* classification and the devnode/sysname. This
 * exercises the whole chain end to end:
 *   - the ABI-v17 rdev fix (event0/event1 stat with distinct char 13:64 /
 *     13:65, so the shim can recover the right node from the devnum),
 *   - the shim's devnum→devnode scan,
 *   - the input_id classification (event0 → keyboard, event1 → mouse).
 */
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include <libudev.h>

static int expect_prop(struct udev_device *d, const char *key,
                       const char *want) {
    const char *got = udev_device_get_property_value(d, key);
    int ok = want ? (got && !strcmp(got, want)) : (got == NULL);
    printf("  %s=%s want=%s %s\n", key, got ? got : "(null)",
           want ? want : "(null)", ok ? "OK" : "FAIL");
    return ok;
}

/* stat + new_from_devnum, mirroring udev_device_from_devnode(). */
static struct udev_device *make_dev(struct udev *u, const char *path) {
    struct stat st;
    if (stat(path, &st) < 0) {
        perror("stat");
        return NULL;
    }
    printf("%s rdev=%llu\n", path, (unsigned long long) st.st_rdev);
    return udev_device_new_from_devnum(u, 'c', st.st_rdev);
}

int main(void) {
    struct udev *u = udev_new();
    if (!u) {
        printf("udev_new failed\n");
        return 1;
    }
    int ok = 1;

    /* --- event0: keyboard --- */
    struct udev_device *kbd = make_dev(u, "/dev/input/event0");
    if (!kbd) {
        printf("event0 device null\n");
        return 1;
    }
    printf("event0 devnode=%s sysname=%s\n", udev_device_get_devnode(kbd),
           udev_device_get_sysname(kbd));
    ok &= !strcmp(udev_device_get_devnode(kbd), "/dev/input/event0");
    ok &= !strcmp(udev_device_get_sysname(kbd), "event0");
    ok &= (udev_device_get_udev(kbd) == u);
    ok &= (udev_device_get_is_initialized(kbd) == 1);
    ok &= expect_prop(kbd, "ID_INPUT", "1");
    ok &= expect_prop(kbd, "ID_INPUT_KEYBOARD", "1");
    ok &= expect_prop(kbd, "ID_INPUT_KEY", "1");
    ok &= expect_prop(kbd, "ID_INPUT_MOUSE", NULL);

    /* --- event1: pointer --- */
    struct udev_device *ptr = make_dev(u, "/dev/input/event1");
    if (!ptr) {
        printf("event1 device null\n");
        return 1;
    }
    printf("event1 devnode=%s sysname=%s\n", udev_device_get_devnode(ptr),
           udev_device_get_sysname(ptr));
    ok &= !strcmp(udev_device_get_devnode(ptr), "/dev/input/event1");
    ok &= !strcmp(udev_device_get_sysname(ptr), "event1");
    ok &= expect_prop(ptr, "ID_INPUT", "1");
    ok &= expect_prop(ptr, "ID_INPUT_MOUSE", "1");
    ok &= expect_prop(ptr, "ID_INPUT_KEYBOARD", NULL);

    udev_device_unref(kbd);
    udev_device_unref(ptr);
    udev_unref(u);

    if (!ok) {
        printf("LIBUDEV_INPUT_ID_SMOKE_FAIL\n");
        return 1;
    }
    printf("LIBUDEV_INPUT_ID_SMOKE_OK\n");
    return 0;
}
