/*
 * Two processes each drive their own GL context on /dev/dri/renderD128:
 * parent renders a spinning cube into the left half, child a spinning
 * pyramid into the right half. fork() runs before eglInitialize so
 * each side opens its own renderD128 fd. Per-half GL_SCISSOR_TEST
 * scopes each glClear; a pipe handshake keeps the animation in
 * lockstep. argv[1] caps the frame count (tests use this); default
 * is infinite.
 */

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CANVAS_W 1536
#define CANVAS_H 768
#define VERT_SZ  (6 * sizeof(float))
#define FRAMES_INFINITE (-1)
#define FRAME_USLEEP    16000

#define CUBE_VERTS  36
static const float cube_v[8][3] = {
    {-1, -1, -1}, { 1, -1, -1}, { 1,  1, -1}, {-1,  1, -1},
    {-1, -1,  1}, { 1, -1,  1}, { 1,  1,  1}, {-1,  1,  1},
};
static const int cube_faces[6][6] = {
    {0,1,2, 0,2,3},
    {4,6,5, 4,7,6},
    {0,4,5, 0,5,1},
    {3,2,6, 3,6,7},
    {0,3,7, 0,7,4},
    {1,5,6, 1,6,2},
};
static const float cube_palette[6][3] = {
    {1.00, 0.20, 0.20}, {0.95, 0.45, 0.30},
    {0.85, 0.30, 0.35}, {1.00, 0.55, 0.25},
    {0.90, 0.25, 0.45}, {1.00, 0.40, 0.20},
};

#define PYRAMID_VERTS  18
static const float pyramid_v[5][3] = {
    {-1, -1, -1}, { 1, -1, -1}, { 1,  1, -1}, {-1,  1, -1},
    { 0,  0,  1},
};
static const int pyramid_faces[6][3] = {
    {0, 2, 1}, {0, 3, 2},
    {0, 1, 4}, {1, 2, 4}, {2, 3, 4}, {3, 0, 4},
};
static const float pyramid_palette[6][3] = {
    {0.15, 0.20, 0.50}, {0.15, 0.20, 0.50},
    {0.30, 0.55, 1.00}, {0.20, 0.40, 0.95},
    {0.40, 0.70, 1.00}, {0.25, 0.45, 0.85},
};

static const char vs_src[] =
    "attribute vec3 a_pos;\n"
    "attribute vec3 a_col;\n"
    "varying vec3 v_col;\n"
    "void main() { gl_Position = vec4(a_pos, 1.0); v_col = a_col; }\n";

static const char fs_src[] =
    "precision mediump float;\n"
    "varying vec3 v_col;\n"
    "void main() { gl_FragColor = vec4(v_col, 1.0); }\n";

static double monotonic_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void rotate(const float v[3], float ax, float ay, float out[3]) {
    float cx = cosf(ax), sx = sinf(ax);
    float cy = cosf(ay), sy = sinf(ay);
    float y1 =  cx * v[1] - sx * v[2];
    float z1 =  sx * v[1] + cx * v[2];
    float x2 =  cy * v[0] + sy * z1;
    float z2 = -sy * v[0] + cy * z1;
    out[0] = x2; out[1] = y1; out[2] = z2;
}

static void project(const float v[3], float out[3]) {
    const float dist = 4.0f;
    const float focal = 1.1f;
    float zc = v[2] + dist;
    if (zc < 0.1f) zc = 0.1f;
    out[0] = v[0] * focal / zc;
    out[1] = v[1] * focal / zc;
    out[2] = (zc - dist) * 0.25f;
}

static void build_cube_frame(double t, float *out) {
    float ax = (float)(t * 0.7);
    float ay = (float)(t * 0.9);
    float tx = 0.45f * sinf((float)(t * 0.5));
    float ty = 0.45f * cosf((float)(t * 0.4));
    float xv[8][3];
    for (int i = 0; i < 8; i++) {
        float r[3];
        rotate(cube_v[i], ax, ay, r);
        project(r, xv[i]);
        xv[i][0] += tx;
        xv[i][1] += ty;
    }
    float *p = out;
    for (int f = 0; f < 6; f++) {
        const int *idx = cube_faces[f];
        for (int j = 0; j < 6; j++) {
            const float *v = xv[idx[j]];
            *p++ = v[0]; *p++ = v[1]; *p++ = v[2];
            *p++ = cube_palette[f][0]; *p++ = cube_palette[f][1]; *p++ = cube_palette[f][2];
        }
    }
}

