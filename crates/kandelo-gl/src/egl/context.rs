//! OpenGL ES 2.0 contexts and binding (EGL 1.5 §3.7, §3.10, §3.12).
//!
//! Ownership: each EGL context owns one kgpu context, created by
//! `eglCreateContext` and destroyed once the EGL context is destroyed and no
//! longer current. The context's command stream is queued in process and
//! submitted, without waiting, when the context is flushed: when
//! `eglMakeCurrent` releases it, on `eglSwapBuffers` and `eglWaitClient`,
//! and when a surface's storage is released while the context is not
//! current. The stream is the context's `gles::CommandBuffer`, and its GL
//! state is `gles::State`.

use super::surface::Storage;
use super::*;
use crate::gles::{self, CommandBuffer};
use crate::kgpu::Device;
use alloc::vec::Vec;
use kgpu_stream::Command;

/// The most surfaces one kgpu context may hold; the executor's
/// `MAX_SURFACES_PER_CONTEXT` (`crates/gpu-executor/src/lib.rs`), which
/// faults a context that creates more. A test pins the two together.
pub const MAX_SURFACES_PER_CONTEXT: usize = 64;

const EIO: i32 = 5;
const ENODEV: i32 = 19;
const ENOMEM: i32 = 12;
const ENOSPC: i32 = 28;

pub struct Context {
    pub(crate) handle: usize,
    pub(crate) kgpu: u32,
    /// The config ID, or `None` for `EGL_NO_CONFIG_KHR`.
    pub(crate) config_id: Option<EGLint>,
    /// Lost: every later submission is refused, and binding it fails with
    /// `EGL_CONTEXT_LOST`.
    pub(crate) lost: bool,
    /// Marked by `eglDestroyContext` or `eglTerminate`.
    pub(crate) deleted: bool,
    /// The thread it is current to, by `thread::id`.
    pub(crate) thread: Option<u32>,
    /// Its draw and read surface while current (`EGL_NO_SURFACE` = 0).
    pub(crate) surface: usize,
    /// Made current at least once (EGL 1.5 §3.7.3's "first time").
    pub(crate) made_current: bool,
    /// The surface name the executor has bound in this context.
    bound_name: u32,
    /// Surfaces whose storage this context holds.
    storage_count: usize,
    /// The records queued for the next submission.
    pub(crate) cmds: CommandBuffer,
    /// The OpenGL ES state, errors included.
    pub(crate) gl: gles::State,
}

impl Context {
    pub fn kgpu_context(&self) -> u32 {
        self.kgpu
    }

    /// Its draw (= read) surface handle while current, or 0.
    pub fn surface(&self) -> usize {
        self.surface
    }

    pub fn is_lost(&self) -> bool {
        self.lost
    }

    /// The context's OpenGL ES state.
    pub fn gl(&self) -> &gles::State {
        &self.gl
    }

    /// Queues `command`. A lost context queues nothing, and a failed
    /// submission on the way (a full stream) loses the context.
    pub(crate) fn push(&mut self, dev: &mut impl Device, call: &str, command: Command) {
        if self.lost {
            return;
        }
        if let Err(errno) = self.cmds.record(dev, command) {
            self.fail(call, "submit", errno);
        }
    }

    /// Queues what brings the executor's viewport and clear color to the GL
    /// state, if a surface is bound.
    pub(crate) fn sync_gl(&mut self, dev: &mut impl Device, call: &str) {
        for command in self.gl.sync().into_iter().flatten() {
            self.push(dev, call, command);
        }
    }

    /// Reports a kgpu failure once and marks the context lost. `-EIO` is the
    /// renderer's loss; anything else is a driver defect, never swallowed.
    pub(crate) fn fail(&mut self, call: &str, op: &str, errno: i32) {
        if !self.lost {
            report_kgpu_failure(call, op, errno);
        }
        self.lost = true;
    }

    /// Submits the queued commands without waiting and returns the
    /// submission's sequence number, `None` if nothing was queued. `Err`
    /// means the context is lost (now or before); its queue is discarded.
    pub fn flush(&mut self, dev: &mut impl Device, call: &str) -> core::result::Result<Option<u64>, ()> {
        if self.lost {
            self.cmds.discard();
            return Err(());
        }
        self.cmds.flush(dev).map_err(|errno| self.fail(call, "submit", errno))
    }

