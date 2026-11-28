/*
 * kgpu-gl-link: the smallest C program that links the Rust GL driver.
 *
 * WHY it exists: it proves the toolchain contract between a Rust no_std
 * static library (crates/kandelo-gl, local-binaries/libkandelo_gl.a) and an
 * ordinary SDK-built C program -- shared-memory feature agreement, one
 * compiler-builtins owner, an honest link with no unresolved imports, fork
 * instrumentation and the memory-group conversion. eglInitialize makes the
 * link carry the driver's real kandelo.kgpu.v1 path (its device probe),
 * its allocator and its per-thread state, so none of them is left out of
 * the program. It uses only the Khronos <EGL/egl.h> and <EGL/eglext.h>
 * headers. host/test/kgpu-gl-link.test.ts runs it grouped.
 *
 * It prints `egl error 0x<code>` with the value eglGetError() returns
 * before any other EGL call, then `initialize <result> error 0x<code>`
 * for eglInitialize on the surfaceless display, and `version <major>.<minor>`
 * when that succeeded. It exits 0 when every call answered consistently:
 * no error before the first call, a display, and an error code that agrees
 * with eglInitialize's result. A machine without a renderer answers
 * EGL_FALSE with EGL_NOT_INITIALIZED, which is a consistent answer.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <stdio.h>

int main(void) {
  EGLint error = eglGetError();
  printf("egl error 0x%x\n", (unsigned)error);
  if (error != EGL_SUCCESS)
    return 1;

  EGLDisplay dpy = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (dpy == EGL_NO_DISPLAY) {
    printf("no display error 0x%x\n", (unsigned)eglGetError());
    return 1;
  }
  EGLint major = 0, minor = 0;
  EGLBoolean ok = eglInitialize(dpy, &major, &minor);
  error = eglGetError();
  printf("initialize %u error 0x%x\n", (unsigned)ok, (unsigned)error);
  if (!ok)
    return error == EGL_SUCCESS ? 1 : 0;
  printf("version %d.%d\n", major, minor);
  if (error != EGL_SUCCESS || !eglTerminate(dpy))
    return 1;
  return 0;
}