static void build_pyramid_frame(double t, float *out) {
    float ax = (float)(t * 0.6);
    float ay = (float)(t * 1.1);
    float tx = 0.45f * cosf((float)(t * 0.45));
    float ty = 0.45f * sinf((float)(t * 0.6));
    float xv[5][3];
    for (int i = 0; i < 5; i++) {
        float r[3];
        rotate(pyramid_v[i], ax, ay, r);
        project(r, xv[i]);
        xv[i][0] += tx;
        xv[i][1] += ty;
    }
    float *p = out;
    for (int f = 0; f < 6; f++) {
        const int *idx = pyramid_faces[f];
        for (int j = 0; j < 3; j++) {
            const float *v = xv[idx[j]];
            *p++ = v[0]; *p++ = v[1]; *p++ = v[2];
            *p++ = pyramid_palette[f][0]; *p++ = pyramid_palette[f][1]; *p++ = pyramid_palette[f][2];
        }
    }
}

static int gl_setup(int viewport_x, int viewport_w,
                    EGLDisplay *out_dpy, EGLSurface *out_surf) {
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

    glViewport(viewport_x, 0, viewport_w, CANVAS_H);
    glEnable(GL_SCISSOR_TEST);
    glScissor(viewport_x, 0, viewport_w, CANVAS_H);
    glEnable(GL_DEPTH_TEST);
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);

    *out_dpy = dpy;
    *out_surf = surf;
    return 0;
}

static int draw_parent_loop(int go_fd, int done_fd, int frames) {
    EGLDisplay dpy;
    EGLSurface surf;
    int rc = gl_setup(0, CANVAS_W / 2, &dpy, &surf);
    if (rc) return rc;

    float frame[CUBE_VERTS * 6];
    double t0 = monotonic_seconds();
    int loop_rc = 0;

    for (int i = 0; frames < 0 || i < frames; i++) {
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        build_cube_frame(monotonic_seconds() - t0, frame);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)sizeof(frame), frame, GL_DYNAMIC_DRAW);
        glDrawArrays(GL_TRIANGLES, 0, CUBE_VERTS);
        if (!eglSwapBuffers(dpy, surf)) { loop_rc = 7; break; }

        char b = 'g';
        if (write(go_fd, &b, 1) != 1) { loop_rc = 8; break; }
        if (read(done_fd, &b, 1) != 1) { loop_rc = 9; break; }

        usleep(FRAME_USLEEP);
    }

    eglDestroySurface(dpy, surf);
    eglTerminate(dpy);
    return loop_rc;
}

static int draw_child_loop(int go_fd, int done_fd, int frames) {
    EGLDisplay dpy;
    EGLSurface surf;
    int rc = gl_setup(CANVAS_W / 2, CANVAS_W / 2, &dpy, &surf);
    if (rc) return rc;

    float frame[PYRAMID_VERTS * 6];
    double t0 = monotonic_seconds();
    int loop_rc = 0;

    for (int i = 0; frames < 0 || i < frames; i++) {
        char b;
        if (read(go_fd, &b, 1) != 1) { loop_rc = 8; break; }

        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        build_pyramid_frame(monotonic_seconds() - t0, frame);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)sizeof(frame), frame, GL_DYNAMIC_DRAW);
        glDrawArrays(GL_TRIANGLES, 0, PYRAMID_VERTS);
        if (!eglSwapBuffers(dpy, surf)) { loop_rc = 9; break; }

        b = 'd';
        if (write(done_fd, &b, 1) != 1) { loop_rc = 10; break; }
    }

    eglDestroySurface(dpy, surf);
    eglTerminate(dpy);
    return loop_rc;
}

int main(int argc, char **argv) {
    int frames = FRAMES_INFINITE;
    if (argc > 1) {
        int n = atoi(argv[1]);
        if (n > 0) frames = n;
    }

    int go_pipe[2];
    int done_pipe[2];
    if (pipe(go_pipe) < 0 || pipe(done_pipe) < 0) {
        perror("pipe");
        return 10;
    }

    pid_t k = fork();
    if (k < 0) {
        perror("fork");
        return 11;
    }

    if (k == 0) {
        close(go_pipe[1]);
        close(done_pipe[0]);
        _exit(draw_child_loop(go_pipe[0], done_pipe[1], frames));
    }

    close(go_pipe[0]);
    close(done_pipe[1]);

    int parent_rc = draw_parent_loop(go_pipe[1], done_pipe[0], frames);

    int status = 0;
    waitpid(k, &status, 0);
    int child_rc = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    printf("cube_pyramid: parent pid=%d rc=%d, child pid=%d rc=%d\n",
           (int)getpid(), parent_rc, (int)k, child_rc);
    fflush(stdout);
    return (parent_rc == 0 && child_rc == 0) ? 0 : 1;
}
