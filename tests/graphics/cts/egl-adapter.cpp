/* Kandelo harness adaptation; assertions live in surfaceless-case.inc. */
#define EGL_EGLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <gbm.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <algorithm>
using std::string;
using std::vector;

namespace tcu {
struct TestLog {
    enum Token { Message, EndMessage };
    TestLog &operator<<(Token token) {
        if (token == EndMessage) std::cout << '\n';
        return *this;
    }
    template<class T> TestLog &operator<<(const T &value) {
        std::cout << value; return *this;
    }
};
template<class T> T toHex(T value) { return value; }
}
using tcu::TestLog;
namespace eglw {
struct Library {
    EGLBoolean bindAPI(EGLenum api) const { return eglBindAPI(api); }
    EGLContext createContext(EGLDisplay d, EGLConfig c, EGLContext share,
                             const EGLint *a) const { return eglCreateContext(d,c,share,a); }
    EGLBoolean makeCurrent(EGLDisplay d, EGLSurface draw, EGLSurface read,
                           EGLContext c) const { return eglMakeCurrent(d,draw,read,c); }
    EGLint getError() const { return eglGetError(); }
};
}
using namespace eglw;
namespace eglu {
static void checkError(EGLint error, const char *message) {
    if (error != EGL_SUCCESS)
        throw std::runtime_error(string(message) + ": EGL error " + std::to_string(error));
}
static EGLint getConfigAttribInt(const Library &egl, EGLDisplay d,
                                 EGLConfig c, EGLint key) {
    EGLint value = 0;
    eglGetConfigAttrib(d,c,key,&value);
    checkError(egl.getError(),"eglGetConfigAttrib");
    return value;
}
static bool hasExtension(const Library &, EGLDisplay d, const char *name) {
    const char *all = eglQueryString(d,EGL_EXTENSIONS);
    if (!all) return false;
    const size_t n = strlen(name);
    for (const char *at = all; (at = strstr(at,name)); at += n)
        if ((at == all || at[-1] == ' ') && (at[n] == 0 || at[n] == ' ')) return true;
    return false;
}
static string getErrorName(EGLenum error) { return std::to_string(error); }
struct UniqueContext {
    EGLDisplay display; EGLContext context;
    UniqueContext(const Library &, EGLDisplay d, EGLContext c) : display(d), context(c) {}
    ~UniqueContext() { if (context != EGL_NO_CONTEXT) eglDestroyContext(display,context); }
    EGLContext operator*() const { return context; }
};
}
#define DE_LENGTH_OF_ARRAY(a) (sizeof(a)/sizeof((a)[0]))
#define QP_TEST_RESULT_FAIL 1
#define TCU_THROW(type, message) throw std::runtime_error(message)
#define EGLU_CHECK_MSG(egl, message) eglu::checkError((egl).getError(), message)
#define EGLU_CHECK_CALL(egl, call) do { (egl).call; EGLU_CHECK_MSG(egl,#call); } while(false)
struct EglTestContext {
    Library library;
    const Library &getLibrary() const { return library; }
};
struct TestContext {
    TestLog log;
    bool failed = false;
    TestLog &getLog() { return log; }
    void setTestResult(int, const char *message) { failed = true; std::cerr << message << '\n'; }
};
struct SurfacelessContextCase {
    EglTestContext m_eglTestCtx;
    TestContext m_testCtx;
    void executeForConfig(EGLDisplay display, EGLConfig config);
};
#include "surfaceless-case.inc"

int main() {
    int fd = open("/dev/dri/card0",O_RDWR);
    if (fd < 0) { std::cerr << "open card0 failed\n"; return 1; }
    gbm_device *device = gbm_create_device(fd);
    if (!device) { close(fd); return 1; }
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR,device,nullptr);
    EGLint major = 0, minor = 0;
    int result = 1;
    if (eglInitialize(display,&major,&minor)) {
        try {
            EGLint count = 0;
            if (!eglGetConfigs(display,nullptr,0,&count) || count <= 0)
                throw std::runtime_error("no EGL configs");
            vector<EGLConfig> configs(count);
            if (!eglGetConfigs(display,configs.data(),count,&count))
                throw std::runtime_error("config enumeration failed");
            unsigned tested = 0;
            result = 0;
            for (int i = 0; i < count; i++) {
                SurfacelessContextCase test;
                test.executeForConfig(display,configs[i]);
                if (test.m_testCtx.failed) result = 1;
                tested++;
            }
            if (!tested) result = 1;
            std::cout << "CTS-SUBSET " << (result ? "FAIL" : "PASS")
                      << " surfaceless_context configs=" << tested << '\n';
        } catch (const std::exception &error) {
            std::cerr << "CTS-SUBSET FAIL " << error.what() << '\n';
            result = 1;
        }
        eglTerminate(display);
    } else std::cerr << "eglInitialize failed: " << eglGetError() << '\n';
    gbm_device_destroy(device);
    close(fd);
    return result;
}
