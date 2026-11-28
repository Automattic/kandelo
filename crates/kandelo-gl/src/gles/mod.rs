//! The OpenGL ES 2.0 model: per-context GL state, its command stream, and
//! the GLES2 entry points this skeleton defines.
//!
//! Ownership: GL state and errors live in the EGL context that is current
//! to the calling thread (`egl::Context::gl`), so they are per context
//! (GLES 2.0.25 §2.5), and the command buffer beside it (`cmdbuf`) holds
//! the records not yet submitted. Every function here reads the calling
//! thread's current context without the lock (`egl::current`), then works
//! on it under the driver lock through `Gpu`. With no current context, or
//! a lost one, a call does nothing and returns zero, NULL or
//! `GL_NO_ERROR` (plan review focus 1 and 5).
//!
//! Only `glReadPixels` and `glFinish` wait, and never under the lock (plan
//! ruling S7): they encode and submit under it, release it, wait through
//! `Gpu::wait`, and take it again to apply the result. Every other call
//! makes no kgpu trip, except a flush: `glFlush`, or a record that would
//! overfill the stream.
//!
//! A valid GLES 2.0 enum the skeleton does not model yet ends the process
//! with `kandelo-gl: <function> <enum> not implemented` (`sys`); it never
//! answers a made-up value.

pub mod cmdbuf;
mod entry;
pub mod state;
#[cfg(test)]
mod tests;

pub use cmdbuf::CommandBuffer;
pub use entry::*;
pub use state::State;

use crate::egl::{self, Context, Driver};
use crate::kgpu::{Buffer, Device, KGPU_ACCESS_WRITE, KgpuDevice};
use alloc::vec::Vec;
use core::ffi::CStr;
use kgpu_stream::Command;

pub type GLenum = u32;
pub type GLbitfield = u32;
pub type GLint = i32;
pub type GLsizei = i32;
pub type GLfloat = f32;
pub type GLboolean = u8;
pub type GLubyte = u8;

pub const GL_TRUE: GLboolean = 1;
pub const GL_FALSE: GLboolean = 0;

macro_rules! gl_tokens {
    ($($name:ident = $value:expr;)*) => {
        $(pub const $name: GLenum = $value;)*
        /// Every token above with its value, checked against
        /// `libc/musl-overlay/include/GLES2/gl2.h` by the tests.
        #[cfg(test)]
        pub(crate) const HEADER_TOKENS: &[(&str, GLenum)] = &[$((stringify!($name), $value)),*];
    };
}

