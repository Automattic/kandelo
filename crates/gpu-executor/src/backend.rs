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
//! across contexts itself. Surfaces are keyed by `(context, surface)`: the
//! executor has checked each name against the context's surface table, so a
//! backend is only asked to create a name that is free, and to bind or
//! destroy one it holds.

extern crate alloc;

use alloc::vec::Vec;

use wasm_posix_shared::Errno;
use wasm_posix_shared::kgpu::Extent;

pub trait Backend {
    /// Accept a new context, which holds no surface yet. A backend that
    /// cannot render refuses here (`NullBackend` answers `ENODEV`), so a
    /// guest learns the boundary when it creates a context. Failure is a
    /// negative errno.
    fn create_context(&mut self, context: u32) -> Result<(), i32>;
    /// Release the context and every surface it still holds. Called once
    /// per context the backend accepted, on destroy or on a fault.
    fn destroy_context(&mut self, context: u32);
    /// Allocate a `width`x`height` RGBA8 surface named `surface` in the
    /// context. The executor has checked the name is nonzero and free and
    /// both dimensions are in `1..=MAX_SURFACE_DIM`. Failure is a negative
    /// errno.
    fn create_surface(
        &mut self,
        context: u32,
        surface: u32,
        width: u32,
        height: u32,
    ) -> Result<(), i32>;
    /// Release one surface. If it is bound, the context has none bound.
    fn destroy_surface(&mut self, context: u32, surface: u32);
    /// Make `surface` the target of later clears and reads; 0 = none. The
    /// viewport and clear color are context state and do not change.
    fn bind_surface(&mut self, context: u32, surface: u32);
    fn viewport(&mut self, context: u32, x: i32, y: i32, w: i32, h: i32);
    fn clear_color(&mut self, context: u32, rgba: [f32; 4]);
    fn clear(&mut self, context: u32, mask: u32);
    /// Read `w*h` RGBA8 pixels of the bound surface and write them across
    /// `dst`, byte ranges of the memory group's shared backing. The
    /// executor has checked that a surface is bound and that `dst` totals
    /// exactly `w*h*4` bytes of a write buffer. `clear` likewise runs only
    /// with a surface bound.
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
    fn create_context(&mut self, _: u32) -> Result<(), i32> {
        Err(ENODEV)
    }
    fn destroy_context(&mut self, _: u32) {}
    fn create_surface(&mut self, _: u32, _: u32, _: u32, _: u32) -> Result<(), i32> {
        // Unreachable through the executor, as for `read_pixels`.
        Err(ENODEV)
    }
    fn destroy_surface(&mut self, _: u32, _: u32) {}
    fn bind_surface(&mut self, _: u32, _: u32) {}
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
    CreateContext {
        context: u32,
    },
    DestroyContext {
        context: u32,
    },
    CreateSurface {
        context: u32,
        surface: u32,
        width: u32,
        height: u32,
    },
    DestroySurface {
        context: u32,
        surface: u32,
    },
    BindSurface {
        context: u32,
        surface: u32,
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
/// executor issues. `lost`, `create_context_result` and
/// `create_surface_result` let a test model a lost device, a refused
/// context and a failing allocation.
#[derive(Debug)]
pub struct RecordingBackend {
    pub calls: Vec<Call>,
    pub lost: bool,
    pub create_context_result: Result<(), i32>,
    pub create_surface_result: Result<(), i32>,
}

impl RecordingBackend {
    pub fn new() -> Self {
        RecordingBackend {
            calls: Vec::new(),
            lost: false,
            create_context_result: Ok(()),
            create_surface_result: Ok(()),
        }
    }
}

impl Default for RecordingBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl Backend for RecordingBackend {
    fn create_context(&mut self, context: u32) -> Result<(), i32> {
        self.calls.push(Call::CreateContext { context });
        self.create_context_result
    }
    fn destroy_context(&mut self, context: u32) {
        self.calls.push(Call::DestroyContext { context });
    }
    fn create_surface(
        &mut self,
        context: u32,
        surface: u32,
        width: u32,
        height: u32,
    ) -> Result<(), i32> {
        self.calls.push(Call::CreateSurface {
            context,
            surface,
            width,
            height,
        });
        self.create_surface_result
    }
    fn destroy_surface(&mut self, context: u32, surface: u32) {
        self.calls.push(Call::DestroySurface { context, surface });
    }
    fn bind_surface(&mut self, context: u32, surface: u32) {
        self.calls.push(Call::BindSurface { context, surface });
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
