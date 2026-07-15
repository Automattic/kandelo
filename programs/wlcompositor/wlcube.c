/*
 * wlcube (step 13) — a RAW libwayland-egl GLES2 client that renders a
 * spinning cube through wlcompositor with NO toolkit in between. Where
 * sdl2gl-test (step 12) proved the GPU-bo/dmabuf GL path under SDL2, wlcube
 * drives the same path directly against the standard wl_egl_window / libEGL
 * entry points a mesa client uses. The chain is described in
 * docs/architecture.md; browser-only (WebGL2), gated by kandelo-wlcube.spec.ts.
 *
 * The GPU-tier bo's FBO is color-only (no depth attachment), so occlusion is
 * resolved with back-face culling alone: a convex opaque solid's front faces
 * tile its silhouette without overlap, so no depth test is needed. Every face
 * is wound CCW when viewed from outside and GL_CULL_FACE is enabled; WebGL2's
 * defaults (cull GL_BACK, front GL_CCW) then remove the away-facing faces. A
 * depth attachment (needed for arbitrary non-convex 3D) is tracked as follow-up.
 *
 * Markers on stdout (-> compositor host syslog):
 *   WLCUBE_UP w=<W> h=<H> / WLCUBE_FRAME <n> / WLCUBE_DOWN
 */
#include <math.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include <wayland-egl.h>
#include "xdg-shell-client-protocol.h"

#include <EGL/egl.h>
#include <GLES2/gl2.h>

#define WL_SOCKET_PATH "/tmp/wayland-0"
#define WIN_W 640
#define WIN_H 480

struct client {
    struct wl_compositor *compositor;
    struct xdg_wm_base   *wm_base;

    struct wl_surface  *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;

    int configured;   /* got + acked the initial xdg configure */
    int running;      /* cleared on xdg_toplevel.close */
};

/* ---- registry ---------------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    struct client *c = data;
    if (strcmp(iface, "wl_compositor") == 0)
        c->compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                         version < 4 ? version : 4);
    else if (strcmp(iface, "xdg_wm_base") == 0)
        c->wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    /* zwp_linux_dmabuf_v1 is bound by the wl_egl_window shim itself, on a
     * private event queue — the client never touches it directly. */
}
static void registry_global_remove(void *data, struct wl_registry *r,
                                    uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

/* ---- xdg_shell --------------------------------------------------------- */

static void wm_base_ping(void *data, struct xdg_wm_base *b, uint32_t serial) {
    xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};
static void xdg_surface_configure(void *data, struct xdg_surface *xs,
                                  uint32_t serial) {
    struct client *c = data;
    xdg_surface_ack_configure(xs, serial);
    c->configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};
static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w,
                               int32_t h, struct wl_array *states) {}
static void toplevel_close(void *data, struct xdg_toplevel *t) {
    struct client *c = data;
    c->running = 0;
}
static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configure,
    .close = toplevel_close,
};

/* ---- socket ------------------------------------------------------------ */

/* Connect the socket directly and hand the fd to wl_display_connect_to_fd,
 * sidestepping libwayland's $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY resolution so a
 * raw client needn't depend on the session env being set. The retry loop
 * covers the compositor's bind() race. */
static int connect_socket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, WL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    for (int i = 0; i < 500; i++) {   /* ~5s: compositor bind() race */
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0)
            return fd;
        usleep(10000);
    }
    perror("connect");
    close(fd);
    return -1;
}

/* Non-blocking libwayland pump: read + dispatch only if the socket already
 * has data (poll, 0 timeout), so the render loop never stalls on the
 * compositor while still servicing ping/pong, configure, and buffer-release.
 * prepare_read is balanced by exactly one of read_events / cancel_read. */
static void pump_display(struct wl_display *d) {
    while (wl_display_prepare_read(d) != 0)
        wl_display_dispatch_pending(d);
    wl_display_flush(d);
    struct pollfd pfd = { .fd = wl_display_get_fd(d), .events = POLLIN, .revents = 0 };
    if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN))
        wl_display_read_events(d);
    else
        wl_display_cancel_read(d);
    wl_display_dispatch_pending(d);
}

