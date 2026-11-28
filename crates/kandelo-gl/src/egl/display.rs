//! The one display: the surfaceless platform (EGL 1.5 §3.2, §3.3).
//!
//! Ownership: `EGL_DEFAULT_DISPLAY` and `EGL_PLATFORM_SURFACELESS_MESA` name
//! the same display. Initializing it probes the device once by creating and
//! destroying one kgpu context; a machine without a renderer answers
//! `-ENODEV`, a task outside a memory group `-EOPNOTSUPP`, and either leaves
//! EGL uninitialized, truthfully.

use super::*;
use crate::kgpu::Device;
use core::ffi::CStr;

const ENODEV: i32 = 19;
const EOPNOTSUPP: i32 = 95;

pub const VENDOR: &CStr = c"Kandelo";
/// Display and client version alike: `<major>.<minor> <vendor info>`.
pub const VERSION: &CStr = c"1.5 kandelo-gl";
pub const CLIENT_APIS: &CStr = c"OpenGL_ES";
pub const DISPLAY_EXTENSIONS: &CStr = c"EGL_KHR_surfaceless_context EGL_KHR_no_config_context";
/// The client extensions. `EGL_MESA_platform_surfaceless` needs EGL 1.5 or
/// `EGL_EXT_platform_base`; the client version is 1.5, so the core
/// `eglGetPlatformDisplay` serves it. `EGL_EXT_platform_base` is not
/// listed because its entry points (`eglGetPlatformDisplayEXT` and the
/// platform surface creators) are not defined.
pub const CLIENT_EXTENSIONS: &CStr = c"EGL_EXT_client_extensions EGL_MESA_platform_surfaceless";

impl Driver {
    /// `eglGetDisplay`: only `EGL_DEFAULT_DISPLAY` names a display; any
    /// other native display is unavailable, which is `EGL_NO_DISPLAY` and no
    /// error (§3.2).
    pub fn get_display(&mut self, native: usize) -> usize {
        self.enter();
        thread::set_error(EGL_SUCCESS);
        if native == NO_HANDLE { DISPLAY } else { NO_HANDLE }
    }

    /// `eglGetPlatformDisplay`. The surfaceless platform is the only valid
    /// platform; it defines no attributes, and its native display must be
    /// `EGL_DEFAULT_DISPLAY` (EGL_MESA_platform_surfaceless).
    pub fn get_platform_display(&mut self, platform: EGLenum, native: usize, attribs: &[EGLAttrib]) -> usize {
        self.enter();
        let result = if platform != EGL_PLATFORM_SURFACELESS_MESA as EGLenum {
            Err(EGL_BAD_PARAMETER)
        } else if attribs.first().is_some_and(|&a| a != EGL_NONE as EGLAttrib) {
            Err(EGL_BAD_ATTRIBUTE)
        } else if native != NO_HANDLE {
            Err(EGL_BAD_PARAMETER)
        } else {
            Ok(DISPLAY)
        };
        thread::report(result, NO_HANDLE)
    }

    /// `eglInitialize`. A repeat call only reports the version again; it is
    /// not reference counted. The first call records the pid, so a fork
    /// child is recognized (`Driver::enter`).
    pub fn initialize(
        &mut self,
        dev: &mut impl Device,
        dpy: usize,
        major: Option<&mut EGLint>,
        minor: Option<&mut EGLint>,
    ) -> EGLBoolean {
        self.enter();
        let result = (|| {
            if dpy != DISPLAY {
                return Err(EGL_BAD_DISPLAY);
            }
            if !self.initialized {
                probe(dev)?;
                if self.contexts.is_empty() && self.surfaces.is_empty() {
                    // Nothing survives from an earlier initialization, so
                    // no thread's current-context record may name state.
                    self.epoch = thread::fresh_epoch();
                }
                self.initialized = true;
                self.owner_pid = Some(self.pid());
            }
            if let Some(major) = major {
                *major = 1;
            }
            if let Some(minor) = minor {
                *minor = 5;
            }
            Ok(EGL_TRUE as EGLBoolean)
        })();
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglTerminate`: every context and surface is marked for deletion and
    /// its handle is invalid at once; those current to a thread are
    /// destroyed when released (§3.2).
    pub fn terminate(&mut self, dev: &mut impl Device, dpy: usize) -> EGLBoolean {
        self.enter();
        let result = if dpy != DISPLAY {
            Err(EGL_BAD_DISPLAY)
        } else {
            if self.initialized {
                self.initialized = false;
                for c in self.contexts.values_mut() {
                    c.deleted = true;
                }
                for s in self.surfaces.values_mut() {
                    s.deleted = true;
                }
                self.reap(dev, "eglTerminate");
            }
            Ok(EGL_TRUE as EGLBoolean)
        };
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglQueryString`. With `EGL_NO_DISPLAY` it answers the client
    /// extensions and the client version.
    pub fn query_string(&mut self, dpy: usize, name: EGLint) -> Option<&'static CStr> {
        self.enter();
        let result = if dpy == NO_HANDLE {
            match name {
                EGL_EXTENSIONS => Ok(CLIENT_EXTENSIONS),
                EGL_VERSION => Ok(VERSION),
                _ => Err(EGL_BAD_DISPLAY),
            }
        } else {
            self.initialized_display(dpy).and_then(|()| match name {
                EGL_VENDOR => Ok(VENDOR),
                EGL_VERSION => Ok(VERSION),
                EGL_CLIENT_APIS => Ok(CLIENT_APIS),
                EGL_EXTENSIONS => Ok(DISPLAY_EXTENSIONS),
                _ => Err(EGL_BAD_PARAMETER),
            })
        };
        thread::report(result.map(Some), None)
    }
}

/// Creates and destroys one kgpu context, to learn whether the machine can
/// render at all.
fn probe(dev: &mut impl Device) -> Result<()> {
    let context = dev.context_create().map_err(|errno| {
        if -errno != ENODEV && -errno != EOPNOTSUPP {
            crate::diag(format_args!("eglInitialize: kgpu context create failed: {}", crate::Errno(errno)));
        }
        EGL_NOT_INITIALIZED
    })?;
    dev.context_destroy(context).map_err(|errno| {
        crate::diag(format_args!("eglInitialize: kgpu context destroy failed: {}", crate::Errno(errno)));
        EGL_NOT_INITIALIZED
    })
}
