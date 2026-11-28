//! The exported GLES2 entry points, with the Khronos signatures of
//! `libc/musl-overlay/include/GLES2/gl2.h`.
//!
//! Ownership: each function only converts C arguments and calls the
//! function of the same name in `gles` over `Global`, the process's driver
//! state and the real device. All GL behavior is there, where the native
//! tests drive it over `FakeDevice`.

use super::*;
use core::ffi::c_void;

#[unsafe(no_mangle)]
pub extern "C" fn glGetError() -> GLenum {
    get_error(&mut Global)
}

#[unsafe(no_mangle)]
pub extern "C" fn glGetString(name: GLenum) -> *const GLubyte {
    get_string(&mut Global, name).map_or(core::ptr::null(), |s| s.as_ptr().cast())
}

/// Writes a query's converted values through `data`, unless it is NULL.
///
/// # Safety
/// `data` is NULL or writable for as many values as the pname has.
unsafe fn store<T: Copy>(data: *mut T, values: ([T; 4], usize)) {
    if data.is_null() {
        return;
    }
    let (values, n) = values;
    for (i, &v) in values[..n].iter().enumerate() {
        unsafe { data.add(i).write(v) };
    }
}

/// # Safety
/// `data` is NULL or writable for as many values as `pname` has.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glGetBooleanv(pname: GLenum, data: *mut GLboolean) {
    if let Some(v) = get(&mut Global, "glGetBooleanv", pname) {
        unsafe { store(data, v.booleans()) }
    }
}

/// # Safety
/// `data` is NULL or writable for as many values as `pname` has.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glGetIntegerv(pname: GLenum, data: *mut GLint) {
    if let Some(v) = get(&mut Global, "glGetIntegerv", pname) {
        unsafe { store(data, v.integers()) }
    }
}

/// # Safety
/// `data` is NULL or writable for as many values as `pname` has.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glGetFloatv(pname: GLenum, data: *mut GLfloat) {
    if let Some(v) = get(&mut Global, "glGetFloatv", pname) {
        unsafe { store(data, v.floats()) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei) {
    viewport(&mut Global, x, y, width, height)
}

#[unsafe(no_mangle)]
pub extern "C" fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat) {
    clear_color(&mut Global, red, green, blue, alpha)
}

#[unsafe(no_mangle)]
pub extern "C" fn glClear(mask: GLbitfield) {
    clear(&mut Global, mask)
}

/// # Safety
/// `pixels` is NULL or writable for `width * height * 4` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn glReadPixels(
    x: GLint,
    y: GLint,
    width: GLsizei,
    height: GLsizei,
    format: GLenum,
    type_: GLenum,
    pixels: *mut c_void,
) {
    unsafe { read_pixels(&mut Global, x, y, width, height, format, type_, pixels.cast()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn glFlush() {
    flush(&mut Global)
}

#[unsafe(no_mangle)]
pub extern "C" fn glFinish() {
    finish(&mut Global)
}
