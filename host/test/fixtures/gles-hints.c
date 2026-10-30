#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <limits.h>
#include <stdint.h>
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

static void no_error(void) {
    CHECK(glGetError() == GL_NO_ERROR);
}

static void expected_error(GLenum expected) {
    CHECK(glGetError() == expected);
    no_error();
}

static void string_query_errors(void) {
    const GLubyte *version = glGetString(GL_VERSION);
    CHECK(version && strstr((const char *)version, "OpenGL ES 2.0"));
    char *saved = strdup((const char *)version);
    CHECK(saved);
    const GLenum invalid[] = {0, GL_TEXTURE_2D, 0x821bu, 0x821du, 0xffffffffu};
    for (unsigned i = 0; i < sizeof invalid / sizeof invalid[0]; ++i) {
        CHECK(glGetString(invalid[i]) == NULL);
        expected_error(GL_INVALID_ENUM);
        CHECK(glGetString(GL_VERSION) == version && !strcmp((const char *)version, saved));
        no_error();
    }
    glGenFramebuffers(-1, NULL);
    CHECK(glGetString(GL_VERSION) == version);
    expected_error(GL_INVALID_VALUE);
    free(saved);
    puts("OK GLES string-query enums and cached state");
}

static void generation_counts(void) {
    void (*const generate[])(GLsizei, GLuint *) = {
        glGenFramebuffers, glGenBuffers, glGenTextures, glGenRenderbuffers,
    };
    void (*const destroy[])(GLsizei, const GLuint *) = {
        glDeleteFramebuffers, glDeleteBuffers, glDeleteTextures, glDeleteRenderbuffers,
    };
    const GLsizei negative[] = {-1, INT_MIN};
    for (unsigned i = 0; i < 4; ++i) {
        GLuint names[3] = {0x12345678u, 0x87654321u, 0xdecafbadu};
        for (unsigned j = 0; j < 2; ++j) {
            generate[i](negative[j], names);
            expected_error(GL_INVALID_VALUE);
            CHECK(names[0] == 0x12345678u && names[1] == 0x87654321u && names[2] == 0xdecafbadu);
            generate[i](negative[j], NULL);
            expected_error(GL_INVALID_VALUE);
        }
        generate[i](0, names);
        generate[i](0, NULL);
        no_error();
        CHECK(names[0] == 0x12345678u && names[1] == 0x87654321u && names[2] == 0xdecafbadu);
        generate[i](2, names);
        no_error();
        CHECK(names[0] && names[1] && names[0] != names[1] && names[2] == 0xdecafbadu);
        destroy[i](2, names);
        no_error();
    }
    puts("OK GLES object-generation counts");
}

/* Sentinel/error tests need an actual current program: -1 only ignores the
 * uniform data, and does not exempt the API's current-program requirement. */
static GLuint uniform_test_program(void) {
    const char *sources[] = {
        "uniform float f1; uniform vec2 f2; uniform vec3 f3; uniform vec4 f4;"
        "uniform int i1; uniform ivec2 i2; uniform ivec3 i3; uniform ivec4 i4;"
        "uniform mat2 m2; uniform mat3 m3; uniform mat4 m4; uniform vec4 tail[3];"
        "uniform float af1[2]; uniform vec2 af2[2]; uniform vec3 af3[2]; uniform vec4 af4[2];"
        "uniform int ai1[2]; uniform ivec2 ai2[2]; uniform ivec3 ai3[2]; uniform ivec4 ai4[2];"
        "uniform mat2 am2[2]; uniform mat3 am3[2]; uniform mat4 am4[2];"
        "void main() { float x=af1[0]+af1[1]+af2[0].x+af2[1].x+af3[0].x+af3[1].x+af4[0].x+af4[1].x"
        "+float(ai1[0]+ai1[1]+ai2[0].x+ai2[1].x+ai3[0].x+ai3[1].x+ai4[0].x+ai4[1].x)"
        "+am2[0][0][0]+am2[1][0][0]+am3[0][0][0]+am3[1][0][0]+am4[0][0][0]+am4[1][0][0]+f1+f2.x+f3.x+f4.x+float(i1+i2.x+i3.x+i4.x)"
        "+m2[0][0]+m3[0][0]+m4[0][0]+tail[0].x+tail[1].x+tail[2].x; gl_Position=vec4(x); }",
        "precision mediump float; void main() { gl_FragColor = vec4(1.0); }",
    };
    const GLenum types[] = {GL_VERTEX_SHADER, GL_FRAGMENT_SHADER};
    GLuint shaders[2], program = glCreateProgram();
    CHECK(program);
    for (unsigned i = 0; i < 2; ++i) {
        GLint compiled = GL_FALSE;
        shaders[i] = glCreateShader(types[i]); CHECK(shaders[i]);
        glShaderSource(shaders[i], 1, &sources[i], NULL);
        glCompileShader(shaders[i]);
        glGetShaderiv(shaders[i], GL_COMPILE_STATUS, &compiled); CHECK(compiled);
        glAttachShader(program, shaders[i]);
    }
    GLint linked = GL_FALSE;
    glLinkProgram(program);
    glGetProgramiv(program, GL_LINK_STATUS, &linked); CHECK(linked);
    glUseProgram(program);
    for (unsigned i = 0; i < 2; ++i) glDeleteShader(shaders[i]);
    no_error();
    return program;
}

