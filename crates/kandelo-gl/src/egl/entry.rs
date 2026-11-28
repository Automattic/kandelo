//! The exported EGL entry points, with the Khronos signatures of
//! `libc/musl-overlay/include/EGL/egl.h`.
//!
//! Ownership: each function only converts C arguments (nullable pointers,
//! `EGL_NONE`-terminated attribute lists, handles as pointers), takes the
//! driver lock and calls the `Driver` method of the same name over the
//! real `KgpuDevice`. All EGL behavior is in those methods, which the native
//! tests drive over `FakeDevice`. Functions that read only per-thread state
//! (`eglGetError`, `eglBindAPI`, `eglQueryAPI`) and `eglGetProcAddress` take
//! no lock.

use super::thread::{self, DriverLock};
use super::*;
use crate::gles::{
    glClear, glClearColor, glFinish, glFlush, glGetBooleanv, glGetError, glGetFloatv, glGetIntegerv, glGetString,
    glReadPixels, glViewport,
};
use crate::kgpu::KgpuDevice;
use core::ffi::{CStr, c_char, c_void};

static DRIVER: DriverLock<Driver> = DriverLock::new(Driver::new());

/// The `pthread_atfork` child handler: a fork child did not inherit the
/// parent's kgpu contexts, so it forgets the driver state without
/// destroying or freeing any of it (`Driver::reset_after_fork`), and
/// releases the lock another parent thread may have held.
extern "C" fn fork_child() {
    reset_in_fork_child(&DRIVER);
}

fn reset_in_fork_child(lock: &DriverLock<Driver>) {
    // SAFETY: a child handler runs on the child's only thread.
    let mut driver = unsafe { lock.reset_after_fork() };
    driver.reset_after_fork();
}

/// Registers `fork_child` once, at the first `eglInitialize`: before it no
/// state exists to reset. A failed registration leaves it unregistered, so
/// the next `eglInitialize` tries again.
fn register_fork_handler() {
    use core::sync::atomic::{AtomicU8, Ordering};
    const UNREGISTERED: u8 = 0;
    const REGISTERING: u8 = 1;
    const REGISTERED: u8 = 2;
    static STATE: AtomicU8 = AtomicU8::new(UNREGISTERED);
    // A thread that finds another thread registering returns at once
    // rather than wait; a failed registration is retried by the next call.
    if STATE.compare_exchange(UNREGISTERED, REGISTERING, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return;
    }
    #[cfg(not(test))]
    let registered = {
        type Handler = Option<extern "C" fn()>;
        unsafe extern "C" {
            fn pthread_atfork(prepare: Handler, parent: Handler, child: Handler) -> core::ffi::c_int;
        }
        let ok = unsafe { pthread_atfork(None, None, Some(fork_child)) } == 0;
        if !ok {
            // Only ENOMEM is possible; a fork child would then reuse the
            // parent's context ids, which the kernel refuses loudly.
            crate::diag(format_args!("eglInitialize: pthread_atfork failed; fork children inherit EGL state"));
        }
        ok
    };
    #[cfg(test)]
    let registered = {
        let _ = fork_child;
        true
    };
    STATE.store(if registered { REGISTERED } else { UNREGISTERED }, Ordering::Release);
}

/// Test hook: the fork child handler, over a test's own lock.
#[cfg(test)]
pub(crate) fn fork_child_reset_for_test(lock: &DriverLock<Driver>) {
    reset_in_fork_child(lock);
}

/// Runs `f` on the process's driver state, under the driver lock, with the
/// real device. The GL entry points reach it through `gles::Global`.
pub fn with_driver<R>(f: impl FnOnce(&mut Driver, &mut KgpuDevice) -> R) -> R {
    let mut driver = DRIVER.lock();
    f(&mut driver, &mut KgpuDevice)
}

type Handle = *mut c_void;

fn h(handle: usize) -> Handle {
    handle as Handle
}

/// The pairs of an `EGL_NONE`-terminated attribute list, without the
/// terminator. A NULL list is empty.
///
/// # Safety
/// `list` is NULL or points to such a list.
unsafe fn attrib_list<'a, T: Copy + PartialEq>(list: *const T, none: T) -> &'a [T] {
    if list.is_null() {
        return &[];
    }
    let mut len = 0;
    while unsafe { *list.add(len) } != none {
        len += 2;
    }
    unsafe { core::slice::from_raw_parts(list, len) }
}

