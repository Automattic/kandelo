/*
 * sdl2gl-test (step 12c) — a minimal SDL2 GLES2 client that renders
 * through SDL2's UPSTREAM Wayland video backend against wlcompositor.
 *
 * This is the first program to exercise the full step-10/11/12 GL path
 * end to end through a real third-party toolkit:
 *
 *   SDL_CreateWindow(SDL_WINDOW_OPENGL)
 *     → SDL_waylandwindow.c: wl_egl_window_create(surface, w, h)
 *       → our shim (libc/glue/libwayland-egl.c) allocates a GPU-tier bo
 *         on the EGL session fd and wraps it as a zwp_linux_dmabuf_v1
 *         wl_buffer (step 11).
 *   SDL_GL_CreateContext / eglCreateWindowSurface(win)
 *     → libEGL (libegl_stub.c) reads the wl_egl_window's bo handle and
 *       targets its FBO as the client's default framebuffer (step 10).
 *   glClear / glDrawArrays ... (GLES2 draw)
 *   SDL_GL_SwapWindow → eglSwapBuffers
 *     → libEGL flush + GLIO_PRESENT (buffer-ready fence on the shared
 *       submit queue), then _wpk_wlegl_present → wl_surface.attach +
 *       damage + commit.
 *   → wlcompositor imports the dmabuf and, it being a GPU-tier bo,
 *     BIND_FOREIGN_TEXTURE returns the host texture id zero-copy.
 *
 * The whole chain is browser-only (WebGL2); Node vitest has no WebGL2,
 * so the gate for this program is the Playwright smoke
 * apps/browser-demos/test/kandelo-sdl2gl.spec.ts.
 *
 * Rendering: a spinning triangle (vertex colors) over a solid teal
 * clear. The teal background gives the compositor's COMPOSITE_SAMPLE
 * readback (sampled near the window's top-left) a stable non-black
 * pixel, while the spin keeps the surface changing so liveness gates
 * see fresh frames. Single reusable buffer (step-12 decision #2): the
 * window is fixed-size, no live resize.
 *
 * Markers on stdout (land in the compositor host's syslog stream):
 *   SDL2GL_UP driver=<name> w=<W> h=<H>   once the GL context is current
 *   SDL2GL_FRAME <n>                       periodically while rendering
 *   SDL2GL_DOWN                            on clean exit
 */
#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <unistd.h>

#define WIN_W 640
#define WIN_H 480

/* The Wayland socket SDL's backend connects to (WAYLAND_DISPLAY defaults
 * to "wayland-0", XDG_RUNTIME_DIR resolves it under /tmp here). */
#define WL_SOCKET_PATH "/tmp/wayland-0"

/*
 * Wait for the compositor to create + bind + listen its socket before
 * SDL_Init. SDL's Wayland backend calls wl_display_connect exactly once
 * and does NOT retry, so if we race ahead of the compositor's bind() the
 * connect returns NULL and SDL_Init(VIDEO) fails. The kwl test clients
 * (wlclient-test.c) retry connect() for the same reason; SDL can't, so
 * the client must wait for the socket file to appear first. Socket-file
 * existence is a good proxy: the compositor creates+binds+listens, then
 * clients can connect. A real SDL app started before its compositor
 * wants exactly this. Bounded so we never hang the smoke.
 */
static int wait_for_compositor(void)
{
    const int max_tries = 500; /* 500 * 10ms = ~5s */
    for (int i = 0; i < max_tries; i++) {
        if (access(WL_SOCKET_PATH, F_OK) == 0)
            return 0;
        if (i == 0) {
            printf("SDL2GL_WAIT socket=%s\n", WL_SOCKET_PATH);
            fflush(stdout);
        }
        usleep(10000); /* 10ms */
    }
    fprintf(stderr, "sdl2gl: timed out waiting for %s\n", WL_SOCKET_PATH);
    return -1;
}

static const char *VERT_SRC =
    "attribute vec2 a_pos;\n"
    "attribute vec3 a_col;\n"
    "uniform float u_angle;\n"
    "varying vec3 v_col;\n"
    "void main() {\n"
    "    float c = cos(u_angle), s = sin(u_angle);\n"
    "    mat2 r = mat2(c, -s, s, c);\n"
    "    gl_Position = vec4(r * a_pos, 0.0, 1.0);\n"
    "    v_col = a_col;\n"
    "}\n";

