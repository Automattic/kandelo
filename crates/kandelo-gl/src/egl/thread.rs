//! Per-thread EGL state and the global driver lock.
//!
//! Ownership: EGL 1.5 §3.12 makes the error status, the bound client API and
//! the current context per thread, so they live in `#[thread_local]` cells
//! that only the owning thread touches, without the lock. Shared objects
//! (displays, contexts, surfaces) live in the one `Driver` behind
//! `DriverLock`, which every other entry point takes.
//!
//! The lock spins on an atomic flag. It is held only for the length of one
//! EGL or GL call's bookkeeping, and nothing here waits on the GPU while
//! holding it. It is not fork-safe: a fork while another thread is inside an
//! EGL call leaves the child's copy locked, as POSIX permits for a
//! multithreaded fork (the child may call only async-signal-safe functions).

use super::{EGL_OPENGL_ES_API, EGL_SUCCESS, EGLenum, EGLint};
use core::cell::{Cell, UnsafeCell};
use core::ops::{Deref, DerefMut};
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// The display the calling thread's current context belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayRef {
    pub(crate) epoch: u32,
}

/// The calling thread's current context, as `current()` reports it. It is
/// a plain copy: `Driver::context_mut` resolves it under the lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextRef {
    pub(crate) epoch: u32,
    pub(crate) handle: usize,
    pub(crate) kgpu: u32,
}

impl ContextRef {
    /// The kgpu context the EGL context owns.
    pub fn kgpu_context(&self) -> u32 {
        self.kgpu
    }

    /// The `EGLContext` handle.
    pub fn handle(&self) -> usize {
        self.handle
    }
}

/// A thread's current context and its draw (= read) surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Current {
    pub epoch: u32,
    pub context: usize,
    pub kgpu: u32,
    /// `EGL_NO_SURFACE` (0) when the context is current without one.
    pub surface: usize,
}

struct ThreadState {
    /// 0 until the thread first needs an id.
    id: Cell<u32>,
    error: Cell<EGLint>,
    api: Cell<EGLenum>,
    current: Cell<Option<Current>>,
}

/// The API a thread starts with (EGL 1.5 §3.7: OpenGL ES when supported).
const INITIAL_API: EGLenum = EGL_OPENGL_ES_API as EGLenum;

#[thread_local]
static THREAD: ThreadState = ThreadState {
    id: Cell::new(0),
    error: Cell::new(EGL_SUCCESS),
    api: Cell::new(INITIAL_API),
    current: Cell::new(None),
};

static NEXT_THREAD: AtomicU32 = AtomicU32::new(1);
static NEXT_EPOCH: AtomicU32 = AtomicU32::new(1);

/// The calling thread's id: nonzero and never reused within the process,
/// so a context or surface current to a thread that has exited stays
/// unavailable to every other thread, as EGL requires until it is released.
pub(crate) fn id() -> u32 {
    let id = THREAD.id.get();
    if id != 0 {
        return id;
    }
    let id = NEXT_THREAD.fetch_add(1, Ordering::Relaxed);
    THREAD.id.set(id);
    id
}

/// A driver-state epoch no earlier state used.
pub(crate) fn fresh_epoch() -> u32 {
    NEXT_EPOCH.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn get_current() -> Option<Current> {
    THREAD.current.get()
}

pub(crate) fn set_current(current: Option<Current>) {
    THREAD.current.set(current);
}

/// The calling thread's current display and context, for the GL entry
/// points. It reads only this thread's state and takes no lock.
pub fn current() -> Option<(DisplayRef, ContextRef)> {
    THREAD.current.get().map(|c| {
        (DisplayRef { epoch: c.epoch }, ContextRef { epoch: c.epoch, handle: c.context, kgpu: c.kgpu })
    })
}

/// Records `error` as the calling thread's last EGL status.
pub(crate) fn set_error(error: EGLint) {
    THREAD.error.set(error);
}

/// `eglGetError`: the last status, and `EGL_SUCCESS` from now on, since
/// this call itself succeeded (EGL 1.5 §3.1).
pub fn get_error() -> EGLint {
    THREAD.error.replace(EGL_SUCCESS)
}

pub(crate) fn api() -> EGLenum {
    THREAD.api.get()
}

/// Resets the bound API to its initial value (`eglReleaseThread`).
pub(crate) fn reset_api() {
    THREAD.api.set(INITIAL_API);
}

/// Reports an EGL call's outcome: sets the thread's error and returns the
/// call's value, or `failure` if it failed.
pub(crate) fn report<T>(result: super::Result<T>, failure: T) -> T {
    match result {
        Ok(value) => {
            set_error(EGL_SUCCESS);
            value
        }
        Err(error) => {
            set_error(error);
            failure
        }
    }
}

/// `eglBindAPI`. Only OpenGL ES is supported; any other value, including
/// `EGL_OPENGL_API` and `EGL_OPENVG_API`, is `EGL_BAD_PARAMETER`.
pub fn bind_api(api: EGLenum) -> super::EGLBoolean {
    let result = if api == INITIAL_API {
        THREAD.api.set(api);
        Ok(super::EGL_TRUE as super::EGLBoolean)
    } else {
        Err(super::EGL_BAD_PARAMETER)
    };
    report(result, super::EGL_FALSE as super::EGLBoolean)
}

/// `eglQueryAPI`.
pub fn query_api() -> EGLenum {
    set_error(EGL_SUCCESS);
    api()
}

/// A mutual-exclusion lock over the driver state, `spin::Mutex`-style on
/// `core::sync::atomic`, since the library has no OS mutex of its own.
pub struct DriverLock<T> {
    held: AtomicBool,
    value: UnsafeCell<T>,
}

// SAFETY: the flag admits one guard at a time, so `T` is reached from one
// thread at a time.
unsafe impl<T: Send> Sync for DriverLock<T> {}

impl<T> DriverLock<T> {
    pub const fn new(value: T) -> Self {
        Self { held: AtomicBool::new(false), value: UnsafeCell::new(value) }
    }

    pub fn lock(&self) -> DriverGuard<'_, T> {
        while self.held.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            while self.held.load(Ordering::Relaxed) {
                core::hint::spin_loop();
            }
        }
        DriverGuard { lock: self }
    }
}

pub struct DriverGuard<'a, T> {
    lock: &'a DriverLock<T>,
}

impl<T> Deref for DriverGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY: this guard holds the lock.
        unsafe { &*self.lock.value.get() }
    }
}

impl<T> DerefMut for DriverGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        // SAFETY: this guard holds the lock.
        unsafe { &mut *self.lock.value.get() }
    }
}

impl<T> Drop for DriverGuard<'_, T> {
    fn drop(&mut self) {
        self.lock.held.store(false, Ordering::Release);
    }
}
