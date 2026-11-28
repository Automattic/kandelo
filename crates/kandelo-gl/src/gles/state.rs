//! A context's OpenGL ES 2.0 state and the simple queries over it
//! (GLES 2.0.25 §2.5, §2.12.1, §4.2.3, §6.1).
//!
//! Ownership: `State` is the GL state the model answers queries from,
//! without a kgpu call, and the executor state it has already encoded, so
//! a change is encoded once and only when it differs. It lives in the EGL
//! context (`egl::Context::gl`), so GL errors and state are per context.

use super::*;

/// The `glGet*` pnames this skeleton answers.
pub const MODELED_PNAMES: &[GLenum] = &[
    GL_VIEWPORT,
    GL_COLOR_CLEAR_VALUE,
    GL_MAX_VIEWPORT_DIMS,
    GL_RED_BITS,
    GL_GREEN_BITS,
    GL_BLUE_BITS,
    GL_ALPHA_BITS,
    GL_DEPTH_BITS,
    GL_STENCIL_BITS,
    GL_IMPLEMENTATION_COLOR_READ_FORMAT,
    GL_IMPLEMENTATION_COLOR_READ_TYPE,
];

/// Every other pname GLES 2.0.25 lets `glGet*` query: the state tables
/// (§6.2, tables 6.2-6.24) with a Get command of GetBooleanv, GetIntegerv
/// or GetFloatv, and the IsEnabled capabilities, which §6.2 says those
/// commands also return. `GL_BLEND_COLOR` is set by `glBlendColor`
/// (§4.1.6) and is in `gl2.h`, though 2.0.25's tables omit it. A query of
/// one of these is not implemented yet, never invalid.
pub const UNMODELED_PNAMES: &[GLenum] = &[
    // 6.2 Vertex array data.
    GL_ARRAY_BUFFER_BINDING,
    GL_ELEMENT_ARRAY_BUFFER_BINDING,
    // 6.4 Transformation.
    GL_DEPTH_RANGE,
    // 6.5 Rasterization.
    GL_LINE_WIDTH,
    GL_CULL_FACE,
    GL_CULL_FACE_MODE,
    GL_FRONT_FACE,
    GL_POLYGON_OFFSET_FACTOR,
    GL_POLYGON_OFFSET_UNITS,
    GL_POLYGON_OFFSET_FILL,
    // 6.6 Multisampling.
    GL_SAMPLE_ALPHA_TO_COVERAGE,
    GL_SAMPLE_COVERAGE,
    GL_SAMPLE_COVERAGE_VALUE,
    GL_SAMPLE_COVERAGE_INVERT,
    // 6.7, 6.9 Textures.
    GL_TEXTURE_BINDING_2D,
    GL_TEXTURE_BINDING_CUBE_MAP,
    GL_ACTIVE_TEXTURE,
    // 6.10 Pixel operations.
    GL_SCISSOR_TEST,
    GL_SCISSOR_BOX,
    GL_STENCIL_TEST,
    GL_STENCIL_FUNC,
    GL_STENCIL_VALUE_MASK,
    GL_STENCIL_REF,
    GL_STENCIL_FAIL,
    GL_STENCIL_PASS_DEPTH_FAIL,
    GL_STENCIL_PASS_DEPTH_PASS,
    GL_STENCIL_BACK_FUNC,
    GL_STENCIL_BACK_VALUE_MASK,
    GL_STENCIL_BACK_REF,
    GL_STENCIL_BACK_FAIL,
    GL_STENCIL_BACK_PASS_DEPTH_FAIL,
    GL_STENCIL_BACK_PASS_DEPTH_PASS,
    GL_DEPTH_TEST,
    GL_DEPTH_FUNC,
    // 6.11 Pixel operations (cont.).
    GL_BLEND,
    GL_BLEND_SRC_RGB,
    GL_BLEND_SRC_ALPHA,
    GL_BLEND_DST_RGB,
    GL_BLEND_DST_ALPHA,
    GL_BLEND_EQUATION_RGB,
    GL_BLEND_EQUATION_ALPHA,
    GL_BLEND_COLOR,
    GL_DITHER,
    // 6.12 Framebuffer control.
    GL_COLOR_WRITEMASK,
    GL_DEPTH_WRITEMASK,
    GL_STENCIL_WRITEMASK,
    GL_STENCIL_BACK_WRITEMASK,
    GL_DEPTH_CLEAR_VALUE,
    GL_STENCIL_CLEAR_VALUE,
    // 6.13 Pixels.
    GL_UNPACK_ALIGNMENT,
    GL_PACK_ALIGNMENT,
    // 6.15 Program object state.
    GL_CURRENT_PROGRAM,
    // 6.17 Hints.
    GL_GENERATE_MIPMAP_HINT,
    // 6.18-6.20 Implementation-dependent values.
    GL_SUBPIXEL_BITS,
    GL_MAX_TEXTURE_SIZE,
    GL_MAX_CUBE_MAP_TEXTURE_SIZE,
    GL_ALIASED_POINT_SIZE_RANGE,
    GL_ALIASED_LINE_WIDTH_RANGE,
    GL_SAMPLE_BUFFERS,
    GL_SAMPLES,
    GL_COMPRESSED_TEXTURE_FORMATS,
    GL_NUM_COMPRESSED_TEXTURE_FORMATS,
    GL_SHADER_BINARY_FORMATS,
    GL_NUM_SHADER_BINARY_FORMATS,
    GL_SHADER_COMPILER,
    GL_MAX_VERTEX_ATTRIBS,
    GL_MAX_VERTEX_UNIFORM_VECTORS,
    GL_MAX_VARYING_VECTORS,
    GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS,
    GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    GL_MAX_TEXTURE_IMAGE_UNITS,
    GL_MAX_FRAGMENT_UNIFORM_VECTORS,
    GL_MAX_RENDERBUFFER_SIZE,
    // 6.23, 6.24 Renderbuffer and framebuffer bindings.
    GL_RENDERBUFFER_BINDING,
    GL_FRAMEBUFFER_BINDING,
];