static const char *FRAG_SRC =
    "precision mediump float;\n"
    "varying vec3 v_col;\n"
    "void main() {\n"
    "    gl_FragColor = vec4(v_col, 1.0);\n"
    "}\n";

static GLuint compile_shader(GLenum type, const char *src)
{
    GLuint sh = glCreateShader(type);
    glShaderSource(sh, 1, &src, NULL);
    glCompileShader(sh);
    GLint ok = 0;
    glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[512];
        glGetShaderInfoLog(sh, sizeof(log), NULL, log);
        fprintf(stderr, "sdl2gl: shader compile failed: %s\n", log);
        return 0;
    }
    return sh;
}

int main(void)
{
    /* Force the Wayland backend regardless of any inherited env. */
    SDL_setenv("SDL_VIDEODRIVER", "wayland", 1);

    /* libwayland's wl_display_connect resolves the socket as
     * "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" and errors out if XDG_RUNTIME_DIR
     * is unset. wlcompositor binds /tmp/wayland-0 and documents /tmp as the
     * XDG_RUNTIME_DIR of this system (the only 1777 dir), so point the
     * client there. Don't overwrite a value a real session already set. */
    setenv("XDG_RUNTIME_DIR", "/tmp", 0);

    /* SDL's wl_display_connect does not retry — wait for the compositor
     * socket to exist before SDL_Init, or the connect races and fails. */
    if (wait_for_compositor() != 0)
        return 1;

    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        fprintf(stderr, "sdl2gl: SDL_Init(VIDEO): %s\n", SDL_GetError());
        return 1;
    }

    const char *driver = SDL_GetCurrentVideoDriver();
    if (!driver || SDL_strcmp(driver, "wayland") != 0) {
        fprintf(stderr, "sdl2gl: video driver = %s, expected wayland\n",
                driver ? driver : "(null)");
        SDL_Quit();
        return 1;
    }

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,
                        SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);

    SDL_Window *win = SDL_CreateWindow(
        "sdl2gl", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        WIN_W, WIN_H, SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN);
    if (!win) {
        fprintf(stderr, "sdl2gl: SDL_CreateWindow: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    SDL_GLContext ctx = SDL_GL_CreateContext(win);
    if (!ctx) {
        fprintf(stderr, "sdl2gl: SDL_GL_CreateContext: %s\n", SDL_GetError());
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    SDL_GL_MakeCurrent(win, ctx);
    SDL_GL_SetSwapInterval(0);

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
        fprintf(stderr, "sdl2gl: program link failed: %s\n", log);
        SDL_GL_DeleteContext(ctx);
        SDL_DestroyWindow(win);
        SDL_Quit();
        return 1;
    }
    glUseProgram(prog);
    GLint u_angle = glGetUniformLocation(prog, "u_angle");

    static const GLfloat verts[] = {
        /*  x      y      r     g     b   */
         0.0f,  0.6f,  1.0f, 0.2f, 0.2f,
        -0.6f, -0.5f,  0.2f, 1.0f, 0.2f,
         0.6f, -0.5f,  0.2f, 0.4f, 1.0f,
    };
    GLuint vbo = 0;
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 5 * sizeof(GLfloat),
                          (const void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 5 * sizeof(GLfloat),
                          (const void *)(2 * sizeof(GLfloat)));

    int w = WIN_W, h = WIN_H;
    SDL_GL_GetDrawableSize(win, &w, &h);
    glViewport(0, 0, w, h);
    printf("SDL2GL_UP driver=%s w=%d h=%d\n", driver, w, h);
    fflush(stdout);

    int running = 1;
    unsigned long frame = 0;
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) running = 0;
        }

        float angle = (float)frame * 0.03f;
        /* Solid teal clear — stable non-black backdrop for the
         * compositor's readback proof. */
        glClearColor(0.0f, 0.55f, 0.6f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glUniform1f(u_angle, angle);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        SDL_GL_SwapWindow(win);

        if ((frame % 30) == 0) {
            printf("SDL2GL_FRAME %lu\n", frame);
            fflush(stdout);
        }
        frame++;
        SDL_Delay(33); /* ~30 fps */
    }

    printf("SDL2GL_DOWN\n");
    fflush(stdout);
    glDeleteBuffers(1, &vbo);
    glDeleteProgram(prog);
    SDL_GL_DeleteContext(ctx);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
