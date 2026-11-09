/* Ordinary SDK/EGL probe for the B1 scalar validator and ordered oracle.
 * Run with the fatal audit to compare every queued observation independently. */
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <assert.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include "gl_abi.h"
static unsigned cases;
static int local;
#define CHECK_CALL(call, wanted) do { \
    uint64_t before = _wpk_gl_device_requests(); \
    call; GLenum result = glGetError(); \
    if (result != (wanted)) { \
        fprintf(stderr,"FAIL %u: %s returned 0x%x, expected 0x%x\n", cases, #call, result, (wanted)); return 1; \
    } \
    if (local && _wpk_gl_device_requests() != before) { \
        fprintf(stderr,"FAIL %u: %s unexpectedly requested the host\n", cases, #call); return 1; \
    } \
    cases++; \
} while (0)
int main(int argc, char **argv) {
    assert(argc == 2);
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY); assert(display != EGL_NO_DISPLAY);
    if (!strcmp(argv[1], "no-renderer")) {
        assert(!eglInitialize(display,NULL,NULL) && eglGetError() == EGL_NOT_INITIALIZED);
        puts("PASS explicit no-renderer EGL refusal"); return 0;
    }
    local = !strcmp(argv[1], "after");
    assert(eglInitialize(display,NULL,NULL));
    const EGLint configs[] = {EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    EGLConfig config; EGLint count;
    assert(eglChooseConfig(display,configs,&config,1,&count) && count == 1);
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint size[] = {EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
    EGLContext context = eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
    EGLSurface surface = eglCreatePbufferSurface(display,config,size);
    assert(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE);
    assert(eglMakeCurrent(display,surface,surface,context));
    glActiveTexture(GL_TEXTURE0); assert(glGetError() == GL_NO_ERROR);
    glEnableVertexAttribArray(UINT_MAX); assert(glGetError() == GL_INVALID_VALUE);
    GLint attribs, units;
    glGetIntegerv(GL_MAX_VERTEX_ATTRIBS,&attribs);glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS,&units);
    assert(attribs >= 16 && units > 0 && glGetError() == GL_NO_ERROR);
    const uint64_t start = _wpk_gl_device_requests();
    const GLenum caps[] = {GL_DITHER,GL_DEPTH_TEST,GL_STENCIL_TEST,GL_BLEND,GL_CULL_FACE,
        GL_SCISSOR_TEST,GL_POLYGON_OFFSET_FILL,GL_SAMPLE_ALPHA_TO_COVERAGE,GL_SAMPLE_COVERAGE};
    for (unsigned i=0;i<sizeof caps/sizeof *caps;i++) {
        CHECK_CALL(glEnable(caps[i]),GL_NO_ERROR); CHECK_CALL(glDisable(caps[i]),GL_NO_ERROR);
    }
    const GLenum wrong[] = {0,0xdead,UINT_MAX,GL_TEXTURE_2D,0x8c89};
    for (unsigned i=0;i<sizeof wrong/sizeof *wrong;i++) {
        CHECK_CALL(glEnable(wrong[i]),GL_INVALID_ENUM);CHECK_CALL(glDisable(wrong[i]),GL_INVALID_ENUM);
        CHECK_CALL(glDepthFunc(wrong[i]),GL_INVALID_ENUM);CHECK_CALL(glCullFace(wrong[i]),GL_INVALID_ENUM);
        CHECK_CALL(glFrontFace(wrong[i]),GL_INVALID_ENUM);CHECK_CALL(glBlendFunc(wrong[i],GL_ONE),wrong[i] == GL_ZERO ? GL_NO_ERROR : GL_INVALID_ENUM);
        CHECK_CALL(glBlendFunc(GL_ONE,wrong[i]),wrong[i] == GL_ZERO ? GL_NO_ERROR : GL_INVALID_ENUM);
        CHECK_CALL(glBlendEquation(wrong[i]),GL_INVALID_ENUM);
        CHECK_CALL(glBlendEquationSeparate(GL_FUNC_ADD,wrong[i]),GL_INVALID_ENUM);
        CHECK_CALL(glStencilFunc(wrong[i],0,UINT_MAX),GL_INVALID_ENUM);
        CHECK_CALL(glStencilFuncSeparate(wrong[i],GL_ALWAYS,0,UINT_MAX),GL_INVALID_ENUM);
        CHECK_CALL(glStencilMaskSeparate(wrong[i],UINT_MAX),GL_INVALID_ENUM);
        CHECK_CALL(glStencilOp(wrong[i],GL_KEEP,GL_KEEP),wrong[i] == GL_ZERO ? GL_NO_ERROR : GL_INVALID_ENUM);
        CHECK_CALL(glStencilOpSeparate(GL_FRONT,GL_KEEP,wrong[i],GL_KEEP),wrong[i] == GL_ZERO ? GL_NO_ERROR : GL_INVALID_ENUM);
    }
    const GLenum faces[] = {GL_FRONT,GL_BACK,GL_FRONT_AND_BACK};
    for (unsigned f=0;f<3;f++) {
        CHECK_CALL(glCullFace(faces[f]),GL_NO_ERROR);
        CHECK_CALL(glStencilMaskSeparate(faces[f],UINT_MAX),GL_NO_ERROR);
        for (GLenum cmp=GL_NEVER;cmp<=GL_ALWAYS;cmp++) {
            CHECK_CALL(glDepthFunc(cmp),GL_NO_ERROR);CHECK_CALL(glStencilFunc(cmp,INT_MIN,UINT_MAX),GL_NO_ERROR);
            CHECK_CALL(glStencilFuncSeparate(faces[f],cmp,INT_MAX,UINT_MAX),GL_NO_ERROR);
        }
    }
    CHECK_CALL(glFrontFace(GL_CW),GL_NO_ERROR);CHECK_CALL(glFrontFace(GL_CCW),GL_NO_ERROR);
    CHECK_CALL(glViewport(-3,-4,16,8),GL_NO_ERROR);CHECK_CALL(glViewport(0,0,0,0),GL_NO_ERROR);
    CHECK_CALL(glViewport(0,0,-1,8),GL_INVALID_VALUE);CHECK_CALL(glViewport(0,0,8,-1),GL_INVALID_VALUE);
    CHECK_CALL(glScissor(-3,-4,16,8),GL_NO_ERROR);CHECK_CALL(glScissor(0,0,0,0),GL_NO_ERROR);
    CHECK_CALL(glScissor(0,0,-1,8),GL_INVALID_VALUE);CHECK_CALL(glScissor(0,0,8,-1),GL_INVALID_VALUE);
    CHECK_CALL(glLineWidth(1),GL_NO_ERROR);CHECK_CALL(glLineWidth(0.5f),GL_NO_ERROR);
    CHECK_CALL(glLineWidth(0),GL_INVALID_VALUE);CHECK_CALL(glLineWidth(-1),GL_INVALID_VALUE);
    CHECK_CALL(glLineWidth(NAN),GL_INVALID_VALUE);
    const GLenum factors[] = {GL_ZERO,GL_ONE,GL_SRC_COLOR,GL_ONE_MINUS_SRC_COLOR,GL_DST_COLOR,GL_ONE_MINUS_DST_COLOR,
        GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA,GL_DST_ALPHA,GL_ONE_MINUS_DST_ALPHA,
        GL_CONSTANT_COLOR,GL_ONE_MINUS_CONSTANT_COLOR,GL_CONSTANT_ALPHA,GL_ONE_MINUS_CONSTANT_ALPHA,GL_SRC_ALPHA_SATURATE};
    for (unsigned a=0;a<15;a++) for (unsigned b=0;b<15;b++) {
        GLenum error = factors[b] == GL_SRC_ALPHA_SATURATE ? GL_INVALID_ENUM : GL_NO_ERROR;
        CHECK_CALL(glBlendFunc(factors[a],factors[b]),error);
        CHECK_CALL(glBlendFuncSeparate(factors[a],factors[b],factors[a],factors[b]),error);
    }
    const GLenum equations[] = {GL_FUNC_ADD,GL_FUNC_SUBTRACT,GL_FUNC_REVERSE_SUBTRACT,GL_MIN_EXT,GL_MAX_EXT};
    for (unsigned a=0;a<5;a++) {
        CHECK_CALL(glBlendEquation(equations[a]),GL_NO_ERROR);
        for (unsigned b=0;b<5;b++) CHECK_CALL(glBlendEquationSeparate(equations[a],equations[b]),GL_NO_ERROR);
    }
    const GLenum stencil[] = {GL_ZERO,GL_KEEP,GL_REPLACE,GL_INCR,GL_DECR,GL_INVERT,GL_INCR_WRAP,GL_DECR_WRAP};
    for (unsigned a=0;a<8;a++) for (unsigned b=0;b<8;b++) for (unsigned c=0;c<8;c++) {
        CHECK_CALL(glStencilOp(stencil[a],stencil[b],stencil[c]),GL_NO_ERROR);
        CHECK_CALL(glStencilOpSeparate(GL_FRONT_AND_BACK,stencil[a],stencil[b],stencil[c]),GL_NO_ERROR);
    }
    CHECK_CALL(glEnableVertexAttribArray(0),GL_NO_ERROR);CHECK_CALL(glDisableVertexAttribArray(0),GL_NO_ERROR);
    CHECK_CALL(glEnableVertexAttribArray(attribs-1),GL_NO_ERROR);CHECK_CALL(glDisableVertexAttribArray(attribs-1),GL_NO_ERROR);
    CHECK_CALL(glEnableVertexAttribArray(attribs),GL_INVALID_VALUE);CHECK_CALL(glDisableVertexAttribArray(attribs),GL_INVALID_VALUE);
    CHECK_CALL(glActiveTexture(GL_TEXTURE0),GL_NO_ERROR);CHECK_CALL(glActiveTexture(GL_TEXTURE0+units-1),GL_NO_ERROR);
    CHECK_CALL(glActiveTexture(GL_TEXTURE0+units),GL_INVALID_ENUM);
    for (GLint a=1;a<=8;a*=2) {
        CHECK_CALL(glPixelStorei(GL_PACK_ALIGNMENT,a),GL_NO_ERROR);CHECK_CALL(glPixelStorei(GL_UNPACK_ALIGNMENT,a),GL_NO_ERROR);
    }
    CHECK_CALL(glPixelStorei(GL_PACK_ALIGNMENT,3),GL_INVALID_VALUE);
    CHECK_CALL(glPixelStorei(GL_UNPACK_ALIGNMENT,0),GL_INVALID_VALUE);
    CHECK_CALL(glPixelStorei(0x0d02,1),GL_INVALID_ENUM);
    /* Distinct flags, repeated values and clear-before-record-again remain
     * ordered even though all of these calls have not reached the host yet. */
    glEnable(0xdead);glViewport(0,0,-1,1);
    GLenum first=glGetError(), second=glGetError();
    assert((first==GL_INVALID_ENUM && second==GL_INVALID_VALUE) || (first==GL_INVALID_VALUE && second==GL_INVALID_ENUM));
    assert(glGetError()==GL_NO_ERROR);
    glEnable(0xdead);assert(glGetError()==GL_INVALID_ENUM && glGetError()==GL_NO_ERROR);
    const uint64_t requests = _wpk_gl_device_requests()-start;
    printf("PREDICTED_SCALARS cases=%u requests=%llu\n",cases,(unsigned long long)requests);
    if (local) assert(requests == 0);
    assert(_wpk_gl_flush_checked() == 0 && glGetError() == GL_NO_ERROR);
    if (!strcmp(argv[1],"corrupt")) {
        /* Deliberately contradict the now-empty oracle. The fatal audit
         * must stop execution, rather than accepting a missing checkpoint. */
        const uint32_t record[] = {(8u << 16) | OP_ERROR_OBSERVED,1,0};
        memcpy(_wpk_gl_cmdbuf_base(),record,sizeof record);
        struct gl_submit_info info = {.offset=0,.length=sizeof record};
        _wpk_gl_note_device_request();
        (void)ioctl(_wpk_gl_fd(),GLIO_SUBMIT,&info);
        fprintf(stderr,"FAIL corrupt guest error oracle was not fatal\n");return 2;
    }
    assert(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(eglDestroySurface(display,surface) && eglDestroyContext(display,context));
    assert(eglTerminate(display) && eglReleaseThread());
    puts("PASS predicted scalar flags and ordered host oracle");return 0;
}
