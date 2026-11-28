//! kandelo-gl: Kandelo's userspace EGL 1.5 and OpenGL ES 2.0 driver.
//!
//! Ownership: one wasm32 static library (`libkandelo_gl.a`) defines both the
//! EGL and the GLES entry points a C program links against. It models EGL
//! and GL state in process, encodes `kgpu-stream` records into a heap
//! command buffer, and reaches the kernel only through `kgpu::Device`
//! (the `kandelo.kgpu.v1` program extension) to create contexts, submit
//! and wait. See docs/plans/2026-11-27-rust-gpu-driver-design.md.
//!
//! Only implemented entry points are defined: a program that calls a
//! function the driver does not define fails to link rather than receiving
//! a made-up answer.
//!
//! The library is not yet in the SDK sysroot; `build-wasm.sh` builds it as
//! `local-binaries/libkandelo_gl.a` for the slice's test programs.
#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod kgpu;
mod sys;

pub use sys::diag;

/// `EGLint` (`khronos_int32_t`).
pub type EGLint = i32;

pub const EGL_SUCCESS: EGLint = 0x3000;

/// EGL 1.5 §3.1: the error of the calling thread's last EGL call.
///
/// The driver makes no EGL call that can fail yet, so every thread's error
/// is `EGL_SUCCESS`.
#[unsafe(no_mangle)]
pub extern "C" fn eglGetError() -> EGLint {
    EGL_SUCCESS
}