    fn bind_name(&mut self, dev: &mut impl Device, call: &str, name: u32) {
        if self.bound_name != name {
            self.push(dev, call, Command::SurfaceBind { surface: name });
            self.bound_name = name;
        }
    }
}

/// Writes the one diagnostic line for a kgpu error on a context: `-EIO` is
/// the renderer's loss; anything else names the operation and the errno.
pub(crate) fn report_kgpu_failure(call: &str, op: &str, errno: i32) {
    if errno == -EIO {
        crate::diag(format_args!("{call}: GPU context lost"));
    } else {
        crate::diag(format_args!("{call}: kgpu {op} failed: {}", crate::Errno(errno)));
    }
}

/// The `eglCreateContext` attributes, validated for an OpenGL ES context.
fn parse_context_attribs(list: &[EGLint]) -> Result<()> {
    let (mut major, mut minor) = (1, 0);
    let mut robust = EGL_FALSE;
    for pair in attrib_pairs(list) {
        let (attribute, value) = pair?;
        match attribute {
            EGL_CONTEXT_MAJOR_VERSION => major = value,
            EGL_CONTEXT_MINOR_VERSION => minor = value,
            EGL_CONTEXT_OPENGL_DEBUG => {
                // §3.7.1.3: no extra debug functionality; not a failure.
                if value != EGL_TRUE && value != EGL_FALSE {
                    return Err(EGL_BAD_ATTRIBUTE);
                }
            }
            EGL_CONTEXT_OPENGL_ROBUST_ACCESS => {
                if value != EGL_TRUE && value != EGL_FALSE {
                    return Err(EGL_BAD_ATTRIBUTE);
                }
                robust = value;
            }
            EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY => {
                // §3.7.1.6: without robust access, creation does not fail.
                if value != EGL_NO_RESET_NOTIFICATION && value != EGL_LOSE_CONTEXT_ON_RESET {
                    return Err(EGL_BAD_ATTRIBUTE);
                }
            }
            // OpenGL-only attributes (§3.7.1.2, §3.7.1.4), and anything
            // else, are not supported for an OpenGL ES context.
            _ => return Err(EGL_BAD_ATTRIBUTE),
        }
    }
    // §3.7.1.5: robust buffer access needs GL_EXT_robustness, which the
    // skeleton does not implement.
    if robust == EGL_TRUE {
        return Err(EGL_BAD_MATCH);
    }
    // ES 1.x is unsupported (and the default, 1.0), ES 3.x needs a config
    // with EGL_OPENGL_ES3_BIT, and 2.0 is the only defined 2.x version.
    if (major, minor) != (2, 0) {
        return Err(EGL_BAD_MATCH);
    }
    Ok(())
}

impl Driver {
    /// The live context `handle` names (`EGL_BAD_CONTEXT` otherwise).
    pub(crate) fn live_context(&self, handle: usize) -> Result<&Context> {
        self.contexts.get(&handle).filter(|c| !c.deleted).ok_or(EGL_BAD_CONTEXT)
    }

    /// `eglCreateContext`. Its one kgpu call creates the context's kgpu
    /// context.
    pub fn create_context(
        &mut self,
        dev: &mut impl Device,
        dpy: usize,
        config: usize,
        share: usize,
        attribs: &[EGLint],
    ) -> usize {
        let result = self.initialized_display(dpy).and_then(|()| {
            if thread::api() != EGL_OPENGL_ES_API as EGLenum {
                return Err(EGL_BAD_MATCH);
            }
            // EGL_KHR_no_config_context: EGL_NO_CONFIG_KHR is a context
            // compatible with every surface.
            let config = match config {
                NO_HANDLE => None,
                handle => Some(config::by_handle(handle).ok_or(EGL_BAD_CONFIG)?),
            };
            if share != NO_HANDLE {
                self.live_context(share)?;
                // Plan scope S5: share groups arrive in slice 3.
                return Err(EGL_BAD_MATCH);
            }
            parse_context_attribs(attribs)?;
            if let Some(config) = config
                && config.get(EGL_RENDERABLE_TYPE).unwrap_or(0) & EGL_OPENGL_ES2_BIT == 0
            {
                return Err(EGL_BAD_MATCH);
            }
            let handle = next_handle(&mut self.next_context, TAG_CONTEXT)?;
            let kgpu = dev.context_create().map_err(|errno| {
                // Every kgpu error is reported (plan ruling S8); the EGL
                // error says what the program can do about it.
                report_kgpu_failure("eglCreateContext", "context create", errno);
                match -errno {
                    // The kernel's context limit or memory: out of resources.
                    ENOSPC | ENOMEM => EGL_BAD_ALLOC,
                    // The renderer went away after initialization (a device
                    // reset): a power-management-like event (EGL 1.5 §2.7).
                    EIO | ENODEV => EGL_CONTEXT_LOST,
                    _ => EGL_BAD_ALLOC,
                }
            })?;
            self.contexts.insert(handle, Context {
                handle,
                kgpu,
                config_id: config.map(|c| c.id()),
                lost: false,
                deleted: false,
                thread: None,
                surface: NO_HANDLE,
                made_current: false,
                bound_name: 0,
                storage_count: 0,
                cmds: CommandBuffer::new(kgpu),
                gl: gles::State::new(),
            });
            Ok(handle)
        });
        thread::report(result, NO_HANDLE)
    }