/// The largest viewport (and surface) dimension: what every WebGL 2
/// implementation can allocate, and the executor's `MAX_SURFACE_DIM`.
pub const MAX_VIEWPORT_DIM: i32 = kgpu_stream::MAX_SURFACE_DIM as i32;

/// The executor's state for a new kgpu context (plan ruling S6; the WebGL 2
/// backend starts each context there): viewport 0,0,0,0, clear color
/// 0,0,0,0.
const EXECUTOR_VIEWPORT: [i32; 4] = [0; 4];
const EXECUTOR_CLEAR_COLOR: [f32; 4] = [0.0; 4];

/// A queried state value before §6.1.2 converts it to the type asked for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Value {
    /// `n` integers.
    Ints { n: usize, v: [i32; 4] },
    /// An RGBA color, whose integer form follows the color rule.
    Color([f32; 4]),
}

impl Value {
    fn int(v: i32) -> Self {
        Value::Ints { n: 1, v: [v, 0, 0, 0] }
    }

    fn len(&self) -> usize {
        match *self {
            Value::Ints { n, .. } => n,
            Value::Color(_) => 4,
        }
    }

    /// `glGetIntegerv`: an RGBA component converts by the INT entry of
    /// Table 4.4 (§6.1.2).
    pub fn integers(&self) -> ([i32; 4], usize) {
        match *self {
            Value::Ints { n, v } => (v, n),
            Value::Color(c) => (c.map(color_to_int), 4),
        }
    }

    /// `glGetFloatv`: an integer is coerced to floating point (§6.1.2).
    pub fn floats(&self) -> ([f32; 4], usize) {
        match *self {
            Value::Ints { n, v } => (v.map(|i| i as f32), n),
            Value::Color(c) => (c, 4),
        }
    }

    /// `glGetBooleanv`: a value is `GL_FALSE` if and only if it is zero
    /// (§6.1.2).
    pub fn booleans(&self) -> ([GLboolean; 4], usize) {
        let b = |nonzero: bool| if nonzero { GL_TRUE } else { GL_FALSE };
        match *self {
            Value::Ints { n, v } => (v.map(|i| b(i != 0)), n),
            Value::Color(c) => (c.map(|f| b(f != 0.0)), self.len()),
        }
    }
}

