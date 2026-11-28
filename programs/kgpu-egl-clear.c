/*
 * kgpu-egl-clear: the smallest complete EGL 1.5 + GLES 2.0 client of the
 * Rust GL driver (crates/kandelo-gl, local-binaries/libkandelo_gl.a).
 *
 * It takes the surfaceless display through eglGetPlatformDisplay,
 * initializes it, chooses a pbuffer ES2 config, creates a 16x8 pbuffer and
 * an ES2 context and makes them current. It then clears to
 * (0.2, 0.4, 0.6, 1.0), reads the 16x8 RGBA pixels into a 0xee-filled
 * buffer and swaps. It prints `pixel <i> <r> <g> <b> <a>` for pixels 0, 63
 * and 127 and, after tearing everything down, `egl ok`.
 *
 * WHY it exists: it proves the userspace driver end to end in a real host.
 * Only the Khronos headers are used (<EGL/egl.h>, <EGL/eglext.h> for the
 * platform token, <GLES2/gl2.h>), so the driver's EGL and GL models, its
 * command stream and its kgpu calls are what reach the kernel's kgpu
 * device, the GPU worker and the renderer.
 * host/test/kgpu-host.test.ts runs it on Node, and
 * apps/browser-demos/test/kgpu-egl-clear.spec.ts in each browser engine.
 *
 * Any failing EGL call prints `kgpu-egl-clear: <call> failed: 0x<egl
 * error>` and exits 1, and a GL error prints the GL error the same way, so
 * a machine without a renderer (eglInitialize: EGL_NOT_INITIALIZED) or a
 * lost GPU (eglSwapBuffers: EGL_CONTEXT_LOST) is visible as that answer
 * rather than as wrong pixels.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIDTH 16
#define HEIGHT 8
#define PIXELS (WIDTH * HEIGHT)

static int egl_fail(const char *call) {
  printf("kgpu-egl-clear: %s failed: 0x%x\n", call, (unsigned)eglGetError());
  return 1;
}

static int gl_fail(const char *call, GLenum error) {
  printf("kgpu-egl-clear: %s failed: 0x%x\n", call, (unsigned)error);
  return 1;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);

  EGLDisplay dpy = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (dpy == EGL_NO_DISPLAY) return egl_fail("eglGetPlatformDisplay");
  if (!eglInitialize(dpy, NULL, NULL)) return egl_fail("eglInitialize");

  /* EGL's defaults are a window surface and an ES 1 renderable, so a
   * pbuffer ES2 config must ask for both. */
  const EGLint config_attribs[] = {
      EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
      EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
      EGL_NONE,
  };
  EGLConfig config;
  EGLint configs = 0;
  if (!eglChooseConfig(dpy, config_attribs, &config, 1, &configs)) return egl_fail("eglChooseConfig");
  if (configs < 1) {
    printf("kgpu-egl-clear: eglChooseConfig failed: no config\n");
    return 1;
  }

  const EGLint surface_attribs[] = {EGL_WIDTH, WIDTH, EGL_HEIGHT, HEIGHT, EGL_NONE};
  EGLSurface surface = eglCreatePbufferSurface(dpy, config, surface_attribs);
  if (surface == EGL_NO_SURFACE) return egl_fail("eglCreatePbufferSurface");
  if (!eglBindAPI(EGL_OPENGL_ES_API)) return egl_fail("eglBindAPI");
  const EGLint context_attribs[] = {EGL_CONTEXT_MAJOR_VERSION, 2, EGL_NONE};
  EGLContext context = eglCreateContext(dpy, config, EGL_NO_CONTEXT, context_attribs);
  if (context == EGL_NO_CONTEXT) return egl_fail("eglCreateContext");
  if (!eglMakeCurrent(dpy, surface, surface, context)) return egl_fail("eglMakeCurrent");

  uint8_t *pixels = malloc(PIXELS * 4);
  if (pixels == NULL) {
    printf("kgpu-egl-clear: malloc failed\n");
    return 1;
  }
  /* A sentinel the clear color cannot produce, so an unwritten buffer
   * cannot pass for a readback. */
  memset(pixels, 0xee, PIXELS * 4);

  glClearColor(0.2f, 0.4f, 0.6f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  glReadPixels(0, 0, WIDTH, HEIGHT, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  GLenum error = glGetError();
  if (error != GL_NO_ERROR) return gl_fail("glReadPixels", error);
  if (!eglSwapBuffers(dpy, surface)) return egl_fail("eglSwapBuffers");

  for (int i = 0; i < PIXELS; i++) {
    if (memcmp(pixels + 4 * i, pixels, 4) != 0) {
      printf("kgpu-egl-clear: pixel %d %u %u %u %u differs from pixel 0\n", i, pixels[4 * i],
             pixels[4 * i + 1], pixels[4 * i + 2], pixels[4 * i + 3]);
      return 1;
    }
  }
  const int shown[] = {0, PIXELS / 2 - 1, PIXELS - 1};
  for (unsigned k = 0; k < sizeof shown / sizeof shown[0]; k++) {
    int i = shown[k];
    printf("pixel %d %u %u %u %u\n", i, pixels[4 * i], pixels[4 * i + 1], pixels[4 * i + 2],
           pixels[4 * i + 3]);
  }
  free(pixels);

  if (!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) return egl_fail("eglMakeCurrent");
  if (!eglDestroyContext(dpy, context)) return egl_fail("eglDestroyContext");
  if (!eglDestroySurface(dpy, surface)) return egl_fail("eglDestroySurface");
  if (!eglTerminate(dpy)) return egl_fail("eglTerminate");
  if (!eglReleaseThread()) return egl_fail("eglReleaseThread");
  printf("egl ok\n");
  return 0;
}