    /// `eglDestroyContext`. A context current to some thread is only marked;
    /// its kgpu context is destroyed once it is released (§3.7.2).
    pub fn destroy_context(&mut self, dev: &mut impl Device, dpy: usize, context: usize) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            self.live_context(context)?;
            self.contexts.get_mut(&context).expect("live").deleted = true;
            self.reap(dev, "eglDestroyContext");
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglQueryContext`. It makes no kgpu call.
    pub fn query_context(&mut self, dpy: usize, context: usize, attribute: EGLint, value: Option<&mut EGLint>) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            let c = self.live_context(context)?;
            let v = match attribute {
                // EGL_KHR_no_config_context: such a context reports 0.
                EGL_CONFIG_ID => c.config_id.unwrap_or(0),
                EGL_CONTEXT_CLIENT_TYPE => EGL_OPENGL_ES_API,
                EGL_CONTEXT_CLIENT_VERSION => 2,
                // §3.7.4: EGL_BACK_BUFFER bound to a pbuffer, else EGL_NONE.
                EGL_RENDER_BUFFER if c.thread.is_some() && c.surface != NO_HANDLE => EGL_BACK_BUFFER,
                EGL_RENDER_BUFFER => EGL_NONE,
                _ => return Err(EGL_BAD_ATTRIBUTE),
            };
            *value.ok_or(EGL_BAD_PARAMETER)? = v;
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglMakeCurrent`.
    pub fn make_current(&mut self, dev: &mut impl Device, dpy: usize, draw: usize, read: usize, context: usize) -> EGLBoolean {
        let result = self.make_current_inner(dev, dpy, draw, read, context);
        thread::report(result.map(|()| EGL_TRUE as EGLBoolean), EGL_FALSE as EGLBoolean)
    }

