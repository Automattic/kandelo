/* Focused library tests. The device double records storage ownership and
 * encoded commands; real guest and browser tests remain separate gates. */
#define EGL_EGLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <pthread.h>
#include "gl_abi.h"

/* Native pointers exceed the guest's u32 query fields. Resolve the query's
 * recorded allocation explicitly instead of dereferencing a truncated host
 * pointer. The library still allocates, queries and copies the actual reply. */
#undef malloc
#undef free
static void *latest_allocation;
void *graphics_malloc(size_t size) { return latest_allocation = malloc(size); }
void graphics_free(void *ptr) {
    if (latest_allocation == ptr) latest_allocation = NULL;
    free(ptr);
}

/* Optional window backends are absent in this device-only harness. */
uint32_t _wpk_wlegl_bo_handle(void *window) { (void)window; return 0; }
void _wpk_wlegl_present(void *window) { (void)window; }
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *w, uint32_t *h) {
    (void)window; (void)w; (void)h; return 0;
}

static unsigned closes, imports;
static uint32_t bound_texture, redefined_texture;
static unsigned char command_storage[2][WPK_GL_CMDBUF_LEN];
static unsigned char *commands;
static unsigned mappings;
static unsigned destroyed_contexts, destroyed_surfaces, submit_batches, clear_commands;
static int fail_make_current, fail_create_context;
static uint32_t shader_names[2], program_names[2];
static unsigned shaders_created, programs_created;
static int numeric_queries;
int graphics_open(const char *path, int flags, ...) {
    (void)flags;
    assert(!strcmp(path, WPK_GL_DEVICE));
    return 10;
}
int graphics_close(int fd) { assert(fd == 10); return 0; }
int graphics_fstat(int fd, struct stat *st) {
    assert(fd == 100);
    memset(st, 0, sizeof *st);
    st->st_size = 64 * 64 * 4;
    return 0;
}
void *graphics_mmap(void *a, size_t len, int prot, int flags, int fd, off_t offset) {
    (void)a; (void)prot; (void)flags; (void)offset;
    if (fd == 10) {
        assert(len == WPK_GL_CMDBUF_LEN);
        commands = command_storage[mappings++ % 2];
        return commands;
    }
    assert(fd == 100);
    errno = EINVAL; // GPU storage is not CPU mappable.
    return MAP_FAILED;
}
int graphics_munmap(void *a, size_t len) {
    assert(a == commands && len == WPK_GL_CMDBUF_LEN);
    return 0;
}
int graphics_ioctl(int fd, unsigned long request, ...) {
    assert(fd == 10);
    va_list args; va_start(args, request);
    void *arg = va_arg(args, void *); va_end(args);
    if (request == 0xc00c642eu) {
        uint32_t *words = arg;
        assert(words[2] == 100);
        words[0] = 77; // Repeated PRIME imports share one GEM handle.
        imports++;
    } else if (request == 0x40086409u) {
        assert(*(uint32_t *)arg == 77);
        closes++;
    } else if (request == 0xc01064e1u) {
        uint32_t *words = arg;
        assert(words[0] == 77);
        words[3] = 0x60000000u;
    } else if (request == GLIO_CREATE_CONTEXT && fail_create_context) {
        errno = ENOMEM;
        return -1;
    } else if (request == GLIO_SUBMIT) {
        submit_batches++;
        struct gl_submit_info *submit = arg;
        size_t at = submit->offset, end = at + submit->length;
        while (at < end) {
            uint16_t op, len;
            memcpy(&op, commands + at, 2);
            memcpy(&len, commands + at + 2, 2);
            assert(at + 4 + len <= end);
            uint32_t words[2] = {0};
            memcpy(words, commands + at + 4, len < 8 ? len : 8);
            if (op == OP_BIND_TEXTURE) bound_texture = words[1];
            if (op == OP_CLEAR) clear_commands++;
            if (op == OP_TEX_IMAGE_2D) redefined_texture = bound_texture;
            if (op == OP_CREATE_SHADER && shaders_created < 2)
                shader_names[shaders_created++] = words[1];
            if (op == OP_CREATE_PROGRAM && programs_created < 2)
                program_names[programs_created++] = words[0];
            at += 4 + len;
        }
    } else if (request == GLIO_MAKE_CURRENT && fail_make_current) {
        errno = EIO;
        return -1;
    } else if (request == GLIO_DESTROY_CONTEXT) {
        destroyed_contexts++;
    } else if (request == GLIO_DESTROY_SURFACE) {
        destroyed_surfaces++;
    } else if (request == GLIO_QUERY) {
        struct gl_query_info *q = arg;
        if (numeric_queries == 3) { errno = EINVAL; return -1; }
        if (numeric_queries) {
            assert(latest_allocation);
            assert(q->out_buf_ptr == (uint32_t)(uintptr_t)latest_allocation);
            if (numeric_queries == 2 && q->out_buf_len == 4) {
                assert(q->op == QOP_GET_INTEGERV);
                const GLint count = 6;
                memcpy(latest_allocation, &count, 4);
                return 0;
            }
            assert(q->out_buf_len == (numeric_queries == 2 ? 24 : 16));
            const GLfloat floats[6] = { 0.0f, 0.25f, -0.5f, 1.0f, 0.0f, 2.0f };
            const GLint integers[6] = { 0, 0, 0, 1, 0, 2 };
            assert(q->op == QOP_GET_FLOATV || q->op == QOP_GET_INTEGERV);
            memcpy(latest_allocation,
                q->op == QOP_GET_FLOATV ? (const void *)floats : (const void *)integers,
                q->out_buf_len);
        }
    }
    return 0;
}