static void uniform_setter(unsigned variant, GLint location) {
    const GLfloat f[16] = {1, 2, 3, 4};
    const GLint i[4] = {1, 2, 3, 4};
    switch (variant) {
    case 0: glUniform1f(location, f[0]); break;
    case 1: glUniform2f(location, f[0], f[1]); break;
    case 2: glUniform3f(location, f[0], f[1], f[2]); break;
    case 3: glUniform4f(location, f[0], f[1], f[2], f[3]); break;
    case 4: glUniform1i(location, i[0]); break;
    case 5: glUniform2i(location, i[0], i[1]); break;
    case 6: glUniform3i(location, i[0], i[1], i[2]); break;
    case 7: glUniform4i(location, i[0], i[1], i[2], i[3]); break;
    case 8: glUniform1fv(location, 1, f); break;
    case 9: glUniform2fv(location, 1, f); break;
    case 10: glUniform3fv(location, 1, f); break;
    case 11: glUniform4fv(location, 1, f); break;
    case 12: glUniform1iv(location, 1, i); break;
    case 13: glUniform2iv(location, 1, i); break;
    case 14: glUniform3iv(location, 1, i); break;
    case 15: glUniform4iv(location, 1, i); break;
    case 16: glUniformMatrix2fv(location, 1, GL_FALSE, f); break;
    case 17: glUniformMatrix3fv(location, 1, GL_FALSE, f); break;
    case 18: glUniformMatrix4fv(location, 1, GL_FALSE, f); break;
    default: CHECK(0);
    }
}

static void uniform_locations(void) {
    const GLint invalid[] = {-2, INT_MIN};
    for (unsigned variant = 0; variant < 19; ++variant) {
        for (unsigned j = 0; j < 2; ++j) {
            uniform_setter(variant, invalid[j]);
            expected_error(GL_INVALID_OPERATION);
        }
        uniform_setter(variant, -1);
        no_error();
        glGetString(0);
        uniform_setter(variant, -1);
        expected_error(GL_INVALID_ENUM);
    }
    puts("OK GLES uniform negative locations: 19 setters");
}

static void positive_uniforms(GLuint program) {
    void (*const fv[])(GLint, GLsizei, const GLfloat *) = {glUniform1fv,glUniform2fv,glUniform3fv,glUniform4fv};
    void (*const iv[])(GLint, GLsizei, const GLint *) = {glUniform1iv,glUniform2iv,glUniform3iv,glUniform4iv};
    void (*const matrix[])(GLint, GLsizei, GLboolean, const GLfloat *) = {glUniformMatrix2fv,glUniformMatrix3fv,glUniformMatrix4fv};
    const void *unreadable=(const void *)(UINTPTR_MAX & ~(uintptr_t)3u);
    const GLfloat f[16]={0}; const GLint integers[8]={0};
    for(unsigned i=0;i<11;i++) {
        const char *names[]={"f1","f2","f3","f4","i1","i2","i3","i4","m2","m3","m4"};
        const GLint location=glGetUniformLocation(program,names[i]); CHECK(location>=0);no_error();
        for(unsigned j=0;j<2;j++) {
            const void *data=j?NULL:unreadable;
            if(i<4)fv[i](location,0,data);else if(i<8)iv[i-4](location,0,data);else matrix[i-8](location,0,GL_FALSE,data);
            no_error();
        }
        if(i<4)iv[i](location,0,NULL);else if(i<8)fv[i-4](location,0,NULL);else glUniform1fv(location,0,NULL);
        expected_error(GL_INVALID_OPERATION);
        if(i<4)fv[i](location,2,f);else if(i<8)iv[i-4](location,2,integers);else continue;
        expected_error(GL_INVALID_OPERATION);
    }
    GLint tail=glGetUniformLocation(program,"tail[0002]"); CHECK(tail>=0);no_error();
    glUniform4fv(tail,4,f);no_error();
    glUniform4fv(INT_MAX,0,unreadable);expected_error(GL_INVALID_OPERATION);
    puts("OK GLES positive uniforms: type, zero count and array tails");
}

