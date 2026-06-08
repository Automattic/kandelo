/*
 * Spinning colored cube on wasm-posix-kernel — fork(2)+pipe(2) two-process demo.
 *
 * Architecture:
 *
 *   parent ── pipe[0] ── read frames ── upload VBO ── glDrawArrays
 *      │                                                      │
 *      └── fork(2) ────────────────────────┐                  │
 *                                          ▼                  ▼
 *   child  ── compute rotation matrix ── project 3D ── write pipe[1]
 *
 * The parent owns the GLES2 context (eglInitialize → eglMakeCurrent), so
 * forking after EGL setup would clone the cmdbuf fd and confuse the
 * host registry (one canvas, two cmdbufs). We fork *before* any GL
 * call, then only the parent enters the GL path.
 *
 * Per-frame: child computes a tumbling rotation from clock_gettime,
 * applies it + a perspective projection to the 8 cube vertices,
 * expands to 36 triangle vertices (6 faces × 2 tris × 3 verts), and
 * writes one frame's worth of (x,y,z,r,g,b) floats to the pipe. Frame
 * size is 36 * 24 = 864 bytes — well under PIPE_BUF, so each write is
 * atomic and the parent reads exactly one frame per render.
 *
 * The vertex shader is a pass-through: projection is already done CPU-side
 * because the GLES2 stub doesn't carry uniforms. Depth testing in the
 * GPU does the occlusion (24-bit depth requested in the EGL config).
 */

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CANVAS_W  768
#define CANVAS_H  768
#define VERTS     36
#define VERT_SZ   (6 * sizeof(float))   /* x,y,z,r,g,b */
#define FRAME_SZ  (VERTS * VERT_SZ)     /* 864 bytes — atomic over pipe */
#define FRAME_USEC 16000                /* ~60 Hz */

/* The 8 corners of a unit cube centred on the origin. */
static const float cube_v[8][3] = {
    {-1, -1, -1}, { 1, -1, -1}, { 1,  1, -1}, {-1,  1, -1},
    {-1, -1,  1}, { 1, -1,  1}, { 1,  1,  1}, {-1,  1,  1},
};

/* 6 faces, each two triangles, indexing into cube_v.
 * Order chosen so the outward normal points away from the centre when
 * traversed counter-clockwise — matters for any future face culling but
 * not for the depth-test path used here. */
static const int faces[6][6] = {
    {0,1,2, 0,2,3}, /* -Z */
    {4,6,5, 4,7,6}, /* +Z */
    {0,4,5, 0,5,1}, /* -Y */
    {3,2,6, 3,6,7}, /* +Y */
    {0,3,7, 0,7,4}, /* -X */
    {1,5,6, 1,6,2}, /* +X */
};

/* Classic 6-color cube palette (red, green, blue, yellow, cyan, magenta). */
static const float face_col[6][3] = {
    {1.00, 0.20, 0.20},
    {0.20, 0.85, 0.30},
    {0.25, 0.45, 1.00},
    {1.00, 0.85, 0.20},
    {0.20, 0.85, 0.95},
    {0.95, 0.30, 0.85},
};

static double monotonic_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

/* SIGUSR1 toggles the paused flag in the *child*. The browser's
 * Stop/Resume buttons send the signal directly to the child pid
 * (parsed from the parent's stdout banner) via kernel.sendSignal.
 *
 * Why the child and not the parent: the child parks in usleep(2)
 * between frames (pendingSleeps in centralized mode), which
 * sendSignalToProcess wakes via completeSleepWithSignalCheck — the
 * EINTR path delivers the signal cleanly and the user-space handler
 * runs. The parent parks in read(2) on the pipe (pendingPipeReaders),
 * which sendSignalToProcess does NOT wake, so signalling it would
 * leave the signal queued indefinitely. */
static volatile sig_atomic_t paused = 0;

static void on_pause_toggle(int sig) {
    (void)sig;
    paused = !paused;
}

/* ────────────────────────────────────────────────────────────────────
 * Child process: simulate rotation, project to clip space, ship frame.
 * ──────────────────────────────────────────────────────────────────── */