static EGLImageKHR image(EGLDisplay dpy) {
    const EGLint attrs[] = {
        EGL_WIDTH, 64, EGL_HEIGHT, 64,
        EGL_LINUX_DRM_FOURCC_EXT, 0x34324241,
        EGL_DMA_BUF_PLANE0_FD_EXT, 100,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, 0,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, 256, EGL_NONE,
    };
    EGLImageKHR img = eglCreateImageKHR(dpy, EGL_NO_CONTEXT,
        EGL_LINUX_DMA_BUF_EXT, NULL, attrs);
    assert(img != EGL_NO_IMAGE_KHR);
    return img;
}

static void *check_thread_error(void *unused) {
    (void)unused;
    assert(eglGetError() == EGL_SUCCESS);
    assert(eglQueryAPI() == EGL_OPENGL_ES_API);
    assert(!eglBindAPI(EGL_OPENGL_API));
    assert(eglGetError() == EGL_BAD_PARAMETER);
    assert(eglQueryAPI() == EGL_OPENGL_ES_API);
    return NULL;
}

struct thread_context { EGLDisplay display; EGLContext context; };
static void *check_busy_context(void *arg) {
    struct thread_context *input = arg;
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    assert(eglGetCurrentDisplay() == EGL_NO_DISPLAY);
    assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
    assert(!eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    assert(eglGetError() == EGL_BAD_ACCESS);
    assert(eglReleaseThread());
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    return NULL;
}

static void *take_context_then_exit(void *arg) {
    struct thread_context *input = arg;
    assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
    assert(eglMakeCurrent(input->display, EGL_NO_SURFACE, EGL_NO_SURFACE, input->context));
    glClear(GL_COLOR_BUFFER_BIT);
    /* Thread destruction must flush and release this current reference. */
    return NULL;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (!strcmp(argv[1], "config-validation")) {
        EGLint value = 17;
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, EGL_RED_SIZE, &value));
        assert(eglGetError() == EGL_NOT_INITIALIZED && value == 17);
    }
    assert(eglInitialize(dpy, NULL, NULL));
    const EGLint attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    if (!strcmp(argv[1], "create-rollback")) {
        fail_create_context = 1;
        assert(eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs) == EGL_NO_CONTEXT);
        assert(eglGetError() == EGL_BAD_ALLOC);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        EGLint value = 17;
        assert(!eglQueryContext(dpy, (EGLContext)1, EGL_CONTEXT_CLIENT_VERSION, &value));
        assert(eglGetError() == EGL_BAD_CONTEXT && value == 17);
        fail_create_context = 0;
    }
    EGLContext ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
    assert(ctx != EGL_NO_CONTEXT);
    assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
    if (!strcmp(argv[1], "create-rollback")) {
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS create-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "bind-rollback")) {
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, NULL);
        assert(surface != EGL_NO_SURFACE);
        fail_make_current = 1;
        assert(!eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglGetError() == EGL_BAD_ACCESS);
        assert(eglGetCurrentContext() == ctx);
        assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
        assert(eglGetCurrentSurface(EGL_READ) == EGL_NO_SURFACE);
        fail_make_current = 0;
        assert(eglDestroySurface(dpy, surface) && destroyed_surfaces == 1);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS bind-rollback");
        return 0;
    }
    if (!strcmp(argv[1], "terminate-current")) {
        assert(eglTerminate(dpy));
        assert(eglGetCurrentContext() == ctx);
        assert(destroyed_contexts == 0);
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglReleaseThread());
        assert(destroyed_contexts == 1 && submit_batches == 1 && clear_commands == 1);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        assert(eglInitialize(dpy, NULL, NULL));
        EGLContext replacement = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(replacement != EGL_NO_CONTEXT && replacement != ctx);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, replacement));
        assert(eglDestroyContext(dpy, replacement) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS terminate-current");
        return 0;
    }
    if (!strcmp(argv[1], "thread-current")) {
        pthread_t thread;
        struct thread_context input = { dpy, ctx };
        assert(pthread_create(&thread, NULL, check_busy_context, &input) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(eglGetCurrentContext() == ctx);
        assert(!eglBindAPI(EGL_OPENGL_API));
        assert(eglReleaseThread());
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglQueryAPI() == EGL_OPENGL_ES_API);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        EGLint config_id = 0;
        assert(eglQueryContext(dpy, ctx, EGL_CONFIG_ID, &config_id) && config_id == 1);
        const unsigned before = submit_batches;
        assert(pthread_create(&thread, NULL, take_context_then_exit, &input) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(submit_batches == before + 1 && clear_commands == 1);
        assert(eglGetCurrentContext() == EGL_NO_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(destroyed_contexts == 1);
        assert(eglTerminate(dpy));
        puts("PASS thread-current");
        return 0;
    }
    if (!strcmp(argv[1], "destroy-current")) {
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglGetCurrentContext() == ctx);
        assert(destroyed_contexts == 0 && submit_batches == 0);
        glClear(GL_COLOR_BUFFER_BIT);
        assert(eglMakeCurrent(EGL_NO_DISPLAY, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
        assert(destroyed_contexts == 1 && submit_batches == 1 && clear_commands == 2);
        EGLint value = 17;
        assert(!eglQueryContext(dpy, ctx, EGL_CONFIG_ID, &value));
        assert(eglGetError() == EGL_BAD_CONTEXT && value == 17);
        EGLContext replacement = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(replacement != EGL_NO_CONTEXT && replacement != ctx);
        assert(!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(eglGetError() == EGL_BAD_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, replacement));
        assert(eglDestroyContext(dpy, replacement) && eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS destroy-current");
        return 0;
    }
    if (!strcmp(argv[1], "surface-current")) {
        const EGLint size[] = { EGL_WIDTH, 64, EGL_HEIGHT, 64, EGL_NONE };
        EGLSurface surface = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, size);
        assert(surface != EGL_NO_SURFACE);
        assert(eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglDestroySurface(dpy, surface));
        assert(eglGetCurrentSurface(EGL_DRAW) == surface);
        assert(destroyed_surfaces == 0);
        assert(eglSwapBuffers(dpy, surface));
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        assert(destroyed_surfaces == 1);
        assert(eglGetCurrentSurface(EGL_DRAW) == EGL_NO_SURFACE);
        EGLSurface replacement = eglCreateWindowSurface(dpy, (EGLConfig)1, 0, size);
        assert(replacement != EGL_NO_SURFACE && replacement != surface);
        assert(!eglMakeCurrent(dpy, surface, surface, ctx));
        assert(eglGetError() == EGL_BAD_SURFACE);
        assert(eglDestroySurface(dpy, replacement));
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS surface-current");
        return 0;
    }
    if (!strcmp(argv[1], "thread-error")) {
        assert(!eglInitialize(EGL_NO_DISPLAY, NULL, NULL));
        pthread_t thread;
        assert(pthread_create(&thread, NULL, check_thread_error, NULL) == 0);
        assert(pthread_join(thread, NULL) == 0);
        assert(eglGetError() == EGL_BAD_DISPLAY);
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS thread-error");
        return 0;
    }
    if (!strcmp(argv[1], "api-error")) {
        for (unsigned i = 0; i < 3; i++) {
            const EGLenum invalid[] = { EGL_OPENGL_API, EGL_OPENVG_API, 0xffffffffu };
            assert(!eglBindAPI(invalid[i]));
            assert(eglGetError() == EGL_BAD_PARAMETER);
            assert(eglQueryAPI() == EGL_OPENGL_ES_API);
        }
        assert(eglBindAPI(EGL_OPENGL_ES_API));
        assert(eglGetError() == EGL_SUCCESS);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS api-error");
        return 0;
    }
    if (!strcmp(argv[1], "config-selection")) {
        const EGLint requests[][7] = {
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_RED_SIZE, 9, EGL_NONE },
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SAMPLE_BUFFERS, 1, EGL_NONE },
            { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE },
        };
        for (unsigned i = 0; i < sizeof requests / sizeof requests[0]; i++) {
            EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
            EGLint count = 17;
            assert(eglChooseConfig(dpy, requests[i], &selected, 1, &count));
            assert(count == 0 && selected == (EGLConfig)(uintptr_t)0x1234);
        }
        const EGLint matching[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 8, EGL_DEPTH_SIZE, 16, EGL_NONE };
        EGLConfig selected = NULL;
        EGLint count = 17;
        assert(eglChooseConfig(dpy, matching, &selected, 1, &count));
        assert(count == 1 && selected == (EGLConfig)1);
        /* A configuration ID overrides otherwise incompatible selection. */
        const EGLint by_id[] = { EGL_CONFIG_ID, 1, EGL_RED_SIZE, 99, EGL_NONE };
        assert(eglChooseConfig(dpy, by_id, &selected, 1, &count));
        assert(count == 1 && selected == (EGLConfig)1);
        const EGLint by_missing_id[] = { EGL_CONFIG_ID, 2, EGL_NONE };
        assert(eglChooseConfig(dpy, by_missing_id, &selected, 1, &count));
        assert(count == 0);
        /* Default renderable type is ES1; this config already advertises
         * ES2 only. Enumeration must use eglGetConfigs, not this filter. */
        assert(eglChooseConfig(dpy, NULL, &selected, 1, &count) && count == 0);
        const EGLint masks[] = { EGL_RENDERABLE_TYPE, 0, EGL_SURFACE_TYPE, 0,
            EGL_RED_SIZE, EGL_DONT_CARE, EGL_NONE };
        assert(eglChooseConfig(dpy, masks, &selected, 1, &count) && count == 1);
        const EGLint duplicate[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 99, EGL_RED_SIZE, 8, EGL_NONE };
        assert(eglChooseConfig(dpy, duplicate, &selected, 1, &count) && count == 1);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS config-selection");
        return 0;
    }
    if (!strcmp(argv[1], "config-validation")) {
        const EGLint invalid[][3] = {
            { EGL_RED_SIZE, -2, EGL_NONE }, { EGL_BIND_TO_TEXTURE_RGB, 4, EGL_NONE },
            { EGL_COLOR_BUFFER_TYPE, 0, EGL_NONE }, { EGL_NATIVE_RENDERABLE, 6, EGL_NONE },
            { EGL_TRANSPARENT_TYPE, 6, EGL_NONE }, { EGL_LEVEL, EGL_DONT_CARE, EGL_NONE },
            { -1 }, /* Undefined name must be rejected without reading its value. */
        };
        for (unsigned i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
            EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
            EGLint count = 17;
            assert(!eglChooseConfig(dpy, invalid[i], &selected, 1, &count));
            assert(eglGetError() == EGL_BAD_ATTRIBUTE);
            assert(count == 17 && selected == (EGLConfig)(uintptr_t)0x1234);
        }
        EGLint value = 17;
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)2, EGL_RED_SIZE, &value));
        assert(eglGetError() == EGL_BAD_CONFIG && value == 17);
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, 0, &value));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && value == 17);
        assert(!eglGetConfigAttrib(dpy, (EGLConfig)1, EGL_RED_SIZE, NULL));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(!eglChooseConfig(dpy, NULL, NULL, 0, NULL));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        const EGLint invalid_after_mismatch[] = { EGL_RED_SIZE, 99,
            EGL_NATIVE_RENDERABLE, 6, EGL_NONE };
        EGLConfig selected = (EGLConfig)(uintptr_t)0x1234;
        EGLint count = 17;
        assert(!eglChooseConfig(dpy, invalid_after_mismatch, &selected, 1, &count));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && count == 17);
        const EGLint undefined_name[] = { -1 };
        assert(!eglChooseConfig(dpy, undefined_name, &selected, 1, &count));
        assert(eglGetError() == EGL_BAD_ATTRIBUTE && count == 17);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        puts("PASS config-validation");
        return 0;
    }
    if (!strcmp(argv[1], "config-list")) {
        PFNEGLGETCONFIGSPROC enumerate = (PFNEGLGETCONFIGSPROC)eglGetProcAddress("eglGetConfigs");
        assert(enumerate != NULL);
        EGLint count = 17;
        assert(enumerate(dpy, NULL, 0, &count) && count == 1);
        EGLConfig configs[2] = { NULL, (EGLConfig)(uintptr_t)0x1234 };
        assert(enumerate(dpy, configs, 0, &count) && count == 0);
        assert(configs[0] == NULL);
        assert(enumerate(dpy, configs, 2, &count) && count == 1);
        assert(configs[0] == (EGLConfig)1 && configs[1] == (EGLConfig)(uintptr_t)0x1234);
        EGLint buffer_bits = 17;
        assert(eglGetConfigAttrib(dpy, configs[0], EGL_BUFFER_SIZE, &buffer_bits));
        assert(buffer_bits == 32);
        assert(eglGetProcAddress("eglGetConfigs") != NULL);
        assert(!enumerate(dpy, configs, -1, &count));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(eglDestroyContext(dpy, ctx) && eglReleaseThread() && eglTerminate(dpy));
        count = 17;
        assert(!enumerate(dpy, configs, 2, &count));
        assert(eglGetError() == EGL_NOT_INITIALIZED && count == 17);
        puts("PASS config-list");
        return 0;
    }
    if (!strcmp(argv[1], "namespace")) {
        GLuint names[] = { glCreateShader(GL_VERTEX_SHADER), glCreateProgram(),
            glCreateShader(GL_FRAGMENT_SHADER), glCreateProgram() };
        for (unsigned i = 0; i < 4; i++) {
            assert(names[i] != 0);
            for (unsigned j = 0; j < i; j++) assert(names[i] != names[j]);
        }
        glFlush();
        assert(shaders_created == 2 && programs_created == 2);
        assert(shader_names[0] == names[0] && shader_names[1] == names[2]);
        assert(program_names[0] == names[1] && program_names[1] == names[3]);
        assert(glCreateShader(GL_TEXTURE_2D) == 0);
        assert(glGetError() == GL_INVALID_ENUM);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS namespace");
        return 0;
    }
    if (!strcmp(argv[1], "boolean")) {
        numeric_queries = 1;
        GLboolean result[4] = { 7, 7, 7, 7 };
        glGetBooleanv(GL_COLOR_CLEAR_VALUE, result);
        assert(result[0] == GL_FALSE && result[1] == GL_TRUE);
        assert(result[2] == GL_TRUE && result[3] == GL_TRUE);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS boolean");
        return 0;
    }
    if (!strcmp(argv[1], "query-vector")) {
        numeric_queries = 2;
        GLboolean result[8];
        memset(result, 7, sizeof result);
        glGetBooleanv(GL_COMPRESSED_TEXTURE_FORMATS, result);
        const GLboolean expected[8] = { 0, 1, 1, 1, 0, 1, 7, 7 };
        assert(!memcmp(result, expected, sizeof result));
        glPixelStorei(GL_UNPACK_ROW_LENGTH_EXT, 7);
        GLfloat row_length = 0;
        glGetFloatv(GL_UNPACK_ROW_LENGTH_EXT, &row_length);
        assert(row_length == 7.0f);
        glGetBooleanv(GL_UNPACK_ROW_LENGTH_EXT, result);
        assert(result[0] == GL_TRUE);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS query-vector");
        return 0;
    }
    if (!strcmp(argv[1], "query-error")) {
        numeric_queries = 3;
        GLint integer = 17;
        GLfloat floating = 6.25f;
        GLboolean boolean = 7;
        glGetIntegerv(0xffffffffu, &integer);
        glGetFloatv(0xffffffffu, &floating);
        glGetBooleanv(0xffffffffu, &boolean);
        assert(integer == 17 && floating == 6.25f && boolean == 7);
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
        puts("PASS query-error");
        return 0;
    }
    EGLImageKHR first = image(dpy), second = image(dpy);
    assert(imports == 2);
    GLuint tex, rb;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, first);
    glGenRenderbuffers(1, &rb);
    glBindRenderbuffer(GL_RENDERBUFFER, rb);
    glEGLImageTargetRenderbufferStorageOES(GL_RENDERBUFFER, second);
    assert(eglDestroyImageKHR(dpy, first));
    assert(eglDestroyImageKHR(dpy, second));
    if (!strcmp(argv[1], "lifetime")) {
        assert(closes == 0); // The texture and renderbuffer retain storage.
        glDeleteTextures(1, &tex);
        assert(closes == 0); // The other image's sibling remains live.
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1); // Final reference retires exactly one handle.
    } else if (!strcmp(argv[1], "redefine")) {
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0,
            GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glFlush();
        assert(redefined_texture == tex); // Never respecify the shared BO.
        assert(closes == 0);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 1);
        glDeleteTextures(1, &tex);
    } else if (!strcmp(argv[1], "framebuffer")) {
        GLuint fb;
        glGenFramebuffers(1, &fb);
        glBindFramebuffer(GL_FRAMEBUFFER, fb);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_2D, tex, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteTextures(1, &tex);
        glDeleteRenderbuffers(1, &rb);
        assert(closes == 0); // An unbound FBO still retains the image storage.
        glDeleteFramebuffers(1, &fb);
        assert(closes == 1);
    } else if (!strcmp(argv[1], "context")) {
        assert(eglDestroyContext(dpy, ctx));
        assert(closes == 0); // Current reference keeps siblings alive.
        assert(eglReleaseThread());
        assert(closes == 1);
        assert(eglTerminate(dpy));
        puts("PASS context");
        return 0;
    } else if (!strcmp(argv[1], "cycle")) {
        // Leave siblings live; teardown must retire them and reset the encoder.
    } else {
        assert(!strcmp(argv[1], "invalid"));
        assert(!eglDestroyImageKHR(dpy, first));
        assert(eglGetError() == EGL_BAD_PARAMETER);
        assert(!eglDestroyImageKHR(dpy, (EGLImageKHR)(uintptr_t)0x1234));
        assert(eglGetError() == EGL_BAD_PARAMETER);
    }
    assert(eglDestroyContext(dpy, ctx));
    assert(eglReleaseThread());
    assert(eglTerminate(dpy));
    assert(closes == 1);
    if (!strcmp(argv[1], "cycle")) {
        assert(eglInitialize(dpy, NULL, NULL));
        ctx = eglCreateContext(dpy, (EGLConfig)1, EGL_NO_CONTEXT, attrs);
        assert(ctx != EGL_NO_CONTEXT);
        assert(eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx));
        glClear(GL_COLOR_BUFFER_BIT);
        glFlush();
        assert(eglDestroyContext(dpy, ctx));
        assert(eglReleaseThread());
        assert(eglTerminate(dpy));
    }
    printf("PASS %s\n", argv[1]);
}
