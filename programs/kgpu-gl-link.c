/*
 * kgpu-gl-link: the smallest C program that links the Rust GL driver.
 *
 * WHY it exists: it proves the toolchain contract between a Rust no_std
 * static library (crates/kandelo-gl, local-binaries/libkandelo_gl.a) and an
 * ordinary SDK-built C program -- shared-memory feature agreement, one
 * compiler-builtins owner, an honest link with no unresolved imports, fork
 * instrumentation and the memory-group conversion -- before the driver
 * implements any real EGL or GLES behavior. It uses only the Khronos
 * <EGL/egl.h> header. host/test/kgpu-gl-link.test.ts runs it grouped.
 *
 * It prints `egl error 0x<code>` with the value eglGetError() returns and
 * exits 0 when that value is EGL_SUCCESS, 1 otherwise.
 */
#include <EGL/egl.h>
#include <stdio.h>

int main(void) {
  EGLint error = eglGetError();
  printf("egl error 0x%x\n", (unsigned)error);
  return error == EGL_SUCCESS ? 0 : 1;
}
