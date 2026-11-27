//! The platform interface the executor drives, and its two native backends.
//!
//! Ownership: the executor (`crate::Executor`) decides what a submission
//! means and validates it completely; a backend only performs the already
//! validated operation on the platform's GPU. Keeping the boundary this
//! narrow is what lets one executor run over WebGL 2 in the GPU worker
//! (`crate::wasm`'s imported backend), a recording backend under native
//! `cargo test`, and a null backend where no renderer exists.
//!
//! Every method receives the context it acts for, and the executor only
//! ever passes the context of the record it is handling, so a backend keeps
//! per-context objects keyed by that id and never needs to police access
//! across contexts itself.

extern crate alloc;

use alloc::vec::Vec;

use wasm_posix_shared::Errno;
use wasm_posix_shared::kgpu::Extent;

pub trait Backend {
    /// Allocate the context's render surface. Failure is a negative errno.
    fn create_surface(&mut self, context: u32, width: u32, height: u32) -> Result<(), i32>;
    fn destroy_surface(&mut self, context: u32);
    fn viewport(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32);
    fn clear_color(&mut self, context: u32, rgba: [f32; 4]);
    fn clear(&mut self, context: u32, mask: u32);
    /// Read `w*h` RGBA8 pixels and write them across `dst`, byte ranges of
    /// the memory group's shared backing. The executor has checked that
    /// `dst` totals at least `w*h*4` bytes and names a write buffer.
    fn read_pixels(
        &mut self,
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        dst: &[Extent],
    ) -> Result<(), i32>;
    /// The platform device is gone (for WebGL 2, `webglcontextlost`).
    fn is_lost(&self) -> bool;
}

/// The backend for a host with no renderer (Node without an
/// embedder-supplied WebGL 2). Context creation fails with `ENODEV`, so the
/// guest sees the real boundary instead of a context that silently draws
/// nothing.
#[derive(Debug, Default)]
pub struct NullBackend;

const ENODEV: i32 = -(Errno::ENODEV as i32);

impl Backend for NullBackend {
    fn create_surface(&mut self, _: u32, _: u32, _: u32) -> Result<(), i32> {
        Err(ENODEV)
    }
    fn destroy_surface(&mut self, _: u32) {}
    fn viewport(&mut self, _: u32, _: i32, _: i32, _: i32, _: i32) {}
    fn clear_color(&mut self, _: u32, _: [f32; 4]) {}
    fn clear(&mut self, _: u32, _: u32) {}
    fn read_pixels(
        &mut self,
        _: u32,
        _: i32,
        _: i32,
        _: i32,
        _: i32,
        _: &[Extent],
    ) -> Result<(), i32> {
        // Unreachable through the executor (no context can exist), but a
        // backend must not report success for work it did not do.
        Err(ENODEV)
    }
    fn is_lost(&self) -> bool {
        false
    }
}

/// One backend call, as `RecordingBackend` saw it.
#[derive(Clone, Debug, PartialEq)]
pub enum Call {
    CreateSurface {
        context: u32,
        width: u32,
        height: u32,
    },
    DestroySurface {
        context: u32,
    },
    Viewport {
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    },
    ClearColor {
        context: u32,
        rgba: [f32; 4],
    },
    Clear {
        context: u32,
        mask: u32,
    },
    ReadPixels {
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        dst: Vec<Extent>,
    },
}

/// Records every call so native tests can assert the exact sequence the
/// executor issues. `lost` and `create_result` let a test model a lost
/// device and a failing allocation.
#[derive(Debug)]
pub struct RecordingBackend {
    pub calls: Vec<Call>,
    pub lost: bool,
    pub create_result: Result<(), i32>,
}

impl RecordingBackend {
    pub fn new() -> Self {
        RecordingBackend {
            calls: Vec::new(),
            lost: false,
            create_result: Ok(()),
        }
    }
}

impl Default for RecordingBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl Backend for RecordingBackend {
    fn create_surface(&mut self, context: u32, width: u32, height: u32) -> Result<(), i32> {
        self.calls.push(Call::CreateSurface {
            context,
            width,
            height,
        });
        self.create_result
    }
    fn destroy_surface(&mut self, context: u32) {
        self.calls.push(Call::DestroySurface { context });
    }
    fn viewport(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32) {
        self.calls.push(Call::Viewport {
            context,
            x,
            y,
            w,
            h,
        });
    }
    fn clear_color(&mut self, context: u32, rgba: [f32; 4]) {
        self.calls.push(Call::ClearColor { context, rgba });
    }
    fn clear(&mut self, context: u32, mask: u32) {
        self.calls.push(Call::Clear { context, mask });
    }
    fn read_pixels(
        &mut self,
        context: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        dst: &[Extent],
    ) -> Result<(), i32> {
        self.calls.push(Call::ReadPixels {
            context,
            x,
            y,
            w,
            h,
            dst: dst.to_vec(),
        });
        Ok(())
    }
    fn is_lost(&self) -> bool {
        self.lost
    }
}