gl_tokens! {
    GL_NO_ERROR = 0;
    GL_INVALID_ENUM = 0x0500;
    GL_INVALID_VALUE = 0x0501;
    GL_INVALID_OPERATION = 0x0502;
    GL_OUT_OF_MEMORY = 0x0505;
    GL_INVALID_FRAMEBUFFER_OPERATION = 0x0506;
    GL_VENDOR = 0x1F00;
    GL_RENDERER = 0x1F01;
    GL_VERSION = 0x1F02;
    GL_EXTENSIONS = 0x1F03;
    GL_SHADING_LANGUAGE_VERSION = 0x8B8C;
    GL_COLOR_BUFFER_BIT = 0x00004000;
    GL_DEPTH_BUFFER_BIT = 0x00000100;
    GL_STENCIL_BUFFER_BIT = 0x00000400;
    GL_ALPHA = 0x1906;
    GL_RGB = 0x1907;
    GL_RGBA = 0x1908;
    GL_LUMINANCE = 0x1909;
    GL_LUMINANCE_ALPHA = 0x190A;
    GL_UNSIGNED_BYTE = 0x1401;
    GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
    GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
    GL_UNSIGNED_SHORT_5_6_5 = 0x8363;
    GL_VIEWPORT = 0x0BA2;
    GL_COLOR_CLEAR_VALUE = 0x0C22;
    GL_MAX_VIEWPORT_DIMS = 0x0D3A;
    GL_RED_BITS = 0x0D52;
    GL_GREEN_BITS = 0x0D53;
    GL_BLUE_BITS = 0x0D54;
    GL_ALPHA_BITS = 0x0D55;
    GL_DEPTH_BITS = 0x0D56;
    GL_STENCIL_BITS = 0x0D57;
    GL_IMPLEMENTATION_COLOR_READ_FORMAT = 0x8B9B;
    GL_IMPLEMENTATION_COLOR_READ_TYPE = 0x8B9A;
    GL_ARRAY_BUFFER_BINDING = 0x8894;
    GL_ELEMENT_ARRAY_BUFFER_BINDING = 0x8895;
    GL_DEPTH_RANGE = 0x0B70;
    GL_LINE_WIDTH = 0x0B21;
    GL_CULL_FACE = 0x0B44;
    GL_CULL_FACE_MODE = 0x0B45;
    GL_FRONT_FACE = 0x0B46;
    GL_POLYGON_OFFSET_FACTOR = 0x8038;
    GL_POLYGON_OFFSET_UNITS = 0x2A00;
    GL_POLYGON_OFFSET_FILL = 0x8037;
    GL_SAMPLE_ALPHA_TO_COVERAGE = 0x809E;
    GL_SAMPLE_COVERAGE = 0x80A0;
    GL_SAMPLE_COVERAGE_VALUE = 0x80AA;
    GL_SAMPLE_COVERAGE_INVERT = 0x80AB;
    GL_TEXTURE_BINDING_2D = 0x8069;
    GL_TEXTURE_BINDING_CUBE_MAP = 0x8514;
    GL_ACTIVE_TEXTURE = 0x84E0;
    GL_SCISSOR_TEST = 0x0C11;
    GL_SCISSOR_BOX = 0x0C10;
    GL_STENCIL_TEST = 0x0B90;
    GL_STENCIL_FUNC = 0x0B92;
    GL_STENCIL_VALUE_MASK = 0x0B93;
    GL_STENCIL_REF = 0x0B97;
    GL_STENCIL_FAIL = 0x0B94;
    GL_STENCIL_PASS_DEPTH_FAIL = 0x0B95;
    GL_STENCIL_PASS_DEPTH_PASS = 0x0B96;
    GL_STENCIL_BACK_FUNC = 0x8800;
    GL_STENCIL_BACK_VALUE_MASK = 0x8CA4;
    GL_STENCIL_BACK_REF = 0x8CA3;
    GL_STENCIL_BACK_FAIL = 0x8801;
    GL_STENCIL_BACK_PASS_DEPTH_FAIL = 0x8802;
    GL_STENCIL_BACK_PASS_DEPTH_PASS = 0x8803;
    GL_DEPTH_TEST = 0x0B71;
    GL_DEPTH_FUNC = 0x0B74;
    GL_BLEND = 0x0BE2;
    GL_BLEND_SRC_RGB = 0x80C9;
    GL_BLEND_SRC_ALPHA = 0x80CB;
    GL_BLEND_DST_RGB = 0x80C8;
    GL_BLEND_DST_ALPHA = 0x80CA;
    GL_BLEND_EQUATION_RGB = 0x8009;
    GL_BLEND_EQUATION_ALPHA = 0x883D;
    GL_BLEND_COLOR = 0x8005;
    GL_DITHER = 0x0BD0;
    GL_COLOR_WRITEMASK = 0x0C23;
    GL_DEPTH_WRITEMASK = 0x0B72;
    GL_STENCIL_WRITEMASK = 0x0B98;
    GL_STENCIL_BACK_WRITEMASK = 0x8CA5;
    GL_DEPTH_CLEAR_VALUE = 0x0B73;
    GL_STENCIL_CLEAR_VALUE = 0x0B91;
    GL_UNPACK_ALIGNMENT = 0x0CF5;
    GL_PACK_ALIGNMENT = 0x0D05;
    GL_CURRENT_PROGRAM = 0x8B8D;
    GL_GENERATE_MIPMAP_HINT = 0x8192;
    GL_SUBPIXEL_BITS = 0x0D50;
    GL_MAX_TEXTURE_SIZE = 0x0D33;
    GL_MAX_CUBE_MAP_TEXTURE_SIZE = 0x851C;
    GL_ALIASED_POINT_SIZE_RANGE = 0x846D;
    GL_ALIASED_LINE_WIDTH_RANGE = 0x846E;
    GL_SAMPLE_BUFFERS = 0x80A8;
    GL_SAMPLES = 0x80A9;
    GL_COMPRESSED_TEXTURE_FORMATS = 0x86A3;
    GL_NUM_COMPRESSED_TEXTURE_FORMATS = 0x86A2;
    GL_SHADER_BINARY_FORMATS = 0x8DF8;
    GL_NUM_SHADER_BINARY_FORMATS = 0x8DF9;
    GL_SHADER_COMPILER = 0x8DFA;
    GL_MAX_VERTEX_ATTRIBS = 0x8869;
    GL_MAX_VERTEX_UNIFORM_VECTORS = 0x8DFB;
    GL_MAX_VARYING_VECTORS = 0x8DFC;
    GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8B4D;
    GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8B4C;
    GL_MAX_TEXTURE_IMAGE_UNITS = 0x8872;
    GL_MAX_FRAGMENT_UNIFORM_VECTORS = 0x8DFD;
    GL_MAX_RENDERBUFFER_SIZE = 0x84E8;
    GL_RENDERBUFFER_BINDING = 0x8CA7;
    GL_FRAMEBUFFER_BINDING = 0x8CA6;
}

