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
#include <cassert>
#include <cstdio>
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
    EGLBoolean queryContext(EGLDisplay d, EGLContext c, EGLint a, EGLint *v) const {
        return eglQueryContext(d,c,a,v);
    }
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
struct FilterList {};
struct Version {
    int major, minor;
    Version(int a, int b) : major(a), minor(b) {}
    bool operator>=(const Version &other) const {
        return major > other.major || (major == other.major && minor >= other.minor);
    }
};
static Version getVersion(const Library &egl, EGLDisplay display) {
    const char *text = eglQueryString(display,EGL_VERSION);
    checkError(egl.getError(),"eglQueryString(EGL_VERSION)");
    int major = 0, minor = 0;
    if (!text || std::sscanf(text,"%d.%d",&major,&minor) != 2)
        throw std::runtime_error("invalid EGL version string");
    return Version(major,minor);
}
struct CallLogWrapper {
    CallLogWrapper(const Library &, TestLog &) {}
    // Call tracing is harness presentation; the imported class diagnostics
    // and actual guest API dispatch remain independent of this toggle.
    void enableLogging(bool) {}
};

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
#define DE_UNREF(value) ((void)(value))
#define DE_ASSERT(value) assert(value)
struct Config { EGLConfig config; EGLint apiBits, surfaceTypeBit; };
static EGLint getBuildClientAPIMask() { return EGL_OPENGL_ES2_BIT; }
struct SingleContextRenderCase {
    EglTestContext &m_eglTestCtx;
    TestContext m_testCtx;
    SingleContextRenderCase(EglTestContext &context, const char *, const char *,
        EGLint, EGLint, const eglu::FilterList &) : m_eglTestCtx(context) {}
};
#include "query-context-cases.inc"

template<class Case> static bool executeQueryCase(EglTestContext &egl, const char *name,
    EGLDisplay display, EGLContext context, EGLSurface surface, const Config &config) {
    Case test(egl,name,name,eglu::FilterList{},config.surfaceTypeBit);
    test.executeForContext(display,context,surface,config);
    return !test.m_testCtx.failed;
}
static bool runQueryContextCases(EGLDisplay display, gbm_device *device,
    const vector<EGLConfig> &configs) {
    EglTestContext egl;
    unsigned testedConfigs=0, windows=0, pbuffers=0, contexts=0, checks=0;
    bool passed=true;
    for (EGLConfig config : configs) {
        EGLint api=0, modes=0, visual=0;
        if (!eglGetConfigAttrib(display,config,EGL_RENDERABLE_TYPE,&api) ||
            !eglGetConfigAttrib(display,config,EGL_SURFACE_TYPE,&modes) ||
            !eglGetConfigAttrib(display,config,EGL_NATIVE_VISUAL_ID,&visual))
            throw std::runtime_error("query context config enumeration failed");
        if (!(api & EGL_OPENGL_ES2_BIT)) continue;
        ++testedConfigs;
        if (!(modes & (EGL_WINDOW_BIT|EGL_PBUFFER_BIT)))
            throw std::runtime_error("advertised ES2 config has no enabled query surface type");
        for (EGLint mode : {EGL_WINDOW_BIT,EGL_PBUFFER_BIT}) {
            if (!(modes & mode)) continue;
            gbm_surface *window=nullptr;
            EGLSurface surface=EGL_NO_SURFACE;
            if (mode==EGL_WINDOW_BIT) {
                window=gbm_surface_create(device,16,16,(uint32_t)visual,
                    GBM_BO_USE_RENDERING|GBM_BO_USE_SCANOUT);
                if (!window) throw std::runtime_error("query context GBM window creation failed");
                surface=eglCreatePlatformWindowSurface(display,config,window,nullptr);
                ++windows;
            } else {
                const EGLint attributes[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
                surface=eglCreatePbufferSurface(display,config,attributes);
                ++pbuffers;
            }
            if (surface==EGL_NO_SURFACE)
                throw std::runtime_error("query context surface creation failed");
            if (!eglBindAPI(EGL_OPENGL_ES_API))
                throw std::runtime_error("query context API bind failed");
            const EGLint attributes[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
            EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,attributes);
            if (context==EGL_NO_CONTEXT || !eglMakeCurrent(display,surface,surface,context))
                throw std::runtime_error("query context creation/current binding failed");
            const Config selected{config,EGL_OPENGL_ES2_BIT,mode};
            std::cout << "CTS-QUERY config=" << (uintptr_t)config << " surface=" << mode << '\n';
            // Do not short-circuit after one assertion failure: every enabled
            // class runs, and the process preserves the aggregate failure.
            passed=executeQueryCase<GetCurrentContextCase>(egl,"get_current_context",display,context,surface,selected) && passed; ++checks;
            passed=executeQueryCase<GetCurrentSurfaceCase>(egl,"get_current_surface",display,context,surface,selected) && passed; ++checks;
            passed=executeQueryCase<GetCurrentDisplayCase>(egl,"get_current_display",display,context,surface,selected) && passed; ++checks;
            passed=executeQueryCase<QueryContextCase>(egl,"query_context",display,context,surface,selected) && passed; ++checks;
            ++contexts;
            if (!eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT) ||
                !eglDestroyContext(display,context) || !eglDestroySurface(display,surface))
                throw std::runtime_error("query context cleanup failed");
            if (window) gbm_surface_destroy(window);
        }
    }
    if (!testedConfigs || !contexts || checks!=contexts*4) passed=false;
    std::cout << "CTS-SUBSET " << (passed ? "PASS" : "FAIL")
        << " query_context configs=" << testedConfigs << " windows=" << windows
        << " pbuffers=" << pbuffers << " contexts=" << contexts << " checks=" << checks << '\n';
    return passed;
}


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
            if (!runQueryContextCases(display,device,configs)) result=1;
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