/* ---- GL ---------------------------------------------------------------- */

static const char *VERT_SRC =
    "attribute vec3 a_pos;\n"
    "attribute vec3 a_col;\n"
    "uniform mat4 u_mvp;\n"
    "varying vec3 v_col;\n"
    "void main() {\n"
    "    gl_Position = u_mvp * vec4(a_pos, 1.0);\n"
    "    v_col = a_col;\n"
    "}\n";

static const char *FRAG_SRC =
    "precision mediump float;\n"
    "varying vec3 v_col;\n"
    "void main() {\n"
    "    gl_FragColor = vec4(v_col, 1.0);\n"
    "}\n";

static GLuint compile_shader(GLenum type, const char *src) {
    GLuint sh = glCreateShader(type);
    glShaderSource(sh, 1, &src, NULL);
    glCompileShader(sh);
    GLint ok = 0;
    glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[512];
        glGetShaderInfoLog(sh, sizeof(log), NULL, log);
        fprintf(stderr, "wlcube: shader compile failed: %s\n", log);
        return 0;
    }
    return sh;
}

/* Unit cube [-0.5,0.5]^3: 36 verts of {x,y,z, r,g,b}, every face wound CCW
 * when viewed from outside (see the occlusion note in the header). */
static const GLfloat CUBE[] = {
    /* +Z (front) — red */
    -0.5f,-0.5f, 0.5f, 0.9f,0.2f,0.2f,   0.5f,-0.5f, 0.5f, 0.9f,0.2f,0.2f,   0.5f, 0.5f, 0.5f, 0.9f,0.2f,0.2f,
    -0.5f,-0.5f, 0.5f, 0.9f,0.2f,0.2f,   0.5f, 0.5f, 0.5f, 0.9f,0.2f,0.2f,  -0.5f, 0.5f, 0.5f, 0.9f,0.2f,0.2f,
    /* -Z (back) — green */
    -0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.3f,  -0.5f, 0.5f,-0.5f, 0.2f,0.8f,0.3f,   0.5f, 0.5f,-0.5f, 0.2f,0.8f,0.3f,
    -0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.3f,   0.5f, 0.5f,-0.5f, 0.2f,0.8f,0.3f,   0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.3f,
    /* -X (left) — blue */
    -0.5f,-0.5f,-0.5f, 0.3f,0.4f,0.95f, -0.5f,-0.5f, 0.5f, 0.3f,0.4f,0.95f, -0.5f, 0.5f, 0.5f, 0.3f,0.4f,0.95f,
    -0.5f,-0.5f,-0.5f, 0.3f,0.4f,0.95f, -0.5f, 0.5f, 0.5f, 0.3f,0.4f,0.95f, -0.5f, 0.5f,-0.5f, 0.3f,0.4f,0.95f,
    /* +X (right) — yellow */
     0.5f,-0.5f,-0.5f, 0.95f,0.85f,0.2f, 0.5f, 0.5f,-0.5f, 0.95f,0.85f,0.2f, 0.5f, 0.5f, 0.5f, 0.95f,0.85f,0.2f,
     0.5f,-0.5f,-0.5f, 0.95f,0.85f,0.2f, 0.5f, 0.5f, 0.5f, 0.95f,0.85f,0.2f, 0.5f,-0.5f, 0.5f, 0.95f,0.85f,0.2f,
    /* +Y (top) — magenta */
    -0.5f, 0.5f,-0.5f, 0.85f,0.3f,0.85f,-0.5f, 0.5f, 0.5f, 0.85f,0.3f,0.85f, 0.5f, 0.5f, 0.5f, 0.85f,0.3f,0.85f,
    -0.5f, 0.5f,-0.5f, 0.85f,0.3f,0.85f, 0.5f, 0.5f, 0.5f, 0.85f,0.3f,0.85f, 0.5f, 0.5f,-0.5f, 0.85f,0.3f,0.85f,
    /* -Y (bottom) — cyan */
    -0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.85f,  0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.85f,  0.5f,-0.5f, 0.5f, 0.2f,0.8f,0.85f,
    -0.5f,-0.5f,-0.5f, 0.2f,0.8f,0.85f,  0.5f,-0.5f, 0.5f, 0.2f,0.8f,0.85f, -0.5f,-0.5f, 0.5f, 0.2f,0.8f,0.85f,
};
#define CUBE_VERTS 36