    fn make_current_inner(&mut self, dev: &mut impl Device, dpy: usize, draw: usize, read: usize, context: usize) -> Result<()> {
        if dpy != DISPLAY {
            return Err(EGL_BAD_DISPLAY);
        }
        if context == NO_HANDLE {
            // §3.7.3: releasing is the one call an uninitialized display
            // accepts.
            if draw != NO_HANDLE || read != NO_HANDLE {
                return Err(EGL_BAD_MATCH);
            }
            self.release_current(dev, "eglMakeCurrent");
            return Ok(());
        }
        if !self.initialized {
            return Err(EGL_NOT_INITIALIZED);
        }
        let me = thread::id();
        let c = self.live_context(context)?;
        for s in [draw, read] {
            if s != NO_HANDLE {
                self.live_surface(s)?;
            }
        }
        if (draw == NO_HANDLE) != (read == NO_HANDLE) {
            return Err(EGL_BAD_MATCH);
        }
        // Skeleton limit: one surface for both drawing and reading.
        if draw != read {
            return Err(EGL_BAD_MATCH);
        }
        if c.thread.is_some_and(|t| t != me) {
            return Err(EGL_BAD_ACCESS);
        }
        if c.lost {
            return Err(EGL_CONTEXT_LOST);
        }
        let config_id = c.config_id;
        let previous = self.current();
        if previous.is_some_and(|p| p.context == context && p.surface == draw) {
            return Ok(());
        }
        let mut create = None;
        if draw != NO_HANDLE {
            let s = self.live_surface(draw)?;
            if s.thread.is_some_and(|t| t != me) {
                return Err(EGL_BAD_ACCESS);
            }
            if config_id.is_some_and(|id| id != s.config_id) {
                return Err(EGL_BAD_MATCH);
            }
            match s.storage {
                Storage::In(owner) if owner == context => {}
                Storage::In(_) => {
                    crate::diag(format_args!(
                        "eglMakeCurrent: surface {draw:#x} is bound to another context's GPU storage; \
                         sharing a surface between contexts is not implemented yet"
                    ));
                    return Err(EGL_BAD_MATCH);
                }
                Storage::Lost => {
                    crate::diag(format_args!(
                        "eglMakeCurrent: surface {draw:#x} lost its GPU storage with its destroyed context; \
                         moving a surface to another context is not implemented yet"
                    ));
                    return Err(EGL_BAD_MATCH);
                }
                Storage::None => {
                    if self.contexts[&context].storage_count >= MAX_SURFACES_PER_CONTEXT {
                        return Err(EGL_BAD_ALLOC);
                    }
                    create = Some((s.name(), s.storage_size()));
                }
            }
        }

        // Every check passed; from here the call succeeds.
        if let Some(p) = previous {
            if p.context == context {
                // Same context, another surface: the old one is released.
                self.unbind_surface(p.surface);
            } else {
                self.release_current(dev, "eglMakeCurrent");
            }
        }
        let size = (draw != NO_HANDLE).then(|| {
            let s = &self.surfaces[&draw];
            (s.width, s.height)
        });
        let name = if draw == NO_HANDLE { 0 } else { self.surfaces[&draw].name() };
        let c = self.contexts.get_mut(&context).expect("live");
        if let Some((name, (width, height))) = create {
            c.push(dev, "eglMakeCurrent", Command::SurfaceCreate { surface: name, width, height });
            c.storage_count += 1;
        }
        c.bind_name(dev, "eglMakeCurrent", name);
        c.thread = Some(me);
        c.surface = draw;
        if !c.made_current {
            // §3.7.3: the first time, the viewport becomes the draw
            // surface's size, or 0x0 surfaceless.
            c.made_current = true;
            let (width, height) = size.unwrap_or((0, 0));
            c.gl.first_bind(width, height);
        }
        // The executor starts every context at viewport 0,0,0,0 (plan
        // ruling S6), so binding a surface encodes the GL viewport even
        // when it is the GL default.
        c.gl.bind_surface(size);
        c.sync_gl(dev, "eglMakeCurrent");
        let kgpu = c.kgpu;
        if draw != NO_HANDLE {
            let s = self.surfaces.get_mut(&draw).expect("live");
            s.thread = Some(me);
            s.storage = Storage::In(context);
        }
        thread::set_current(Some(thread::Current { epoch: self.epoch, context, kgpu, surface: draw }));
        self.reap(dev, "eglMakeCurrent");
        Ok(())
    }

    /// Marks `surface` (if any) no longer current.
    fn unbind_surface(&mut self, surface: usize) {
        if let Some(s) = self.surfaces.get_mut(&surface) {
            s.thread = None;
        }
    }

    /// Releases the calling thread's current context, if any: it is flushed
    /// and marked no longer current, and anything marked for deletion that
    /// is now unused is destroyed (§3.7.3, §3.2).
    pub(crate) fn release_current(&mut self, dev: &mut impl Device, call: &str) {
        let Some(p) = self.current() else {
            thread::set_current(None);
            return;
        };
        thread::set_current(None);
        self.unbind_surface(p.surface);
        if let Some(c) = self.contexts.get_mut(&p.context) {
            c.thread = None;
            c.surface = NO_HANDLE;
        }
        self.reap(dev, call);
        if let Some(c) = self.contexts.get_mut(&p.context) {
            // A lost context's flush fails; releasing it still succeeds, so
            // the program can clean up.
            let _ = c.flush(dev, call);
        }
    }

