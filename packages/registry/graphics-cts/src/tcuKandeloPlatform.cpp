// SPDX-License-Identifier: Apache-2.0
// Native port only: all CTS cases, dispatch, comparisons and results are upstream.
#include "tcuPlatform.hpp"
#include "gluPlatform.hpp"
#include "egluPlatform.hpp"
#include "egluNativeDisplay.hpp"
#include "egluNativeWindow.hpp"
#include "egluGLContextFactory.hpp"
#include "eglwLibrary.hpp"
#include "tcuFunctionLibrary.hpp"
#include "eglwEnums.hpp"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <gbm.h>
#include <fcntl.h>
#include <unistd.h>

namespace {
// Use actual linked EGL1.4 symbols, then the real platform proc resolver for
// later core/extensions. Incomplete EGL1.5 implementations remain incomplete:
// no synthetic entry point, success result or capability suppression is added.
const tcu::StaticFunctionLibrary::Entry core14Entries[] = {
#include "eglwStaticLibrary14.inl"
};

class Loader final : public eglw::FunctionLoader {
public:
    Loader() : m_core(core14Entries, DE_LENGTH_OF_ARRAY(core14Entries)) {}
    eglw::GenericFuncType get(const char *name) const override {
        const deFunctionPtr linked = m_core.getFunction(name);
        return linked ? reinterpret_cast<eglw::GenericFuncType>(linked)
                      : reinterpret_cast<eglw::GenericFuncType>(eglGetProcAddress(name));
    }
private:
    tcu::StaticFunctionLibrary m_core;
};

class Library final : public eglw::FuncPtrLibrary {
public:
    Library() {
        const Loader loader;
        eglw::initCore(&m_egl, &loader);
        eglw::initExtensions(&m_egl, &loader);
    }
};
constexpr eglu::NativeDisplay::Capability displayCaps =
    static_cast<eglu::NativeDisplay::Capability>(
        eglu::NativeDisplay::CAPABILITY_GET_DISPLAY_LEGACY |
        eglu::NativeDisplay::CAPABILITY_GET_DISPLAY_PLATFORM |
        eglu::NativeDisplay::CAPABILITY_GET_DISPLAY_PLATFORM_EXT);
constexpr eglu::NativeWindow::Capability windowCaps =
    static_cast<eglu::NativeWindow::Capability>(
        eglu::NativeWindow::CAPABILITY_CREATE_SURFACE_LEGACY |
        eglu::NativeWindow::CAPABILITY_CREATE_SURFACE_PLATFORM |
        eglu::NativeWindow::CAPABILITY_CREATE_SURFACE_PLATFORM_EXTENSION |
        eglu::NativeWindow::CAPABILITY_GET_SURFACE_SIZE);

class Display final : public eglu::NativeDisplay {
public:
    Display() : NativeDisplay(displayCaps, EGL_PLATFORM_GBM_KHR, "EGL_KHR_platform_gbm"),
                m_fd(-1), m_device(nullptr), m_library() {
        m_fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
        if (m_fd < 0) TCU_THROW(ResourceError, "open /dev/dri/renderD128 failed");
        m_device = gbm_create_device(m_fd);
        if (!m_device) {
            close(m_fd);
            m_fd = -1;
            TCU_THROW(ResourceError, "gbm_create_device failed");
        }
    }
    ~Display() override { gbm_device_destroy(m_device); close(m_fd); }
    eglw::EGLNativeDisplayType getLegacyNative() override { return m_device; }
    void *getPlatformNative() override { return m_device; }
    const eglw::EGLAttrib *getPlatformAttributes() const override { return nullptr; }
    const eglw::Library &getLibrary() const override { return m_library; }
    gbm_device *device() const { return m_device; }
private:
    int m_fd;
    gbm_device *m_device;
    Library m_library;
};

class Window final : public eglu::NativeWindow {
public:
    Window(Display &display, const eglu::WindowParams &params, unsigned format)
        : NativeWindow(windowCaps),
          m_size(params.width == eglu::WindowParams::SIZE_DONT_CARE ? 256 : params.width,
                 params.height == eglu::WindowParams::SIZE_DONT_CARE ? 256 : params.height),
          m_surface(nullptr) {
        if (m_size.x() <= 0 || m_size.y() <= 0)
            TCU_THROW(ResourceError, "invalid GBM window dimensions");
        if (params.visibility == eglu::WindowParams::VISIBILITY_VISIBLE ||
            params.visibility == eglu::WindowParams::VISIBILITY_FULLSCREEN)
            TCU_THROW(NotSupportedError, "GBM factory has no native window visibility/KMS presentation service");
        m_surface = gbm_surface_create(display.device(), m_size.x(), m_size.y(), format, GBM_BO_USE_RENDERING);
        if (!m_surface) TCU_THROW(ResourceError, "gbm_surface_create failed");
    }
    ~Window() override { gbm_surface_destroy(m_surface); }
    eglw::EGLNativeWindowType getLegacyNative() override { return m_surface; }
    void *getPlatformNative() override { return m_surface; }
    void *getPlatformExtension() override { return m_surface; }
    tcu::IVec2 getSurfaceSize() const override { return m_size; }
private:
    tcu::IVec2 m_size;
    gbm_surface *m_surface;
};

class WindowFactory final : public eglu::NativeWindowFactory {
public:
    WindowFactory() : NativeWindowFactory("gbm", "GBM native render surface", windowCaps) {}
    eglu::NativeWindow *createWindow(eglu::NativeDisplay *native, const eglu::WindowParams &params) const override {
        return new Window(static_cast<Display &>(*native), params, GBM_FORMAT_ABGR8888);
    }
    eglu::NativeWindow *createWindow(eglu::NativeDisplay *native, eglw::EGLDisplay display,
                                    eglw::EGLConfig config, const eglw::EGLAttrib *,
                                    const eglu::WindowParams &params) const override {
        eglw::EGLint format = 0;
        const eglw::Library &egl = native->getLibrary();
        const eglw::EGLBoolean accepted = egl.getConfigAttrib(display, config, EGL_NATIVE_VISUAL_ID, &format);
        const eglw::EGLint error = egl.getError();
        if (!accepted || error != EGL_SUCCESS)
            TCU_THROW(ResourceError, "EGL_NATIVE_VISUAL_ID query failed");
        return new Window(static_cast<Display &>(*native), params, static_cast<unsigned>(format));
    }
};

class DisplayFactory final : public eglu::NativeDisplayFactory {
public:
    DisplayFactory() : NativeDisplayFactory("gbm", "Kandelo GBM render node", displayCaps,
                                           EGL_PLATFORM_GBM_KHR, "EGL_KHR_platform_gbm") {
        m_nativeWindowRegistry.registerFactory(new WindowFactory());
    }
    eglu::NativeDisplay *createDisplay(const eglw::EGLAttrib *attributes = nullptr) const override {
        if (attributes && attributes[0] != EGL_NONE)
            TCU_THROW(NotSupportedError, "GBM display factory attributes are not supported");
        return new Display();
    }
};

class Platform final : public tcu::Platform, public glu::Platform, public eglu::Platform {
public:
    Platform() {
        m_nativeDisplayFactoryRegistry.registerFactory(new DisplayFactory());
        m_contextFactoryRegistry.registerFactory(new eglu::GLContextFactory(m_nativeDisplayFactoryRegistry));
    }
    const glu::Platform &getGLPlatform() const override { return *this; }
    const eglu::Platform &getEGLPlatform() const override { return *this; }
};
} // namespace

tcu::Platform *createPlatform() { return new Platform(); }