/// # Safety
/// `configs` is NULL or points to `size` writable `EGLConfig`s.
unsafe fn config_out<'a>(configs: *mut Handle, size: EGLint) -> Option<&'a mut [usize]> {
    if configs.is_null() {
        return None;
    }
    // EGLConfig is a pointer; usize has its size and alignment.
    Some(unsafe { core::slice::from_raw_parts_mut(configs as *mut usize, size.max(0) as usize) })
}

#[unsafe(no_mangle)]
pub extern "C" fn eglGetError() -> EGLint {
    thread::get_error()
}

#[unsafe(no_mangle)]
pub extern "C" fn eglGetDisplay(display_id: Handle) -> Handle {
    h(with_driver(|d, _| d.get_display(display_id as usize)))
}

/// # Safety
/// `attrib_list` is NULL or an `EGL_NONE`-terminated list.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglGetPlatformDisplay(
    platform: EGLenum,
    native_display: *mut c_void,
    attrib_list: *const EGLAttrib,
) -> Handle {
    let attribs = unsafe { self::attrib_list(attrib_list, EGL_NONE as EGLAttrib) };
    h(with_driver(|d, _| d.get_platform_display(platform, native_display as usize, attribs)))
}

/// # Safety
/// `major` and `minor` are NULL or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglInitialize(dpy: Handle, major: *mut EGLint, minor: *mut EGLint) -> EGLBoolean {
    let (major, minor) = unsafe { (major.as_mut(), minor.as_mut()) };
    register_fork_handler();
    with_driver(|d, dev| d.initialize(dev, dpy as usize, major, minor))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglTerminate(dpy: Handle) -> EGLBoolean {
    with_driver(|d, dev| d.terminate(dev, dpy as usize))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglQueryString(dpy: Handle, name: EGLint) -> *const c_char {
    with_driver(|d, _| d.query_string(dpy as usize, name)).map_or(core::ptr::null(), CStr::as_ptr)
}

/// # Safety
/// `configs` is NULL or holds `config_size` entries; `num_config` is NULL
/// or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglGetConfigs(
    dpy: Handle,
    configs: *mut Handle,
    config_size: EGLint,
    num_config: *mut EGLint,
) -> EGLBoolean {
    let (configs, num) = unsafe { (config_out(configs, config_size), num_config.as_mut()) };
    with_driver(|d, _| d.get_configs(dpy as usize, configs, num))
}

/// # Safety
/// As `eglGetConfigs`, and `attrib_list` is NULL or `EGL_NONE`-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglChooseConfig(
    dpy: Handle,
    attrib_list: *const EGLint,
    configs: *mut Handle,
    config_size: EGLint,
    num_config: *mut EGLint,
) -> EGLBoolean {
    let attribs = unsafe { self::attrib_list(attrib_list, EGL_NONE) };
    let (configs, num) = unsafe { (config_out(configs, config_size), num_config.as_mut()) };
    with_driver(|d, _| d.choose_config(dpy as usize, attribs, configs, num))
}

/// # Safety
/// `value` is NULL or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglGetConfigAttrib(
    dpy: Handle,
    config: Handle,
    attribute: EGLint,
    value: *mut EGLint,
) -> EGLBoolean {
    let value = unsafe { value.as_mut() };
    with_driver(|d, _| d.get_config_attrib(dpy as usize, config as usize, attribute, value))
}

/// # Safety
/// `attrib_list` is NULL or `EGL_NONE`-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglCreatePbufferSurface(dpy: Handle, config: Handle, attrib_list: *const EGLint) -> Handle {
    let attribs = unsafe { self::attrib_list(attrib_list, EGL_NONE) };
    h(with_driver(|d, _| d.create_pbuffer_surface(dpy as usize, config as usize, attribs)))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglDestroySurface(dpy: Handle, surface: Handle) -> EGLBoolean {
    with_driver(|d, dev| d.destroy_surface(dev, dpy as usize, surface as usize))
}

/// # Safety
/// `value` is NULL or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglQuerySurface(dpy: Handle, surface: Handle, attribute: EGLint, value: *mut EGLint) -> EGLBoolean {
    let value = unsafe { value.as_mut() };
    with_driver(|d, _| d.query_surface(dpy as usize, surface as usize, attribute, value))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglBindAPI(api: EGLenum) -> EGLBoolean {
    thread::bind_api(api)
}