/* 3x3 rotation: rotate `v` around X by ax, then around Y by ay. */
static void rotate(const float v[3], float ax, float ay, float out[3]) {
    float cx = cosf(ax), sx = sinf(ax);
    float cy = cosf(ay), sy = sinf(ay);
    /* Rx then Ry: out = Ry · Rx · v. */
    float y1 =  cx * v[1] - sx * v[2];
    float z1 =  sx * v[1] + cx * v[2];
    float x2 =  cy * v[0] + sy * z1;
    float z2 = -sy * v[0] + cy * z1;
    out[0] = x2;
    out[1] = y1;
    out[2] = z2;
}

/* Pull the cube back from the camera and apply a simple perspective:
 * x' = x * f / (z + d), y' = y * f / (z + d). z' encodes the post-translate
 * depth in [-1, 1]ish — only the relative ordering matters for the
 * GPU depth test. */
static void project(const float v[3], float out[3]) {
    const float dist = 4.0f;
    const float focal = 1.1f;
    float zc = v[2] + dist;
    if (zc < 0.1f) zc = 0.1f;
    out[0] = v[0] * focal / zc;
    out[1] = v[1] * focal / zc;
    /* Map z roughly into clip space: closer = smaller (renders in front
     * with default GL_LESS depth func). The constants are picked so all
     * 8 corners stay in the [-0.95, 0.95] range. */
    out[2] = (zc - dist) * 0.25f;
}

static void child_loop(int write_fd) {
    /* Parent died → write returns EPIPE → exit cleanly without a signal. */
    signal(SIGPIPE, SIG_IGN);
    /* SIGUSR1 (browser Stop/Resume) flips `paused` and interrupts usleep. */
    signal(SIGUSR1, on_pause_toggle);

    float frame[VERTS * 6];
    /* Pause-aware clock: `t0` is the monotonic instant the cube would
     * have started at if it had been running continuously. While
     * paused we keep advancing it forward so the un-pause picks up at
     * the same angle the pause hit. */
    double t0 = monotonic_seconds();
    double pause_started = 0;

    for (;;) {
        if (paused) {
            if (pause_started == 0) pause_started = monotonic_seconds();
            usleep(FRAME_USEC);
            continue;
        }
        if (pause_started != 0) {
            t0 += monotonic_seconds() - pause_started;
            pause_started = 0;
        }
        double t = monotonic_seconds() - t0;
        float ax = (float)(t * 0.7);
        float ay = (float)(t * 0.9);

        /* Transform all 8 cube corners once per frame. */
        float xv[8][3];
        for (int i = 0; i < 8; i++) {
            float r[3];
            rotate(cube_v[i], ax, ay, r);
            project(r, xv[i]);
        }

        /* Expand to 36 triangle vertices, attaching the face colour. */
        float *p = frame;
        for (int f = 0; f < 6; f++) {
            const int *idx = faces[f];
            for (int j = 0; j < 6; j++) {
                const float *v = xv[idx[j]];
                *p++ = v[0]; *p++ = v[1]; *p++ = v[2];
                *p++ = face_col[f][0];
                *p++ = face_col[f][1];
                *p++ = face_col[f][2];
            }
        }

        const char *buf = (const char *)frame;
        size_t left = FRAME_SZ;
        while (left > 0) {
            ssize_t w = write(write_fd, buf, left);
            if (w < 0) {
                if (errno == EINTR) continue;
                _exit(0);   /* parent gone — quietly exit */
            }
            buf += w;
            left -= (size_t)w;
        }

        usleep(FRAME_USEC);
    }
}

/* ────────────────────────────────────────────────────────────────────
 * Parent process: GLES2 setup, per-frame VBO upload, draw, present.
 * ──────────────────────────────────────────────────────────────────── */

static const char vs_src[] =
    "attribute vec3 a_pos;\n"
    "attribute vec3 a_col;\n"
    "varying vec3 v_col;\n"
    "void main() { gl_Position = vec4(a_pos, 1.0); v_col = a_col; }\n";

static const char fs_src[] =
    "precision mediump float;\n"
    "varying vec3 v_col;\n"
    "void main() { gl_FragColor = vec4(v_col, 1.0); }\n";

/* Read exactly `n` bytes or return -1 on EOF/error. Frames are
 * single-write atomic on the producer side (FRAME_SZ < PIPE_BUF), but
 * the consumer can still see split reads if it races the writer mid-
 * write — loop just in case. */