pub const VENDOR: &CStr = c"Kandelo";
pub const RENDERER: &CStr = c"kandelo-gl (WebGL 2)";
/// §6.1.5: `OpenGL ES N.M <vendor-specific information>`.
pub const VERSION: &CStr = c"OpenGL ES 2.0 kandelo-gl";
/// §6.1.5: `OpenGL ES GLSL ES N.M <vendor-specific information>`.
pub const SHADING_LANGUAGE_VERSION: &CStr = c"OpenGL ES GLSL ES 1.00";
pub const EXTENSIONS: &CStr = c"";

const CLEAR_BITS: GLbitfield = GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT;

/// The driver state and the device, as the GL functions reach them: under
/// the driver lock, and a wait with the lock released.
pub trait Gpu {
    type Dev: Device;
    /// Runs `f` on the driver state under the driver lock.
    fn locked<R>(&mut self, f: impl FnOnce(&mut Driver, &mut Self::Dev) -> R) -> R;
    /// Waits, without the driver lock, until `seqno` on kgpu context
    /// `kgpu` retires. It waits forever: only a loss or a defect ends it
    /// early.
    fn wait(&mut self, kgpu: u32, seqno: u64) -> Result<(), i32>;
}

/// The process's driver state behind the global lock, and the real device.
pub struct Global;

impl Gpu for Global {
    type Dev = KgpuDevice;
    fn locked<R>(&mut self, f: impl FnOnce(&mut Driver, &mut KgpuDevice) -> R) -> R {
        egl::with_driver(f)
    }
    fn wait(&mut self, kgpu: u32, seqno: u64) -> Result<(), i32> {
        KgpuDevice.wait(kgpu, seqno, -1)
    }
}

/// Runs `f` under the lock on the calling thread's current context, if it
/// has one and it is not lost.
fn with_context<G: Gpu, R>(g: &mut G, f: impl FnOnce(&mut Context, &mut G::Dev) -> R) -> Option<R> {
    let (_, r) = egl::current()?;
    g.locked(|drv, dev| {
        let c = drv.context_mut(r)?;
        if c.is_lost() {
            return None;
        }
        Some(f(c, dev))
    })
}

/// `glGetError`.
pub fn get_error(g: &mut impl Gpu) -> GLenum {
    with_context(g, |c, _| c.gl.take_error()).unwrap_or(GL_NO_ERROR)
}

/// `glGetString`.
pub fn get_string(g: &mut impl Gpu, name: GLenum) -> Option<&'static CStr> {
    with_context(g, |c, _| match name {
        GL_VENDOR => Some(VENDOR),
        GL_RENDERER => Some(RENDERER),
        GL_VERSION => Some(VERSION),
        GL_SHADING_LANGUAGE_VERSION => Some(SHADING_LANGUAGE_VERSION),
        GL_EXTENSIONS => Some(EXTENSIONS),
        _ => {
            c.gl.set_error(GL_INVALID_ENUM);
            None
        }
    })
    .flatten()
}

