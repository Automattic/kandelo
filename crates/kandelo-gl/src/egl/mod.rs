//! The EGL 1.5 model: one surfaceless display, one pbuffer config, pbuffer
//! surfaces and OpenGL ES 2.0 contexts.
//!
//! Ownership: every EGL object lives in one process-wide `Driver`, behind
//! the global driver lock (`thread::DriverLock`). The calling thread's error,
//! bound API and current context are per-thread state (`thread`). Each
//! exported `egl*` function (`entry`) is a thin wrapper that converts C
//! pointers, takes the lock and calls the safe `Driver` method of the same
//! name over the real `KgpuDevice`; the native tests drive those same
//! methods over `FakeDevice`.
//!
//! Handles are opaque nonzero integers cast to pointers, never addresses:
//! the display is 1, and configs, contexts and surfaces carry a kind tag in
//! their low two bits over a per-kind counter that is never reused, so a
//! stale or mistyped handle is refused instead of naming another object.
//!
//! The model makes no kgpu call except where the GPU must act: the
//! `eglInitialize` probe (create and destroy one context), `eglCreateContext`
//! and the destruction of a context, and submissions when a context is
//! flushed (released by `eglMakeCurrent`, `eglSwapBuffers`, `eglWaitClient`,
//! surface destruction). Nothing here waits. Queries never reach the device.
//!
//! Skeleton limits (docs/plans/2026-11-28-rust-gpu-slice2-plan.md):
//! surfaceless platform and pbuffers only; no share contexts; a surface's
//! storage lives in the kgpu context it was first made current with; draw
//! and read surfaces must be the same.

pub mod config;
pub mod context;
pub mod display;
mod entry;
pub mod surface;
pub mod thread;
#[cfg(test)]
mod tests;

use alloc::collections::BTreeMap;

pub use context::Context;
pub use entry::{eglGetError, get_proc_address, with_driver};
#[cfg(test)]
pub(crate) use entry::fork_child_reset_for_test;
pub use surface::Surface;
pub use thread::{ContextRef, DisplayRef, current};

/// `EGLint` (`khronos_int32_t`).
pub type EGLint = i32;
/// `EGLenum` (`unsigned int`).
pub type EGLenum = u32;
/// `EGLBoolean` (`unsigned int`).
pub type EGLBoolean = u32;
/// `EGLAttrib` (`intptr_t`).
pub type EGLAttrib = isize;

/// An EGL call's outcome before it is reported: `Err` is the EGL error
/// code the calling thread's `eglGetError` will return.
pub type Result<T> = core::result::Result<T, EGLint>;