static void large_uniforms(GLuint program) {
    void (*const fv[])(GLint,GLsizei,const GLfloat *)={glUniform1fv,glUniform2fv,glUniform3fv,glUniform4fv};
    void (*const iv[])(GLint,GLsizei,const GLint *)={glUniform1iv,glUniform2iv,glUniform3iv,glUniform4iv};
    void (*const matrix[])(GLint,GLsizei,GLboolean,const GLfloat *)={glUniformMatrix2fv,glUniformMatrix3fv,glUniformMatrix4fv};
    const char *names[]={"af1","af2","af3","af4","ai1","ai2","ai3","ai4","am2","am3","am4"};
    for(unsigned i=0;i<11;i++) {
        const unsigned components=i<8?i%4+1:i==8?4:i==9?9:16;
        const GLsizei count=(65535u-8u)/(components*4u)+2;
        const size_t elements=(size_t)count*components;
        void *data=malloc(elements*4u);CHECK(data);
        const int integer=i>=4 && i<8;
        for(size_t j=0;j<elements;j++) {
            if(integer)((GLint *)data)[j]=(GLint)(j%19)-4;
            else ((GLfloat *)data)[j]=(GLfloat)(j%19)+.25f;
        }
        const GLint location=glGetUniformLocation(program,names[i]);CHECK(location>=0);no_error();
        if(i<4)fv[i](location,count,data);else if(i<8)iv[i-4](location,count,data);else matrix[i-8](location,count,GL_FALSE,data);
        no_error();
#ifdef GLES_VALIDATE_RENDERED_PIXELS
        /* Actual driver reads cover both accepted array elements; all excess
         * source values were ignored by the bounded host transaction. */
        for(unsigned element=0;element<2;element++) {
            char name[16];snprintf(name,sizeof name,"%s[%u]",names[i],element);
            GLfloat values[17]={0};values[16]=91;
            GLint indexed=glGetUniformLocation(program,name);CHECK(indexed>=0);
            glGetUniformfv(program,indexed,values);no_error();CHECK(values[16]==91);
            for(unsigned j=0;j<components;j++) {
                const unsigned index=element*components+j;
                const GLfloat expected=integer?(GLfloat)((GLint)(index%19)-4):(GLfloat)(index%19)+.25f;
                CHECK(values[j]==expected);
            }
        }
#endif
        /* Whole-call count/type rejection must not change a non-array prefix. */
        if(i==0) {
            GLint scalar=glGetUniformLocation(program,"f1");CHECK(scalar>=0);
            glUniform1f(scalar,7);no_error();glUniform1fv(scalar,count,data);expected_error(GL_INVALID_OPERATION);
            GLint integer_array=glGetUniformLocation(program,"ai1");CHECK(integer_array>=0);
            const GLint prior[2]={9,10};glUniform1iv(integer_array,2,prior);no_error();
            glUniform1fv(integer_array,count,data);expected_error(GL_INVALID_OPERATION);
#ifdef GLES_VALIDATE_RENDERED_PIXELS
            GLfloat value=0;glGetUniformfv(program,scalar,&value);no_error();CHECK(value==7);
            for(unsigned element=0;element<2;element++) {
                GLint indexed=glGetUniformLocation(program,element?"ai1[1]":"ai1[0]"),unchanged=0;CHECK(indexed>=0);
                glGetUniformiv(program,indexed,&unchanged);no_error();CHECK(unchanged==prior[element]);
            }
#endif
        }
        free(data);
    }
    puts("OK GLES large uniform transactions: 11 setters and ignored array tails");
}

static void uniforms_without_program(void) {
    for (unsigned variant = 0; variant < 19; ++variant) {
        uniform_setter(variant, -1);
        expected_error(GL_INVALID_OPERATION);
    }
}

static void matrix_arguments(void) {
    void (*const setters[])(GLint, GLsizei, GLboolean, const GLfloat *) = {
        glUniformMatrix2fv, glUniformMatrix3fv, glUniformMatrix4fv,
    };
    const unsigned components[] = {4, 9, 16};
    /* Any accidental source load traps at either Wasm pointer width. The
     * tested argument paths must reject or ignore before touching data. */
    const GLfloat *unreadable = (const GLfloat *)(UINTPTR_MAX & ~(uintptr_t)3u);
    const GLsizei negative[] = {-1, INT_MIN};
    const GLboolean transpose[] = {GL_TRUE, 2, 255};
    for (unsigned i = 0; i < 3; ++i) {
        for (unsigned j = 0; j < 2; ++j) {
            setters[i](0, negative[j], GL_FALSE, unreadable);
            expected_error(GL_INVALID_VALUE);
            setters[i](-1, negative[j], GL_FALSE, unreadable);
            expected_error(GL_INVALID_VALUE);
        }
        setters[i](0, 0, GL_FALSE, unreadable);
        expected_error(GL_INVALID_OPERATION);
        setters[i](0, 0, GL_FALSE, NULL);
        expected_error(GL_INVALID_OPERATION);
        setters[i](-1, 1, GL_FALSE, unreadable);
        no_error();
        for (unsigned j = 0; j < 3; ++j) {
            setters[i](0, 1, transpose[j], unreadable);
            expected_error(GL_INVALID_VALUE);
            setters[i](0, 0, transpose[j], unreadable);
            expected_error(GL_INVALID_VALUE);
            setters[i](-1, 1, transpose[j], unreadable);
            expected_error(GL_INVALID_VALUE);
        }
        const GLsizei maximum = (65535u - 12u) / (sizeof(GLfloat) * components[i]);
        const GLsizei oversized[] = {maximum + 1, INT_MAX, 0x04000000, 0x10000000};
        for (unsigned j = 0; j < 4; ++j) {
            setters[i](0, oversized[j], GL_FALSE, unreadable);
            expected_error(GL_OUT_OF_MEMORY);
        }
        setters[i](-1, INT_MAX, GL_FALSE, unreadable);
        no_error();
    }
    puts("OK GLES uniform matrix validation: 3 sizes");
}