#[unsafe(no_mangle)]
pub extern "C" fn eglQueryAPI() -> EGLenum {
    thread::query_api()
}

/// # Safety
/// `attrib_list` is NULL or `EGL_NONE`-terminated.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglCreateContext(
    dpy: Handle,
    config: Handle,
    share_context: Handle,
    attrib_list: *const EGLint,
) -> Handle {
    let attribs = unsafe { self::attrib_list(attrib_list, EGL_NONE) };
    h(with_driver(|d, dev| d.create_context(dev, dpy as usize, config as usize, share_context as usize, attribs)))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglDestroyContext(dpy: Handle, ctx: Handle) -> EGLBoolean {
    with_driver(|d, dev| d.destroy_context(dev, dpy as usize, ctx as usize))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglMakeCurrent(dpy: Handle, draw: Handle, read: Handle, ctx: Handle) -> EGLBoolean {
    with_driver(|d, dev| d.make_current(dev, dpy as usize, draw as usize, read as usize, ctx as usize))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglGetCurrentContext() -> Handle {
    h(with_driver(|d, _| d.get_current_context()))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglGetCurrentSurface(readdraw: EGLint) -> Handle {
    h(with_driver(|d, _| d.get_current_surface(readdraw)))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglGetCurrentDisplay() -> Handle {
    h(with_driver(|d, _| d.get_current_display()))
}

/// # Safety
/// `value` is NULL or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglQueryContext(dpy: Handle, ctx: Handle, attribute: EGLint, value: *mut EGLint) -> EGLBoolean {
    let value = unsafe { value.as_mut() };
    with_driver(|d, _| d.query_context(dpy as usize, ctx as usize, attribute, value))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglSwapBuffers(dpy: Handle, surface: Handle) -> EGLBoolean {
    with_driver(|d, dev| d.swap_buffers(dev, dpy as usize, surface as usize))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglSwapInterval(dpy: Handle, interval: EGLint) -> EGLBoolean {
    with_driver(|d, _| d.swap_interval(dpy as usize, interval))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglWaitClient() -> EGLBoolean {
    with_driver(|d, dev| d.wait_client(dev))
}

#[unsafe(no_mangle)]
pub extern "C" fn eglReleaseThread() -> EGLBoolean {
    with_driver(|d, dev| d.release_thread(dev))
}

/// `void (*)(void)`, as `eglGetProcAddress` returns it.
pub type Proc = unsafe extern "C" fn();

macro_rules! procs {
    ($($name:ident),* $(,)?) => {
        /// Every function this library exports, by name.
        fn lookup(name: &[u8]) -> Option<Proc> {
            $(
                if name == stringify!($name).as_bytes() {
                    // SAFETY: a function pointer, returned as the generic
                    // pointer type the caller casts back (EGL 1.5 §3.11).
                    return Some(unsafe { core::mem::transmute::<*const (), Proc>($name as *const ()) });
                }
            )*
            None
        }
    };
}

procs! {
    eglGetError, eglGetDisplay, eglGetPlatformDisplay, eglInitialize, eglTerminate, eglQueryString,
    eglGetConfigs, eglChooseConfig, eglGetConfigAttrib, eglCreatePbufferSurface, eglDestroySurface,
    eglQuerySurface, eglBindAPI, eglQueryAPI, eglCreateContext, eglDestroyContext, eglMakeCurrent,
    eglGetCurrentContext, eglGetCurrentSurface, eglGetCurrentDisplay, eglQueryContext, eglSwapBuffers,
    eglSwapInterval, eglWaitClient, eglReleaseThread, eglGetProcAddress,
    glGetError, glGetString, glGetBooleanv, glGetIntegerv, glGetFloatv, glViewport, glClearColor,
    glClear, glReadPixels, glFlush, glFinish,
}

/// `eglGetProcAddress` over a name without its terminator: the address of
/// any EGL or GL function this library defines, and `None` otherwise.
pub fn get_proc_address(name: &[u8]) -> Option<Proc> {
    thread::set_error(EGL_SUCCESS);
    lookup(name)
}

/// # Safety
/// `procname` is NULL or a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eglGetProcAddress(procname: *const c_char) -> Option<Proc> {
    if procname.is_null() {
        thread::set_error(EGL_SUCCESS);
        return None;
    }
    get_proc_address(unsafe { CStr::from_ptr(procname) }.to_bytes())
}
