#ifndef WPK_WAYLAND_NATIVE_ALLOCATION_DOUBLE_H
#define WPK_WAYLAND_NATIVE_ALLOCATION_DOUBLE_H
#include <stdlib.h>
void *wpk_native_calloc(size_t,size_t);
#define calloc wpk_native_calloc
#endif