static void vector_arguments(void) {
    void (*const floating[])(GLint, GLsizei, const GLfloat *) = {
        glUniform1fv, glUniform2fv, glUniform3fv, glUniform4fv,
    };
    void (*const integer[])(GLint, GLsizei, const GLint *) = {
        glUniform1iv, glUniform2iv, glUniform3iv, glUniform4iv,
    };
    const void *unreadable = (const void *)(UINTPTR_MAX & ~(uintptr_t)3u);
    for (unsigned variant = 0; variant < 8; ++variant) {
        const unsigned index = variant % 4, components = index + 1;
#define VECTOR_CALL(location, count, value) do { \
    if (variant < 4) floating[index](location, count, value); \
    else integer[index](location, count, value); \
} while (0)
        const GLsizei negative[] = {-1, INT_MIN};
        for (unsigned j = 0; j < 2; ++j) {
            VECTOR_CALL(-1, negative[j], unreadable);
            expected_error(GL_INVALID_VALUE);
            VECTOR_CALL(-1, negative[j], NULL);
            expected_error(GL_INVALID_VALUE);
        }
        VECTOR_CALL(-1, 0, unreadable);
        VECTOR_CALL(-1, 0, NULL);
        VECTOR_CALL(-1, 1, unreadable);
        VECTOR_CALL(-1, 1, NULL);
        VECTOR_CALL(-1, INT_MAX, unreadable);
        no_error();
        /* The encoder's existing defensive transport checks are tested
         * separately from shader type/location validation. */
        VECTOR_CALL(0, 1, NULL);
        expected_error(GL_INVALID_VALUE);
        const GLsizei maximum = (65535u - 8u) / (sizeof(GLfloat) * components);
        const GLsizei oversized[] = {maximum + 1, INT_MAX, 0x04000000, 0x10000000};
        for (unsigned j = 0; j < 4; ++j) {
            VECTOR_CALL(0, oversized[j], unreadable);
            expected_error(GL_OUT_OF_MEMORY);
        }
#undef VECTOR_CALL
    }
    puts("OK GLES uniform vector validation: 8 setters");
}

#ifdef GLES_VALIDATE_RENDERED_PIXELS
static void rendered_pixels(void) {
    GLuint texture, framebuffer;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
    no_error();
    glViewport(0, 0, 2, 2);
    glClearColor(1, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, 1, 1);
    glClearColor(0, 1, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    unsigned char pixels[16] = {0};
    glReadPixels(0, 0, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    no_error();
    for (unsigned i = 0; i < sizeof pixels; i += 4) {
        CHECK(pixels[i] == (i ? 255 : 0));
        CHECK(pixels[i + 1] == (i ? 0 : 255));
        CHECK(pixels[i + 2] == (i ? 0 : 255));
        CHECK(pixels[i + 3] == 255);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(1, &texture);
    no_error();
    puts("OK GLES real framebuffer pixels after validation");
}
#endif

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
    string_query_errors();
    generation_counts();
    uniforms_without_program();
    GLuint uniform_program = uniform_test_program();
    uniform_locations();
    matrix_arguments();
    vector_arguments();
    positive_uniforms(uniform_program);
    large_uniforms(uniform_program);
    glUseProgram(0);
    glDeleteProgram(uniform_program);
    no_error();
    uniforms_without_program();
    puts("OK GLES inactive uniforms require current program: 19 setters");
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
#ifdef GLES_VALIDATE_RENDERED_PIXELS
    rendered_pixels();
#endif
    CHECK(eglDestroyContext(display,first) && eglReleaseThread() && eglTerminate(display));
    puts("OK GLES hints retain context state, conversions and invalid-enum errors");
    return 0;
}