/* ---- column-major 4x4 matrix math (OpenGL convention) ------------------ */

static void mat4_identity(float *m) {
    memset(m, 0, 16 * sizeof(float));
    m[0] = m[5] = m[10] = m[15] = 1.0f;
}
static void mat4_mul(float *out, const float *a, const float *b) {
    float r[16];
    for (int col = 0; col < 4; col++)
        for (int row = 0; row < 4; row++) {
            float s = 0.0f;
            for (int k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
            r[col * 4 + row] = s;
        }
    memcpy(out, r, sizeof r);
}
static void mat4_perspective(float *m, float fovy, float aspect,
                             float zn, float zf) {
    float f = 1.0f / tanf(fovy * 0.5f);
    memset(m, 0, 16 * sizeof(float));
    m[0]  = f / aspect;
    m[5]  = f;
    m[10] = (zf + zn) / (zn - zf);
    m[11] = -1.0f;
    m[14] = (2.0f * zf * zn) / (zn - zf);
}
static void mat4_translate(float *m, float x, float y, float z) {
    mat4_identity(m);
    m[12] = x; m[13] = y; m[14] = z;
}
static void mat4_rotate_x(float *m, float a) {
    mat4_identity(m);
    float c = cosf(a), s = sinf(a);
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
}
static void mat4_rotate_y(float *m, float a) {
    mat4_identity(m);
    float c = cosf(a), s = sinf(a);
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
}

int main(void) {
    struct client c;
    memset(&c, 0, sizeof(c));
    c.running = 1;

    int fd = connect_socket();
    if (fd < 0) return 1;
    struct wl_display *display = wl_display_connect_to_fd(fd);
    if (!display) { fprintf(stderr, "wlcube: wl_display_connect_to_fd\n"); return 1; }

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, &c);
    wl_display_roundtrip(display);   /* receive globals */

    if (!c.compositor || !c.wm_base) {
        fprintf(stderr, "wlcube: missing globals: comp=%p wm=%p\n",
                (void *)c.compositor, (void *)c.wm_base);
        return 1;
    }
    xdg_wm_base_add_listener(c.wm_base, &wm_base_listener, &c);

    c.surface = wl_compositor_create_surface(c.compositor);
    c.xdg_surface = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
    xdg_surface_add_listener(c.xdg_surface, &xdg_surface_listener, &c);
    c.toplevel = xdg_surface_get_toplevel(c.xdg_surface);
    xdg_toplevel_add_listener(c.toplevel, &toplevel_listener, &c);
    xdg_toplevel_set_title(c.toplevel, "wlcube");
    wl_surface_commit(c.surface);

    while (!c.configured)
        if (wl_display_dispatch(display) < 0) {
            fprintf(stderr, "wlcube: dispatch (configure)\n");
            return 1;
        }

    /* eglInitialize must precede wl_egl_window_create: the shim allocates its
     * GPU-tier bo on the renderD128 fd that eglInitialize opens. */
    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL)) {
        fprintf(stderr, "wlcube: eglInitialize failed (0x%x)\n", eglGetError());
        return 1;
    }
    eglBindAPI(EGL_OPENGL_ES_API);

    const EGLint cfg_attrs[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    EGLConfig config;
    EGLint num_config = 0;
    if (!eglChooseConfig(dpy, cfg_attrs, &config, 1, &num_config) || num_config < 1) {
        fprintf(stderr, "wlcube: eglChooseConfig failed (0x%x)\n", eglGetError());
        return 1;
    }

    struct wl_egl_window *egl_window =
        wl_egl_window_create(c.surface, WIN_W, WIN_H);
    if (!egl_window) {
        fprintf(stderr, "wlcube: wl_egl_window_create failed\n");
        return 1;
    }

    const EGLint ctx_attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, config, EGL_NO_CONTEXT, ctx_attrs);
    if (ctx == EGL_NO_CONTEXT) {
        fprintf(stderr, "wlcube: eglCreateContext failed (0x%x)\n", eglGetError());
        return 1;
    }
    EGLSurface surf = eglCreateWindowSurface(
        dpy, config, (EGLNativeWindowType)egl_window, NULL);
    if (surf == EGL_NO_SURFACE) {
        fprintf(stderr, "wlcube: eglCreateWindowSurface failed (0x%x)\n", eglGetError());
        return 1;
    }
    if (!eglMakeCurrent(dpy, surf, surf, ctx)) {
        fprintf(stderr, "wlcube: eglMakeCurrent failed (0x%x)\n", eglGetError());
        return 1;
    }
    eglSwapInterval(dpy, 0);

    GLuint vs = compile_shader(GL_VERTEX_SHADER, VERT_SRC);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, FRAG_SRC);
    GLuint prog = glCreateProgram();
    glAttachShader(prog, vs);
    glAttachShader(prog, fs);
    glBindAttribLocation(prog, 0, "a_pos");
    glBindAttribLocation(prog, 1, "a_col");
    glLinkProgram(prog);
    GLint linked = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &linked);
    if (!linked) {
        char log[512];
        glGetProgramInfoLog(prog, sizeof(log), NULL, log);
        fprintf(stderr, "wlcube: program link failed: %s\n", log);
        return 1;
    }
    glUseProgram(prog);
    GLint u_mvp = glGetUniformLocation(prog, "u_mvp");

    GLuint vbo = 0;
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(CUBE), CUBE, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(GLfloat),
                          (const void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 6 * sizeof(GLfloat),
                          (const void *)(3 * sizeof(GLfloat)));

    glEnable(GL_CULL_FACE);
    glViewport(0, 0, WIN_W, WIN_H);

    float proj[16];
    mat4_perspective(proj, 0.7854f /* 45deg */,
                     (float)WIN_W / (float)WIN_H, 1.0f, 10.0f);

    printf("WLCUBE_UP w=%d h=%d\n", WIN_W, WIN_H);
    fflush(stdout);

    unsigned long frame = 0;
    while (c.running) {
        pump_display(display);

        float angle = (float)frame * 0.02f;
        float rot_y[16], rot_x[16], model[16], view[16], mv[16], mvp[16];
        mat4_rotate_y(rot_y, angle);
        mat4_rotate_x(rot_x, angle * 0.6f);
        mat4_mul(model, rot_y, rot_x);
        mat4_translate(view, 0.0f, 0.0f, -4.0f);
        mat4_mul(mv, view, model);
        mat4_mul(mvp, proj, mv);

        /* Teal clear: a stable non-black backdrop for the compositor's
         * top-left COMPOSITE_SAMPLE readback proof. */
        glClearColor(0.0f, 0.55f, 0.6f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glUniformMatrix4fv(u_mvp, 1, GL_FALSE, mvp);
        glDrawArrays(GL_TRIANGLES, 0, CUBE_VERTS);
        eglSwapBuffers(dpy, surf);
        wl_display_flush(display);

        if ((frame % 30) == 0) {
            printf("WLCUBE_FRAME %lu\n", frame);
            fflush(stdout);
        }
        frame++;
        usleep(33000); /* ~30 fps */
    }

    printf("WLCUBE_DOWN\n");
    fflush(stdout);
    glDeleteBuffers(1, &vbo);
    glDeleteProgram(prog);
    eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(dpy, surf);
    eglDestroyContext(dpy, ctx);
    wl_egl_window_destroy(egl_window);
    eglTerminate(dpy);
    wl_display_disconnect(display);
    return 0;
}