static int read_full(int fd, void *buf, size_t n) {
    char *p = (char *)buf;
    while (n > 0) {
        ssize_t r = read(fd, p, n);
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (r == 0) return -1;   /* child exited */
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

static int parent_loop(int read_fd, pid_t child_pid) {
    (void)child_pid;  /* only used for logging (FPS line); browser drives pause */
    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint maj = 0, min = 0;
    if (!eglInitialize(dpy, &maj, &min)) return 1;

    EGLint cfg_attribs[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, 24,
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_NONE,
    };
    EGLConfig cfg;
    EGLint num_cfg = 0;
    if (!eglChooseConfig(dpy, cfg_attribs, &cfg, 1, &num_cfg) || num_cfg < 1) return 2;
    if (!eglBindAPI(EGL_OPENGL_ES_API)) return 3;

    EGLint ctx_attribs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctx_attribs);
    if (ctx == EGL_NO_CONTEXT) return 4;

    EGLSurface surf = eglCreateWindowSurface(dpy, cfg, 0, 0);
    if (surf == EGL_NO_SURFACE) return 5;
    if (!eglMakeCurrent(dpy, surf, surf, ctx)) return 6;

    GLuint vs = glCreateShader(GL_VERTEX_SHADER);
    const char *vs_p = vs_src; glShaderSource(vs, 1, &vs_p, 0); glCompileShader(vs);
    GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
    const char *fs_p = fs_src; glShaderSource(fs, 1, &fs_p, 0); glCompileShader(fs);

    GLuint prog = glCreateProgram();
    glAttachShader(prog, vs);
    glAttachShader(prog, fs);
    glBindAttribLocation(prog, 0, "a_pos");
    glBindAttribLocation(prog, 1, "a_col");
    glLinkProgram(prog);
    glUseProgram(prog);

    GLuint vbo;
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);

    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, (GLsizei)VERT_SZ, (const void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, (GLsizei)VERT_SZ, (const void *)(3 * sizeof(float)));

    glViewport(0, 0, CANVAS_W, CANVAS_H);
    glEnable(GL_DEPTH_TEST);

    float frame[VERTS * 6];
    double last_fps_at = monotonic_seconds();
    unsigned frames = 0;
    int rc = 0;

    /* Plain blocking read on the pipe — when the child is paused it
     * stops writing, so this read parks until the child resumes. */
    for (;;) {
        if (read_full(read_fd, frame, FRAME_SZ) < 0) break;

        glClearColor(0.05f, 0.06f, 0.10f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)FRAME_SZ, frame, GL_DYNAMIC_DRAW);
        glDrawArrays(GL_TRIANGLES, 0, VERTS);

        if (!eglSwapBuffers(dpy, surf)) { rc = 7; break; }

        frames++;
        double now = monotonic_seconds();
        if (now - last_fps_at >= 1.0) {
            printf("cube: %u fps (child pid %d)\n", frames, (int)child_pid);
            fflush(stdout);
            frames = 0;
            last_fps_at = now;
        }
    }

    glDeleteShader(vs);
    glDeleteShader(fs);
    glDeleteProgram(prog);
    eglDestroySurface(dpy, surf);
    eglDestroyContext(dpy, ctx);
    eglTerminate(dpy);
    return rc;
}

/* ────────────────────────────────────────────────────────────────────
 * main: pipe + fork. Parent owns GL, child owns the math.
 * ──────────────────────────────────────────────────────────────────── */

int main(void) {
    int fds[2];
    if (pipe(fds) != 0) {
        perror("pipe");
        return 10;
    }

    pid_t k = fork();
    if (k < 0) {
        perror("fork");
        return 11;
    }

    if (k == 0) {
        close(fds[0]);
        child_loop(fds[1]);
        _exit(0);
    }

    /* Parent. No SIGUSR1 handler here — the browser sends Stop/Resume
     * SIGUSR1s directly to the child pid (via kernel.sendSignal),
     * never to the parent. Default-action SIGUSR1 on a process with
     * no handler is Terminate, but since nothing signals the parent
     * that's fine. */
    close(fds[1]);
    printf("cube: forked child pid %d, parent pid %d\n",
           (int)k, (int)getpid());
    fflush(stdout);

    int rc = parent_loop(fds[0], k);

    /* Best-effort tidy: child will EPIPE-out on next write once we
     * close the read end. */
    close(fds[0]);
    int status = 0;
    waitpid(k, &status, WNOHANG);
    return rc;
}