macro_rules! egl_tokens {
    ($($name:ident = $value:expr;)*) => {
        // The Khronos spellings, including EGL_VG_COLORSPACE_sRGB.
        $(#[allow(non_upper_case_globals)] pub const $name: EGLint = $value;)*
        /// Every token above with its value, checked against the Khronos
        /// headers in `libc/musl-overlay/include/EGL` by the tests.
        #[cfg(test)]
        pub(crate) const HEADER_TOKENS: &[(&str, EGLint)] = &[$((stringify!($name), $value)),*];
    };
}

egl_tokens! {
    EGL_FALSE = 0;
    EGL_TRUE = 1;
    EGL_DONT_CARE = -1;
    EGL_UNKNOWN = -1;
    EGL_DISPLAY_SCALING = 10000;

    EGL_SUCCESS = 0x3000;
    EGL_NOT_INITIALIZED = 0x3001;
    EGL_BAD_ACCESS = 0x3002;
    EGL_BAD_ALLOC = 0x3003;
    EGL_BAD_ATTRIBUTE = 0x3004;
    EGL_BAD_CONFIG = 0x3005;
    EGL_BAD_CONTEXT = 0x3006;
    EGL_BAD_CURRENT_SURFACE = 0x3007;
    EGL_BAD_DISPLAY = 0x3008;
    EGL_BAD_MATCH = 0x3009;
    EGL_BAD_NATIVE_PIXMAP = 0x300A;
    EGL_BAD_NATIVE_WINDOW = 0x300B;
    EGL_BAD_PARAMETER = 0x300C;
    EGL_BAD_SURFACE = 0x300D;
    EGL_CONTEXT_LOST = 0x300E;

    EGL_BUFFER_SIZE = 0x3020;
    EGL_ALPHA_SIZE = 0x3021;
    EGL_BLUE_SIZE = 0x3022;
    EGL_GREEN_SIZE = 0x3023;
    EGL_RED_SIZE = 0x3024;
    EGL_DEPTH_SIZE = 0x3025;
    EGL_STENCIL_SIZE = 0x3026;
    EGL_CONFIG_CAVEAT = 0x3027;
    EGL_CONFIG_ID = 0x3028;
    EGL_LEVEL = 0x3029;
    EGL_MAX_PBUFFER_HEIGHT = 0x302A;
    EGL_MAX_PBUFFER_PIXELS = 0x302B;
    EGL_MAX_PBUFFER_WIDTH = 0x302C;
    EGL_NATIVE_RENDERABLE = 0x302D;
    EGL_NATIVE_VISUAL_ID = 0x302E;
    EGL_NATIVE_VISUAL_TYPE = 0x302F;
    EGL_SAMPLES = 0x3031;
    EGL_SAMPLE_BUFFERS = 0x3032;
    EGL_SURFACE_TYPE = 0x3033;
    EGL_TRANSPARENT_TYPE = 0x3034;
    EGL_TRANSPARENT_BLUE_VALUE = 0x3035;
    EGL_TRANSPARENT_GREEN_VALUE = 0x3036;
    EGL_TRANSPARENT_RED_VALUE = 0x3037;
    EGL_NONE = 0x3038;
    EGL_BIND_TO_TEXTURE_RGB = 0x3039;
    EGL_BIND_TO_TEXTURE_RGBA = 0x303A;
    EGL_MIN_SWAP_INTERVAL = 0x303B;
    EGL_MAX_SWAP_INTERVAL = 0x303C;
    EGL_LUMINANCE_SIZE = 0x303D;
    EGL_ALPHA_MASK_SIZE = 0x303E;
    EGL_COLOR_BUFFER_TYPE = 0x303F;
    EGL_RENDERABLE_TYPE = 0x3040;
    EGL_MATCH_NATIVE_PIXMAP = 0x3041;
    EGL_CONFORMANT = 0x3042;

    EGL_SLOW_CONFIG = 0x3050;
    EGL_NON_CONFORMANT_CONFIG = 0x3051;
    EGL_TRANSPARENT_RGB = 0x3052;
    EGL_RGB_BUFFER = 0x308E;
    EGL_LUMINANCE_BUFFER = 0x308F;

    EGL_PBUFFER_BIT = 0x0001;
    EGL_PIXMAP_BIT = 0x0002;
    EGL_WINDOW_BIT = 0x0004;
    EGL_VG_COLORSPACE_LINEAR_BIT = 0x0020;
    EGL_VG_ALPHA_FORMAT_PRE_BIT = 0x0040;
    EGL_MULTISAMPLE_RESOLVE_BOX_BIT = 0x0200;
    EGL_SWAP_BEHAVIOR_PRESERVED_BIT = 0x0400;

    EGL_OPENGL_ES_BIT = 0x0001;
    EGL_OPENVG_BIT = 0x0002;
    EGL_OPENGL_ES2_BIT = 0x0004;
    EGL_OPENGL_BIT = 0x0008;
    EGL_OPENGL_ES3_BIT = 0x0040;

    EGL_VENDOR = 0x3053;
    EGL_VERSION = 0x3054;
    EGL_EXTENSIONS = 0x3055;
    EGL_CLIENT_APIS = 0x308D;

    EGL_HEIGHT = 0x3056;
    EGL_WIDTH = 0x3057;
    EGL_LARGEST_PBUFFER = 0x3058;
    EGL_DRAW = 0x3059;
    EGL_READ = 0x305A;
    EGL_NO_TEXTURE = 0x305C;
    EGL_TEXTURE_RGB = 0x305D;
    EGL_TEXTURE_RGBA = 0x305E;
    EGL_TEXTURE_2D = 0x305F;
    EGL_TEXTURE_FORMAT = 0x3080;
    EGL_TEXTURE_TARGET = 0x3081;
    EGL_MIPMAP_TEXTURE = 0x3082;
    EGL_MIPMAP_LEVEL = 0x3083;
    EGL_BACK_BUFFER = 0x3084;
    EGL_SINGLE_BUFFER = 0x3085;
    EGL_RENDER_BUFFER = 0x3086;
    EGL_VG_COLORSPACE = 0x3087;
    EGL_VG_ALPHA_FORMAT = 0x3088;
    EGL_VG_COLORSPACE_sRGB = 0x3089;
    EGL_VG_COLORSPACE_LINEAR = 0x308A;
    EGL_VG_ALPHA_FORMAT_NONPRE = 0x308B;
    EGL_VG_ALPHA_FORMAT_PRE = 0x308C;
    EGL_HORIZONTAL_RESOLUTION = 0x3090;
    EGL_VERTICAL_RESOLUTION = 0x3091;
    EGL_PIXEL_ASPECT_RATIO = 0x3092;
    EGL_SWAP_BEHAVIOR = 0x3093;
    EGL_BUFFER_PRESERVED = 0x3094;
    EGL_BUFFER_DESTROYED = 0x3095;
    EGL_MULTISAMPLE_RESOLVE = 0x3099;
    EGL_MULTISAMPLE_RESOLVE_DEFAULT = 0x309A;
    EGL_MULTISAMPLE_RESOLVE_BOX = 0x309B;
    EGL_GL_COLORSPACE = 0x309D;
    EGL_GL_COLORSPACE_SRGB = 0x3089;
    EGL_GL_COLORSPACE_LINEAR = 0x308A;

    EGL_CONTEXT_CLIENT_TYPE = 0x3097;
    EGL_CONTEXT_CLIENT_VERSION = 0x3098;
    EGL_CONTEXT_MAJOR_VERSION = 0x3098;
    EGL_CONTEXT_MINOR_VERSION = 0x30FB;
    EGL_CONTEXT_OPENGL_PROFILE_MASK = 0x30FD;
    EGL_CONTEXT_OPENGL_DEBUG = 0x31B0;
    EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE = 0x31B1;
    EGL_CONTEXT_OPENGL_ROBUST_ACCESS = 0x31B2;
    EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY = 0x31BD;
    EGL_NO_RESET_NOTIFICATION = 0x31BE;
    EGL_LOSE_CONTEXT_ON_RESET = 0x31BF;

    EGL_OPENGL_ES_API = 0x30A0;
    EGL_OPENVG_API = 0x30A1;
    EGL_OPENGL_API = 0x30A2;

    EGL_PLATFORM_SURFACELESS_MESA = 0x31DD;
}

/// `EGL_DEFAULT_DISPLAY`, `EGL_NO_DISPLAY`, `EGL_NO_CONTEXT`,
/// `EGL_NO_SURFACE` and `EGL_NO_CONFIG_KHR` are all the null handle.
pub const NO_HANDLE: usize = 0;
/// The one display's handle.
pub const DISPLAY: usize = 1;

const TAG_CONFIG: usize = 1;
const TAG_CONTEXT: usize = 2;
const TAG_SURFACE: usize = 3;

/// The handle of config `id`.
pub const fn config_handle(id: EGLint) -> usize {
    ((id as usize) << 2) | TAG_CONFIG
}

/// The next handle of a kind, or `EGL_BAD_ALLOC` once its counter is spent.
/// Counters never wrap, so a handle is never reused for another object.
fn next_handle(counter: &mut usize, tag: usize) -> Result<usize> {
    let n = *counter;
    if n > usize::MAX >> 2 {
        return Err(EGL_BAD_ALLOC);
    }
    *counter = n + 1;
    Ok((n << 2) | tag)
}

/// The process's EGL state: the display, and every context and surface
/// created on it. All of it is behind the global driver lock.
pub struct Driver {
    /// `eglInitialize` succeeded and no `eglTerminate` followed.
    initialized: bool,
    /// Tags the per-thread current-context records that belong to this
    /// state. A fresh `eglInitialize` and a fork reset take a new epoch, so
    /// a thread's record from before either names nothing.
    epoch: u32,
    next_context: usize,
    next_surface: usize,
    contexts: BTreeMap<usize, Context>,
    surfaces: BTreeMap<usize, Surface>,
}

impl Default for Driver {
    fn default() -> Self {
        Self::new()
    }
}

impl Driver {
    pub const fn new() -> Self {
        Self {
            initialized: false,
            epoch: 0,
            next_context: 1,
            next_surface: 1,
            contexts: BTreeMap::new(),
            surfaces: BTreeMap::new(),
        }
    }

    /// The live context `r` names, if it still exists in this state. The GL
    /// entry points reach their context's state through this.
    pub fn context_mut(&mut self, r: ContextRef) -> Option<&mut Context> {
        if r.epoch != self.epoch {
            return None;
        }
        self.contexts.get_mut(&r.handle)
    }

    #[cfg(test)]
    pub(crate) fn initialized_for_test(&self) -> bool {
        self.initialized
    }

    /// The surface `handle` names, including one marked for deletion that
    /// is still current.
    pub fn surface(&self, handle: usize) -> Option<&Surface> {
        self.surfaces.get(&handle)
    }

    /// The fork child's reset (`entry`'s `pthread_atfork` child handler).
    /// The parent's kgpu contexts belong to the parent, so the child
    /// forgets every display, context and surface without destroying any
    /// kgpu context, and answers as a never-initialized display; it may
    /// initialize anew. The calling thread is the child's only thread, so
    /// its current-context record is the only one to clear, and GL calls
    /// then find no current context.
    ///
    /// `consistent` is false when another thread held the driver lock at
    /// the fork: that thread may have been midway through changing this
    /// state, so it is leaked rather than walked to free it.
    pub(crate) fn reset_after_fork(&mut self, consistent: bool) {
        let inherited = core::mem::replace(self, Driver::new());
        if consistent {
            drop(inherited);
        } else {
            core::mem::forget(inherited);
        }
        self.epoch = thread::fresh_epoch();
        thread::set_current(None);
    }

    /// `dpy` names the display (`EGL_BAD_DISPLAY` otherwise) and it is
    /// initialized (`EGL_NOT_INITIALIZED` otherwise).
    fn initialized_display(&self, dpy: usize) -> Result<()> {
        if dpy != DISPLAY {
            return Err(EGL_BAD_DISPLAY);
        }
        if !self.initialized {
            return Err(EGL_NOT_INITIALIZED);
        }
        Ok(())
    }

    /// The calling thread's current context in this state, if any.
    fn current(&self) -> Option<thread::Current> {
        thread::get_current().filter(|c| c.epoch == self.epoch && self.contexts.contains_key(&c.context))
    }
}

/// Parses an EGL attribute list into `(name, value)` pairs. It ends at the
/// first `EGL_NONE` name; a name without a value is `EGL_BAD_ATTRIBUTE`.
fn attrib_pairs(list: &[EGLint]) -> impl Iterator<Item = Result<(EGLint, EGLint)>> + '_ {
    let mut i = 0;
    core::iter::from_fn(move || {
        let name = *list.get(i)?;
        if name == EGL_NONE {
            return None;
        }
        let Some(&value) = list.get(i + 1) else {
            i = list.len();
            return Some(Err(EGL_BAD_ATTRIBUTE));
        };
        i += 2;
        Some(Ok((name, value)))
    })
}
