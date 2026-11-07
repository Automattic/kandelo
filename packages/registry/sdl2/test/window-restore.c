/* A fresh machine has no scanout framebuffer. SDL's temporary preferred mode
 * must not turn that saved disabled state into an invalid restore request. */
#include <SDL2/SDL.h>
#include <SDL2/SDL_opengles2.h>
#include <xf86drmMode.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

static unsigned errors;
static void record_log(void *userdata, int category, SDL_LogPriority priority,
                       const char *message)
{
    (void)userdata;
    (void)category;
    if (priority >= SDL_LOG_PRIORITY_ERROR) errors++;
    /* Preserve the real diagnostic; counting it must not hide a failure. */
    fprintf(stderr, "SDL[%d]: %s\n", priority, message);
}

static int disabled(void)
{
    int fd = open("/dev/dri/card0", O_RDWR);
    if (fd < 0) { perror("open DRM observer"); return 0; }
    drmModeRes *resources = drmModeGetResources(fd);
    drmModeCrtc *crtc = resources && resources->count_crtcs > 0
        ? drmModeGetCrtc(fd, resources->crtcs[0]) : NULL;
    int result = crtc && !crtc->mode_valid && !crtc->buffer_id;
    if (crtc) drmModeFreeCrtc(crtc);
    if (resources) drmModeFreeResources(resources);
    /* Do not keep an observer FD's master/resource ownership across SDL. */
    close(fd);
    return result;
}

int main(void)
{
    SDL_Window *window = NULL;
    SDL_GLContext context = NULL;
    int result = 1;
    if (!disabled()) { fprintf(stderr, "initial CRTC is not disabled\n"); return 1; }
    SDL_LogSetOutputFunction(record_log, NULL);
    SDL_setenv("SDL_VIDEODRIVER", "kmsdrm", 1);
    if (SDL_Init(SDL_INIT_VIDEO) != 0) goto done;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    window = SDL_CreateWindow("restore-control", 0, 0, 320, 240, SDL_WINDOW_OPENGL);
    if (!window) goto done;
    context = SDL_GL_CreateContext(window);
    if (!context) goto done;
    unsigned char pixel[4] = {0};
    glClearColor(1, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
    if (glGetError() != GL_NO_ERROR || pixel[0] != 255 || pixel[1] != 0
        || pixel[2] != 255 || pixel[3] != 255) {
        fprintf(stderr, "render/readback failed: %u,%u,%u,%u\n",
                pixel[0], pixel[1], pixel[2], pixel[3]);
        goto done;
    }
    SDL_GL_SwapWindow(window);
    result = 0;
 done:
    if (result) fprintf(stderr, "SDL window control: %s\n", SDL_GetError());
    if (context) SDL_GL_DeleteContext(context);
    if (window) SDL_DestroyWindow(window);
    SDL_Quit();
    if (!disabled()) { fprintf(stderr, "final CRTC is not disabled\n"); result = 1; }
    if (errors) { fprintf(stderr, "SDL error count: %u\n", errors); result = 1; }
    if (!result) puts("OK SDL render and disabled display restoration");
    return result;
}