/// `glGetBooleanv`, `glGetIntegerv` and `glGetFloatv` before conversion:
/// the value of `pname`, or `None` after recording `GL_INVALID_ENUM`.
/// `function` names the caller in a not-implemented diagnostic.
pub fn get(g: &mut impl Gpu, function: &str, pname: GLenum) -> Option<state::Value> {
    with_context(g, |c, _| match c.gl.query(pname) {
        state::Query::Value(v) => Some(v),
        state::Query::Invalid => {
            c.gl.set_error(GL_INVALID_ENUM);
            None
        }
        state::Query::NotImplemented => crate::sys::not_implemented(function, pname),
    })
    .flatten()
}

/// `glViewport`.
pub fn viewport(g: &mut impl Gpu, x: GLint, y: GLint, w: GLsizei, h: GLsizei) {
    with_context(g, |c, dev| {
        c.gl.set_viewport(x, y, w, h);
        c.sync_gl(dev, "glViewport");
    });
}

/// `glClearColor`.
pub fn clear_color(g: &mut impl Gpu, r: GLfloat, gr: GLfloat, b: GLfloat, a: GLfloat) {
    with_context(g, |c, dev| {
        c.gl.set_clear_color(r, gr, b, a);
        c.sync_gl(dev, "glClearColor");
    });
}

/// `glClear` (§4.2.3).
pub fn clear(g: &mut impl Gpu, mask: GLbitfield) {
    with_context(g, |c, dev| {
        if mask & !CLEAR_BITS != 0 {
            return c.gl.set_error(GL_INVALID_VALUE);
        }
        // §4.4.5: a surfaceless context's framebuffer is incomplete
        // (EGL_KHR_surfaceless_context), and Clear writes to it.
        if c.gl.surface().is_none() {
            return c.gl.set_error(GL_INVALID_FRAMEBUFFER_OPERATION);
        }
        c.sync_gl(dev, "glClear");
        c.push(dev, "glClear", Command::Clear { mask });
    });
}

/// `glFlush`: submits what is queued, without waiting.
pub fn flush(g: &mut impl Gpu) {
    with_context(g, |c, dev| {
        let _ = c.flush(dev, "glFlush");
    });
}

/// `glFinish`: submits what is queued and waits, without the lock, for
/// the context's last submission.
pub fn finish(g: &mut impl Gpu) {
    let target = with_context(g, |c, dev| {
        c.flush(dev, "glFinish").ok()?;
        Some((c.kgpu_context(), c.cmds.last_seqno()?))
    })
    .flatten();
    if let Some((kgpu, seqno)) = target {
        let result = g.wait(kgpu, seqno);
        apply_wait(g, "glFinish", result);
    }
}

/// Takes the lock again after a wait: a failed wait loses the context with
/// one diagnostic (`-EIO` is the renderer's loss; `-ETIMEDOUT` cannot occur
/// with an infinite timeout, so it, like any other errno, is a defect).
fn apply_wait(g: &mut impl Gpu, call: &str, result: Result<(), i32>) -> bool {
    match result {
        Ok(()) => true,
        Err(errno) => {
            with_context(g, |c, _| c.fail(call, "wait", errno));
            false
        }
    }
}

/// A `glReadPixels` submitted under the lock and waited for after it.
struct PendingRead {
    kgpu: u32,
    seqno: u64,
    /// The read covers only part of the request: the clipped rectangle is
    /// read into this staging buffer and copied into place after the wait.
    staging: Option<(Vec<u8>, Clip)>,
}

