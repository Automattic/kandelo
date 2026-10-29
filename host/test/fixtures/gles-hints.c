#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) { fprintf(stderr,"line %d: %s\n",__LINE__,#value); exit(1); } } while (0)

static void hint_value(GLenum target, GLenum expected) {
    GLint integer[2] = {-1,91};
    GLfloat floating[2] = {-1,92};
    GLboolean boolean[2] = {GL_FALSE,93};
    glGetIntegerv(target,integer);
    glGetFloatv(target,floating);
    glGetBooleanv(target,boolean);
    CHECK(integer[0] == (GLint)expected && integer[1] == 91);
    CHECK(floating[0] == (GLfloat)expected && floating[1] == 92);
    CHECK(boolean[0] == GL_TRUE && boolean[1] == 93);
    CHECK(glGetError() == GL_NO_ERROR);
}

int main(void) {
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    CHECK(display && eglInitialize(display,NULL,NULL));
    const EGLint attributes[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    EGLConfig config; EGLint count;
    const EGLint choose[] = {EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    CHECK(eglChooseConfig(display,choose,&config,1,&count) && count == 1);
    EGLContext first = eglCreateContext(display,config,EGL_NO_CONTEXT,attributes);
    CHECK(first && eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,first));
    const char *extensions = (const char *)glGetString(GL_EXTENSIONS);
    CHECK(extensions && strstr(extensions,"GL_OES_standard_derivatives"));
    const GLenum targets[] = {GL_GENERATE_MIPMAP_HINT,GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES};
    const GLenum modes[] = {GL_FASTEST,GL_NICEST,GL_DONT_CARE};
    for (unsigned i=0;i<2;++i) {
        hint_value(targets[i],GL_DONT_CARE);
        for (unsigned j=0;j<3;++j) {
            glHint(targets[i],modes[j]);
            hint_value(targets[i],modes[j]);
        }
        glHint(targets[i],GL_LINEAR);
        CHECK(glGetError() == GL_INVALID_ENUM);
        hint_value(targets[i],GL_DONT_CARE);
    }
    glHint(0xdeadbeefu,GL_FASTEST);
    CHECK(glGetError() == GL_INVALID_ENUM);
    glHint(GL_GENERATE_MIPMAP_HINT,GL_FASTEST);
    glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES,GL_NICEST);
    EGLContext peer = eglCreateContext(display,config,first,attributes);
    CHECK(peer && eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
    for (unsigned i=0;i<2;++i) hint_value(targets[i],GL_DONT_CARE);
    glHint(GL_GENERATE_MIPMAP_HINT,GL_NICEST);
    glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES,GL_FASTEST);
    CHECK(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,first));
    hint_value(GL_GENERATE_MIPMAP_HINT,GL_FASTEST);
    hint_value(GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES,GL_NICEST);
    CHECK(eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,peer));
    CHECK(eglDestroyContext(display,peer));
    hint_value(GL_GENERATE_MIPMAP_HINT,GL_NICEST);
    hint_value(GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES,GL_FASTEST);
    CHECK(eglReleaseThread() && eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,first));
    hint_value(GL_GENERATE_MIPMAP_HINT,GL_FASTEST);
    hint_value(GL_FRAGMENT_SHADER_DERIVATIVE_HINT_OES,GL_NICEST);
    CHECK(eglDestroyContext(display,first) && eglReleaseThread() && eglTerminate(display));
    puts("OK GLES hints retain context state, conversions and invalid-enum errors");
    return 0;
}
