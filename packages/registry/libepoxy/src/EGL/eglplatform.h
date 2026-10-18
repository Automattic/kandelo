/*
 * Minimal EGL platform types for wasm32-posix-kernel.
 *
 * There is no native EGL display on the kernel; the native handle
 * types are opaque pointers (the same shape the Khronos header uses
 * for headless platforms). Consumed by libepoxy's generated
 * epoxy/egl_generated.h and by GTK3's wayland backend.
 */

#ifndef __eglplatform_h_
#define __eglplatform_h_

#include <KHR/khrplatform.h>

#ifndef EGLAPI
#define EGLAPI extern
#endif

#ifndef EGLAPIENTRY
#define EGLAPIENTRY
#endif
#define EGLAPIENTRYP EGLAPIENTRY *

typedef void *EGLNativeDisplayType;
typedef void *EGLNativePixmapType;
typedef void *EGLNativeWindowType;

typedef EGLNativeDisplayType NativeDisplayType;
typedef EGLNativePixmapType NativePixmapType;
typedef EGLNativeWindowType NativeWindowType;

typedef khronos_int32_t EGLint;

#ifndef EGL_CAST
#if defined(__cplusplus)
#define EGL_CAST(type, value) (static_cast<type>(value))
#else
#define EGL_CAST(type, value) ((type) (value))
#endif
#endif

#endif
