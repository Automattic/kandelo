//! Pbuffer surfaces (EGL 1.5 §3.5.2, §3.5.5, §3.5.6).
//!
//! Ownership: a surface is EGL state until a context first draws into it.
//! Its executor storage is created lazily, the first time it is made
//! current: `SurfaceCreate` is queued into that context's stream under the
//! surface's driver-chosen name, and the storage then belongs to that kgpu
//! context (no sharing yet, plan scope S5). Destroying the surface queues
//! `SurfaceDestroy` into that context once the surface is no longer
//! current; destroying the context releases the storage with it.

use super::config::{self, MAX_PBUFFER_DIM};
use super::*;
use crate::kgpu::Device;

/// Where a surface's executor storage is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Storage {
    /// Not made current yet.
    None,
    /// In this context (an `EGLContext` handle).
    In(usize),
    /// Its context was destroyed, and the contents with it. The skeleton
    /// cannot move a surface to another context, so it can never be made
    /// current again.
    Lost,
}

pub struct Surface {
    pub(crate) handle: usize,
    pub(crate) config_id: EGLint,
    pub(crate) width: EGLint,
    pub(crate) height: EGLint,
    largest_pbuffer: EGLint,
    mipmap_texture: EGLint,
    gl_colorspace: EGLint,
    pub(crate) swap_interval: EGLint,
    /// The thread it is current to, by `thread::id`.
    pub(crate) thread: Option<u32>,
    pub(crate) storage: Storage,
    /// Marked by `eglDestroySurface` or `eglTerminate`; its handle is
    /// invalid, and it goes away once no thread has it current.
    pub(crate) deleted: bool,
}

impl Surface {
    /// The surface's name in its context's executor table: nonzero, and
    /// never reused within the process.
    pub fn name(&self) -> u32 {
        (self.handle >> 2) as u32
    }

    pub fn width(&self) -> EGLint {
        self.width
    }

    pub fn height(&self) -> EGLint {
        self.height
    }

    /// The executor storage size. EGL allows a 0-pixel pbuffer (the default
    /// size); the executor's surfaces are at least 1x1, and the extra
    /// storage is outside the surface, where reads are undefined.
    pub(crate) fn storage_size(&self) -> (u32, u32) {
        (self.width.max(1) as u32, self.height.max(1) as u32)
    }

    fn query(&self, attribute: EGLint) -> Result<EGLint> {
        Ok(match attribute {
            EGL_CONFIG_ID => self.config_id,
            EGL_WIDTH => self.width,
            EGL_HEIGHT => self.height,
            EGL_LARGEST_PBUFFER => self.largest_pbuffer,
            // The config cannot bind to textures (EGL_BIND_TO_TEXTURE_* are
            // false), so creation accepted only EGL_NO_TEXTURE.
            EGL_TEXTURE_FORMAT | EGL_TEXTURE_TARGET => EGL_NO_TEXTURE,
            EGL_MIPMAP_TEXTURE => self.mipmap_texture,
            EGL_MIPMAP_LEVEL => 0,
            EGL_GL_COLORSPACE => self.gl_colorspace,
            // Creation refused the values the config does not support.
            EGL_VG_COLORSPACE => EGL_VG_COLORSPACE_sRGB,
            EGL_VG_ALPHA_FORMAT => EGL_VG_ALPHA_FORMAT_NONPRE,
            // §3.5.6: a pbuffer always renders to its back buffer.
            EGL_RENDER_BUFFER => EGL_BACK_BUFFER,
            EGL_MULTISAMPLE_RESOLVE => EGL_MULTISAMPLE_RESOLVE_DEFAULT,
            // A pbuffer swap has no effect (§3.10.1), so the color buffer
            // is preserved.
            EGL_SWAP_BEHAVIOR => EGL_BUFFER_PRESERVED,
            // §3.5.6: unknown for an offscreen surface.
            EGL_HORIZONTAL_RESOLUTION | EGL_VERTICAL_RESOLUTION | EGL_PIXEL_ASPECT_RATIO => EGL_UNKNOWN,
            _ => return Err(EGL_BAD_ATTRIBUTE),
        })
    }
}

/// The attributes `eglCreatePbufferSurface` accepts, with §3.5.2 defaults.
struct PbufferRequest {
    width: EGLint,
    height: EGLint,
    largest: EGLint,
    texture_format: EGLint,
    texture_target: EGLint,
    mipmap_texture: EGLint,
    gl_colorspace: EGLint,
    vg_colorspace: EGLint,
    vg_alpha_format: EGLint,
}

fn one_of(value: EGLint, allowed: &[EGLint]) -> Result<EGLint> {
    if allowed.contains(&value) { Ok(value) } else { Err(EGL_BAD_ATTRIBUTE) }
}

