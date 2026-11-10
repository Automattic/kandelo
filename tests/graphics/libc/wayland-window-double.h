#ifndef GRAPHICS_WAYLAND_WINDOW_DOUBLE_H
#define GRAPHICS_WAYLAND_WINDOW_DOUBLE_H
#include <sys/ioctl.h>
int window_owned_ioctl(int,unsigned long,...);
#define ioctl window_owned_ioctl
#endif
