/*
 * kgpu-egl-fork: EGL state across fork() with the Rust GL driver
 * (crates/kandelo-gl, local-binaries/libkandelo_gl.a).
 *
 * The parent initializes the surfaceless display, creates a 16x8 pbuffer
 * and an ES2 context, makes them current, and forks. The child calls
 * eglTerminate on the display it inherited, repeats the whole sequence
 * from eglInitialize, clears to (0.2, 0.4, 0.6, 1.0), reads every pixel
 * back as 51 102 153 255 and prints `child ok`. The parent waits for the
 * child, then clears and reads back on the context it made current before
 * the fork and prints `parent ok`.
 *
 * WHY it exists: a fork child inherits the parent's driver memory but none
 * of its kgpu contexts, which belong to the parent process. The driver
 * drops the inherited state in its pthread_atfork child handler without
 * destroying anything, so the child starts clean and the parent's
 * contexts are untouched. host/test/kgpu-host.test.ts runs it on Node.
 *
 * Any failing call prints `kgpu-egl-fork: <who> <call> failed: 0x<error>`
 * and exits 1.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define WIDTH 16
#define HEIGHT 8
#define PIXELS (WIDTH * HEIGHT)

static const char *who = "parent";

static int egl_fail(const char *call) {
  printf("kgpu-egl-fork: %s %s failed: 0x%x\n", who, call, (unsigned)eglGetError());
  return 1;
}

struct gl {
  EGLDisplay dpy;
  EGLSurface surface;
  EGLContext context;
};

/* From eglInitialize to eglMakeCurrent on a 16x8 pbuffer and an ES2
 * context. */
static int setup(struct gl *gl) {
  gl->dpy = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (gl->dpy == EGL_NO_DISPLAY) return egl_fail("eglGetPlatformDisplay");
  if (!eglInitialize(gl->dpy, NULL, NULL)) return egl_fail("eglInitialize");
  const EGLint config_attribs[] = {
      EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE,
  };
  EGLConfig config;
  EGLint configs = 0;
  if (!eglChooseConfig(gl->dpy, config_attribs, &config, 1, &configs) || configs < 1)
    return egl_fail("eglChooseConfig");
  const EGLint surface_attribs[] = {EGL_WIDTH, WIDTH, EGL_HEIGHT, HEIGHT, EGL_NONE};
  gl->surface = eglCreatePbufferSurface(gl->dpy, config, surface_attribs);
  if (gl->surface == EGL_NO_SURFACE) return egl_fail("eglCreatePbufferSurface");
  const EGLint context_attribs[] = {EGL_CONTEXT_MAJOR_VERSION, 2, EGL_NONE};
  gl->context = eglCreateContext(gl->dpy, config, EGL_NO_CONTEXT, context_attribs);
  if (gl->context == EGL_NO_CONTEXT) return egl_fail("eglCreateContext");
  if (!eglMakeCurrent(gl->dpy, gl->surface, gl->surface, gl->context)) return egl_fail("eglMakeCurrent");
  return 0;
}

/* Clears, reads every pixel back into a 0xee-filled buffer and swaps; each
 * pixel must be 51 102 153 255. */
static int render(struct gl *gl) {
  static uint8_t pixels[PIXELS * 4];
  memset(pixels, 0xee, sizeof pixels);
  glClearColor(0.2f, 0.4f, 0.6f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  glReadPixels(0, 0, WIDTH, HEIGHT, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  GLenum error = glGetError();
  if (error != GL_NO_ERROR) {
    printf("kgpu-egl-fork: %s glReadPixels failed: 0x%x\n", who, (unsigned)error);
    return 1;
  }
  if (!eglSwapBuffers(gl->dpy, gl->surface)) return egl_fail("eglSwapBuffers");
  for (int i = 0; i < PIXELS; i++) {
    const uint8_t *p = pixels + 4 * i;
    if (p[0] != 51 || p[1] != 102 || p[2] != 153 || p[3] != 255) {
      printf("kgpu-egl-fork: %s pixel %d %u %u %u %u\n", who, i, p[0], p[1], p[2], p[3]);
      return 1;
    }
  }
  return 0;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  struct gl gl;
  if (setup(&gl) != 0) return 1;

  pid_t child = fork();
  if (child < 0) {
    printf("kgpu-egl-fork: fork failed\n");
    return 1;
  }
  if (child == 0) {
    who = "child";
    /* The inherited display is still valid to terminate; its contexts and
     * surfaces were the parent's. */
    if (!eglTerminate(gl.dpy)) _exit(egl_fail("eglTerminate"));
    if (setup(&gl) != 0 || render(&gl) != 0) _exit(1);
    if (!eglTerminate(gl.dpy)) _exit(egl_fail("eglTerminate"));
    printf("child ok\n");
    _exit(0);
  }

  int status = 0;
  if (waitpid(child, &status, 0) != child) {
    printf("kgpu-egl-fork: waitpid failed\n");
    return 1;
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    printf("kgpu-egl-fork: child status 0x%x\n", (unsigned)status);
    return 1;
  }
  if (render(&gl) != 0) return 1;
  if (!eglTerminate(gl.dpy)) return egl_fail("eglTerminate");
  printf("parent ok\n");
  return 0;
}