    /// Destroys every object marked for deletion that no thread has
    /// current: a surface's storage is released into its context's stream
    /// (then the context is flushed if no thread has it current), and a
    /// context's kgpu context is destroyed with every surface it holds.
    pub(crate) fn reap(&mut self, dev: &mut impl Device, call: &str) {
        let dead_surfaces: Vec<usize> =
            self.surfaces.values().filter(|s| s.deleted && s.thread.is_none()).map(|s| s.handle).collect();
        for handle in dead_surfaces {
            let s = self.surfaces.remove(&handle).expect("listed");
            if let Storage::In(owner) = s.storage
                && let Some(c) = self.contexts.get_mut(&owner)
            {
                c.storage_count -= 1;
                if !(c.deleted && c.thread.is_none()) {
                    c.push(dev, call, Command::SurfaceDestroy { surface: s.name() });
                    // Destroying the bound surface leaves none bound.
                    if c.bound_name == s.name() {
                        c.bound_name = 0;
                    }
                    if c.thread.is_none() {
                        let _ = c.flush(dev, call);
                    }
                }
            }
        }
        let dead_contexts: Vec<usize> =
            self.contexts.values().filter(|c| c.deleted && c.thread.is_none()).map(|c| c.handle).collect();
        for handle in dead_contexts {
            let c = self.contexts.remove(&handle).expect("listed");
            for s in self.surfaces.values_mut() {
                if s.storage == Storage::In(handle) {
                    s.storage = Storage::Lost;
                }
            }
            // A lost context is already gone from the executor; the kernel
            // still holds its id until destroyed.
            if let Err(errno) = dev.context_destroy(c.kgpu) {
                crate::diag(format_args!("{call}: kgpu context destroy failed: {}", crate::Errno(errno)));
            }
        }
    }

    /// `eglGetCurrentContext`.
    pub fn get_current_context(&mut self) -> usize {
        thread::set_error(EGL_SUCCESS);
        self.current().map_or(NO_HANDLE, |c| c.context)
    }

    /// `eglGetCurrentSurface`.
    pub fn get_current_surface(&mut self, readdraw: EGLint) -> usize {
        let result = match readdraw {
            EGL_READ | EGL_DRAW => Ok(self.current().map_or(NO_HANDLE, |c| c.surface)),
            _ => Err(EGL_BAD_PARAMETER),
        };
        thread::report(result, NO_HANDLE)
    }

    /// `eglGetCurrentDisplay`.
    pub fn get_current_display(&mut self) -> usize {
        thread::set_error(EGL_SUCCESS);
        self.current().map_or(NO_HANDLE, |_| DISPLAY)
    }

    /// `eglSwapBuffers`. A pbuffer swap has no effect (§3.10.1) beyond the
    /// implicit flush (§3.10.3): queued work is submitted, never waited for.
    pub fn swap_buffers(&mut self, dev: &mut impl Device, dpy: usize, surface: usize) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            self.live_surface(surface)?;
            let current = self.current().filter(|c| c.surface == surface).ok_or(EGL_BAD_SURFACE)?;
            let c = self.contexts.get_mut(&current.context).expect("current");
            c.flush(dev, "eglSwapBuffers").map_err(|()| EGL_CONTEXT_LOST)?;
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglSwapInterval`: stored on the draw surface, clamped to the
    /// config's `EGL_MIN_SWAP_INTERVAL`..=`EGL_MAX_SWAP_INTERVAL` (0..=1).
    pub fn swap_interval(&mut self, dpy: usize, interval: EGLint) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            let current = self.current().ok_or(EGL_BAD_CONTEXT)?;
            let s = self.surfaces.get_mut(&current.surface).ok_or(EGL_BAD_SURFACE)?;
            s.swap_interval = interval.clamp(0, 1);
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglWaitClient`. There is no native rendering on the surfaceless
    /// platform to order against, so a flush meets §3.8: later kgpu work
    /// runs after it. It does not wait.
    pub fn wait_client(&mut self, dev: &mut impl Device) -> EGLBoolean {
        let result = match self.current() {
            None => Ok(EGL_TRUE as EGLBoolean),
            Some(current) => {
                if self.surfaces.get(&current.surface).is_some_and(|s| s.deleted) {
                    Err(EGL_BAD_CURRENT_SURFACE)
                } else {
                    let c = self.contexts.get_mut(&current.context).expect("current");
                    c.flush(dev, "eglWaitClient").map(|_| EGL_TRUE as EGLBoolean).map_err(|()| EGL_CONTEXT_LOST)
                }
            }
        };
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglReleaseThread` (§3.12): releases the current context and resets
    /// the bound API. It cannot fail.
    pub fn release_thread(&mut self, dev: &mut impl Device) -> EGLBoolean {
        self.release_current(dev, "eglReleaseThread");
        thread::reset_api();
        thread::set_error(EGL_SUCCESS);
        EGL_TRUE as EGLBoolean
    }
}