/// The INT entry of GLES 2.0.25 Table 4.4: `c = ((2^32 - 1) f - 1) / 2`,
/// for `f` in [0, 1] (clear colors are clamped there). The result is
/// rounded to the nearest integer, halves up, so 0.0 is 0 and 1.0 is
/// `i32::MAX`.
fn color_to_int(f: f32) -> i32 {
    let c = (4_294_967_295.0 * f64::from(f) - 1.0) / 2.0;
    // c + 0.5 >= 0 for f >= 0, where truncation is the floor.
    ((c + 0.5) as i64).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// Clamps a `clampf` argument to [0, 1]; NaN, for which the spec gives
/// no result, and -0.0 become 0.0.
fn clampf(v: f32) -> f32 {
    if v > 0.0 { v.min(1.0) } else { 0.0 }
}

/// What a `glGet*` of a pname is.
pub enum Query {
    Value(Value),
    /// Not a GLES 2.0 pname: `GL_INVALID_ENUM`.
    Invalid,
    /// A GLES 2.0 pname the skeleton does not model yet.
    NotImplemented,
}

pub struct State {
    /// The sticky error flag (§2.5): the first error since the last
    /// `glGetError`.
    error: GLenum,
    viewport: [i32; 4],
    clear_color: [f32; 4],
    /// The draw surface's EGL size while one is bound, `None` surfaceless.
    surface: Option<(i32, i32)>,
    /// What the context's executor state holds, as encoded so far.
    sent_viewport: [i32; 4],
    sent_clear_color: [f32; 4],
}

impl Default for State {
    fn default() -> Self {
        Self::new()
    }
}

impl State {
    pub const fn new() -> Self {
        Self {
            error: GL_NO_ERROR,
            viewport: [0; 4],
            clear_color: [0.0; 4],
            surface: None,
            sent_viewport: EXECUTOR_VIEWPORT,
            sent_clear_color: EXECUTOR_CLEAR_COLOR,
        }
    }

    /// Records `error` unless an earlier one is still unread (§2.5).
    pub fn set_error(&mut self, error: GLenum) {
        if self.error == GL_NO_ERROR {
            self.error = error;
        }
    }

    /// `glGetError`: the recorded error, and none from now on.
    pub fn take_error(&mut self) -> GLenum {
        core::mem::replace(&mut self.error, GL_NO_ERROR)
    }

    pub fn viewport(&self) -> [i32; 4] {
        self.viewport
    }

    pub fn clear_color(&self) -> [f32; 4] {
        self.clear_color
    }

    /// The draw surface's EGL size, or `None` without one.
    pub fn surface(&self) -> Option<(i32, i32)> {
        self.surface
    }

    /// EGL 1.5 §3.7.3: the first time the context is made current, the
    /// viewport becomes the draw surface's size, or 0x0 surfaceless.
    pub fn first_bind(&mut self, width: i32, height: i32) {
        self.viewport = [0, 0, width, height];
    }

    /// The context is now current with a draw surface of this EGL size, or
    /// surfaceless.
    pub fn bind_surface(&mut self, surface: Option<(i32, i32)>) {
        self.surface = surface;
    }

    /// `glViewport`, after the no-context check.
    pub fn set_viewport(&mut self, x: i32, y: i32, w: i32, h: i32) {
        if w < 0 || h < 0 {
            return self.set_error(GL_INVALID_VALUE);
        }
        // §2.12.1: clamped to GL_MAX_VIEWPORT_DIMS when specified.
        self.viewport = [x, y, w.min(MAX_VIEWPORT_DIM), h.min(MAX_VIEWPORT_DIM)];
    }

    /// `glClearColor`: each component clamped to [0, 1] (§4.2.3).
    pub fn set_clear_color(&mut self, r: f32, g: f32, b: f32, a: f32) {
        self.clear_color = [r, g, b, a].map(clampf);
    }

    /// The commands that bring the executor's viewport and clear color to
    /// the GL state, and records them as sent. Nothing is encoded without
    /// a surface: the executor state waits for one.
    pub fn sync(&mut self) -> [Option<kgpu_stream::Command>; 2] {
        let mut out = [None, None];
        if self.surface.is_some() {
            if self.sent_viewport != self.viewport {
                let [x, y, w, h] = self.viewport;
                out[0] = Some(kgpu_stream::Command::Viewport { x, y, w, h });
                self.sent_viewport = self.viewport;
            }
            // Bitwise, so a changed value is never taken for the same.
            if self.sent_clear_color.map(f32::to_bits) != self.clear_color.map(f32::to_bits) {
                let [r, g, b, a] = self.clear_color;
                out[1] = Some(kgpu_stream::Command::ClearColor { r, g, b, a });
                self.sent_clear_color = self.clear_color;
            }
        }
        out
    }

    /// `glGet*` of `pname`.
    pub fn query(&self, pname: GLenum) -> Query {
        let bits = |b: i32| Query::Value(Value::int(if self.surface.is_some() { b } else { 0 }));
        match pname {
            GL_VIEWPORT => Query::Value(Value::Ints { n: 4, v: self.viewport }),
            GL_COLOR_CLEAR_VALUE => Query::Value(Value::Color(self.clear_color)),
            GL_MAX_VIEWPORT_DIMS => {
                Query::Value(Value::Ints { n: 2, v: [MAX_VIEWPORT_DIM, MAX_VIEWPORT_DIM, 0, 0] })
            }
            // §4.4.6: implementation defined for the default framebuffer.
            // The config is RGBA8888 without depth or stencil; surfaceless
            // there is no color buffer.
            GL_RED_BITS | GL_GREEN_BITS | GL_BLUE_BITS | GL_ALPHA_BITS => bits(8),
            GL_DEPTH_BITS | GL_STENCIL_BITS => bits(0),
            GL_IMPLEMENTATION_COLOR_READ_FORMAT => Query::Value(Value::int(GL_RGBA as i32)),
            GL_IMPLEMENTATION_COLOR_READ_TYPE => Query::Value(Value::int(GL_UNSIGNED_BYTE as i32)),
            p if UNMODELED_PNAMES.contains(&p) => Query::NotImplemented,
            _ => Query::Invalid,
        }
    }
}