/// The part of a read that lies inside the surface.
#[derive(Clone, Copy)]
struct Clip {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// The largest pixel buffer a read may name: its byte length must fit a
/// kgpu buffer's `u32` length and a Rust slice.
const MAX_READ_BYTES: u64 = if (u32::MAX as u64) < (isize::MAX as u64) { u32::MAX as u64 } else { isize::MAX as u64 };

/// `glReadPixels` (§4.3.1).
///
/// # Safety
/// `pixels` is NULL or writable for `width * height * 4` bytes (format
/// RGBA, type UNSIGNED_BYTE, `GL_PACK_ALIGNMENT` 4), as GLES requires of
/// the caller.
pub unsafe fn read_pixels(
    g: &mut impl Gpu,
    x: GLint,
    y: GLint,
    width: GLsizei,
    height: GLsizei,
    format: GLenum,
    type_: GLenum,
    pixels: *mut u8,
) {
    let pending = with_context(g, |c, dev| -> Option<PendingRead> {
        let gl = &mut c.gl;
        if width < 0 || height < 0 {
            gl.set_error(GL_INVALID_VALUE);
            return None;
        }
        // §2.5: a format or type outside table 3.4 is not an allowable
        // enum; an allowable pair other than RGBA/UNSIGNED_BYTE (also the
        // implementation read pair) is unsupported.
        let formats = [GL_ALPHA, GL_RGB, GL_RGBA, GL_LUMINANCE, GL_LUMINANCE_ALPHA];
        let types = [GL_UNSIGNED_BYTE, GL_UNSIGNED_SHORT_5_6_5, GL_UNSIGNED_SHORT_4_4_4_4, GL_UNSIGNED_SHORT_5_5_5_1];
        if !formats.contains(&format) || !types.contains(&type_) {
            gl.set_error(GL_INVALID_ENUM);
            return None;
        }
        if (format, type_) != (GL_RGBA, GL_UNSIGNED_BYTE) {
            gl.set_error(GL_INVALID_OPERATION);
            return None;
        }
        // §4.4.5: reading an incomplete (surfaceless) framebuffer.
        let Some((surface_w, surface_h)) = gl.surface() else {
            gl.set_error(GL_INVALID_FRAMEBUFFER_OPERATION);
            return None;
        };
        if width == 0 || height == 0 {
            return None;
        }
        // Kandelo choices, since GLES leaves both undefined: the driver
        // never hands the kernel address 0, nor a range no wasm32 buffer
        // can have.
        let len = width as u64 * height as u64 * 4;
        if pixels.is_null() || len > MAX_READ_BYTES {
            gl.set_error(GL_INVALID_VALUE);
            return None;
        }
        // Pixels outside the surface are undefined (§4.3.1) and stay as
        // they are. The EGL size bounds the read, not the storage: a 0x0
        // pbuffer has 1x1 storage outside the surface.
        let x0 = x.max(0);
        let y0 = y.max(0);
        let x1 = (i64::from(x) + i64::from(width)).min(i64::from(surface_w)) as i32;
        let y1 = (i64::from(y) + i64::from(height)).min(i64::from(surface_h)) as i32;
        if x0 >= x1 || y0 >= y1 {
            return None;
        }
        let clip = Clip { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        let (target, staging) = if (clip.x, clip.y, clip.w, clip.h) == (x, y, width, height) {
            (Buffer { addr: pixels as usize as u64, len: len as u32, access: KGPU_ACCESS_WRITE }, None)
        } else {
            let mut staging = Vec::new();
            let staging_len = clip.w as usize * clip.h as usize * 4;
            if staging.try_reserve_exact(staging_len).is_err() {
                gl.set_error(GL_OUT_OF_MEMORY);
                return None;
            }
            staging.resize(staging_len, 0);
            let target =
                Buffer { addr: staging.as_mut_ptr() as usize as u64, len: staging_len as u32, access: KGPU_ACCESS_WRITE };
            (target, Some((staging, clip)))
        };
        if let Err(errno) = c.cmds.record_read_pixels(dev, (clip.x, clip.y, clip.w, clip.h), target) {
            c.fail("glReadPixels", "submit", errno);
            return None;
        }
        let seqno = c.flush(dev, "glReadPixels").ok()??;
        Some(PendingRead { kgpu: c.kgpu_context(), seqno, staging })
    })
    .flatten();
    let Some(read) = pending else { return };
    let result = g.wait(read.kgpu, read.seqno);
    if !apply_wait(g, "glReadPixels", result) {
        return;
    }
    if let Some((staging, clip)) = read.staging {
        let row = clip.w as usize * 4;
        for j in 0..clip.h as usize {
            let dst_row = (clip.y - y) as usize + j;
            let offset = (dst_row * width as usize + (clip.x - x) as usize) * 4;
            // SAFETY: the caller's buffer holds width * height * 4 bytes,
            // and the clipped rectangle lies inside the requested one.
            unsafe { core::ptr::copy_nonoverlapping(staging.as_ptr().add(j * row), pixels.add(offset), row) };
        }
    }
}