impl PbufferRequest {
    fn parse(list: &[EGLint]) -> Result<Self> {
        let mut r = Self {
            width: 0,
            height: 0,
            largest: EGL_FALSE,
            texture_format: EGL_NO_TEXTURE,
            texture_target: EGL_NO_TEXTURE,
            mipmap_texture: EGL_FALSE,
            gl_colorspace: EGL_GL_COLORSPACE_LINEAR,
            vg_colorspace: EGL_VG_COLORSPACE_sRGB,
            vg_alpha_format: EGL_VG_ALPHA_FORMAT_NONPRE,
        };
        let boolean = [EGL_TRUE, EGL_FALSE];
        for pair in attrib_pairs(list) {
            let (attribute, value) = pair?;
            match attribute {
                EGL_WIDTH => r.width = value,
                EGL_HEIGHT => r.height = value,
                EGL_LARGEST_PBUFFER => r.largest = one_of(value, &boolean)?,
                EGL_TEXTURE_FORMAT => {
                    r.texture_format = one_of(value, &[EGL_NO_TEXTURE, EGL_TEXTURE_RGB, EGL_TEXTURE_RGBA])?
                }
                EGL_TEXTURE_TARGET => r.texture_target = one_of(value, &[EGL_NO_TEXTURE, EGL_TEXTURE_2D])?,
                EGL_MIPMAP_TEXTURE => r.mipmap_texture = one_of(value, &boolean)?,
                EGL_GL_COLORSPACE => {
                    r.gl_colorspace = one_of(value, &[EGL_GL_COLORSPACE_LINEAR, EGL_GL_COLORSPACE_SRGB])?
                }
                EGL_VG_COLORSPACE => {
                    r.vg_colorspace = one_of(value, &[EGL_VG_COLORSPACE_sRGB, EGL_VG_COLORSPACE_LINEAR])?
                }
                EGL_VG_ALPHA_FORMAT => {
                    r.vg_alpha_format = one_of(value, &[EGL_VG_ALPHA_FORMAT_NONPRE, EGL_VG_ALPHA_FORMAT_PRE])?
                }
                _ => return Err(EGL_BAD_ATTRIBUTE),
            }
        }
        Ok(r)
    }
}

impl Driver {
    /// The live surface `handle` names (`EGL_BAD_SURFACE` otherwise).
    pub(crate) fn live_surface(&self, handle: usize) -> Result<&Surface> {
        self.surfaces.get(&handle).filter(|s| !s.deleted).ok_or(EGL_BAD_SURFACE)
    }

    /// `eglCreatePbufferSurface`. It makes no kgpu call: storage is created
    /// when the surface is first made current.
    pub fn create_pbuffer_surface(&mut self, dpy: usize, config: usize, attribs: &[EGLint]) -> usize {
        let result = self.initialized_display(dpy).and_then(|()| {
            let config = config::by_handle(config).ok_or(EGL_BAD_CONFIG)?;
            let r = PbufferRequest::parse(attribs)?;
            if config.get(EGL_SURFACE_TYPE).unwrap_or(0) & EGL_PBUFFER_BIT == 0 {
                return Err(EGL_BAD_MATCH);
            }
            if r.width < 0 || r.height < 0 {
                return Err(EGL_BAD_PARAMETER);
            }
            // The config has EGL_BIND_TO_TEXTURE_RGB and _RGBA false, so no
            // texture format or target can be honored; a format without a
            // target, or a target without a format, is a mismatch as well.
            if r.texture_format != EGL_NO_TEXTURE || r.texture_target != EGL_NO_TEXTURE {
                return Err(EGL_BAD_MATCH);
            }
            // The config supports neither linear OpenVG color nor
            // premultiplied OpenVG alpha (§3.5.1, by reference in §3.5.2).
            if r.vg_colorspace != EGL_VG_COLORSPACE_sRGB || r.vg_alpha_format != EGL_VG_ALPHA_FORMAT_NONPRE {
                return Err(EGL_BAD_MATCH);
            }
            let (mut width, mut height) = (r.width, r.height);
            if width > MAX_PBUFFER_DIM || height > MAX_PBUFFER_DIM {
                // The executor cannot allocate more. EGL_LARGEST_PBUFFER
                // asks for the largest pbuffer no bigger than requested.
                if r.largest != EGL_TRUE {
                    return Err(EGL_BAD_ALLOC);
                }
                width = width.min(MAX_PBUFFER_DIM);
                height = height.min(MAX_PBUFFER_DIM);
            }
            let handle = next_handle(&mut self.next_surface, TAG_SURFACE)?;
            self.surfaces.insert(handle, Surface {
                handle,
                config_id: config.id(),
                width,
                height,
                largest_pbuffer: r.largest,
                mipmap_texture: r.mipmap_texture,
                // GLES 2.0 has no sRGB framebuffers; EGL 1.5 §3.5.1 note 11
                // says such a context ignores the request, and the query
                // reports what was asked.
                gl_colorspace: r.gl_colorspace,
                swap_interval: 1,
                thread: None,
                storage: Storage::None,
                deleted: false,
            });
            Ok(handle)
        });
        thread::report(result, NO_HANDLE)
    }

    /// `eglDestroySurface`. A surface current to some thread is only marked;
    /// its storage is released once it is no longer current (§3.5.5).
    pub fn destroy_surface(&mut self, dev: &mut impl Device, dpy: usize, surface: usize) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            self.live_surface(surface)?;
            self.surfaces.get_mut(&surface).expect("live").deleted = true;
            self.reap(dev, "eglDestroySurface");
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }

    /// `eglQuerySurface`. It makes no kgpu call.
    pub fn query_surface(&mut self, dpy: usize, surface: usize, attribute: EGLint, value: Option<&mut EGLint>) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            let v = self.live_surface(surface)?.query(attribute)?;
            *value.ok_or(EGL_BAD_PARAMETER)? = v;
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }
}
