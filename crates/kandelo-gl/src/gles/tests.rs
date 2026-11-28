//! The GLES2 skeleton over `FakeDevice`: every expectation is
//! GLES 2.0.25's, or a skeleton choice the plan documents.

use super::*;
use crate::egl::{self, DISPLAY, EGLint, NO_HANDLE};
use crate::kgpu::{Call, FakeDevice, FakeOp, KGPU_MAX_STREAM};
use kgpu_stream::{RECORD_HEADER_SIZE, STREAM_HEADER_SIZE};
use std::sync::Mutex;
use std::vec::Vec;

const EIO: i32 = -5;
const PBUFFER_ES2: [EGLint; 5] =
    [egl::EGL_SURFACE_TYPE, egl::EGL_PBUFFER_BIT, egl::EGL_RENDERABLE_TYPE, egl::EGL_OPENGL_ES2_BIT, egl::EGL_NONE];
const ES2: [EGLint; 3] = [egl::EGL_CONTEXT_CLIENT_VERSION, 2, egl::EGL_NONE];

/// The driver over a fake device, with the lock modeled: `waits` counts the
/// waits made through `Gpu::wait`, which cannot run inside `locked`.
struct Gl {
    drv: Driver,
    dev: FakeDevice,
    waits: usize,
}

impl Gpu for Gl {
    type Dev = FakeDevice;
    fn locked<R>(&mut self, f: impl FnOnce(&mut Driver, &mut FakeDevice) -> R) -> R {
        f(&mut self.drv, &mut self.dev)
    }
    fn wait(&mut self, kgpu: u32, seqno: u64) -> Result<(), i32> {
        self.waits += 1;
        self.dev.wait(kgpu, seqno, -1)
    }
}

/// One driver shared by threads, as the global lock shares it.
impl Gpu for &Mutex<Gl> {
    type Dev = FakeDevice;
    fn locked<R>(&mut self, f: impl FnOnce(&mut Driver, &mut FakeDevice) -> R) -> R {
        let mut g = self.lock().unwrap();
        let g = &mut *g;
        f(&mut g.drv, &mut g.dev)
    }
    fn wait(&mut self, kgpu: u32, seqno: u64) -> Result<(), i32> {
        self.lock().unwrap().wait(kgpu, seqno)
    }
}

impl Gl {
    fn init() -> Self {
        let mut g = Self { drv: Driver::new(), dev: FakeDevice::new(), waits: 0 };
        assert_eq!(g.drv.initialize(&mut g.dev, DISPLAY, None, None), 1);
        g
    }

    fn config(&mut self) -> usize {
        let (mut configs, mut n) = ([0usize; 1], 0);
        assert_eq!(self.drv.choose_config(DISPLAY, &PBUFFER_ES2, Some(&mut configs), Some(&mut n)), 1);
        configs[0]
    }

    fn pbuffer(&mut self, width: EGLint, height: EGLint) -> usize {
        let config = self.config();
        let attribs = [egl::EGL_WIDTH, width, egl::EGL_HEIGHT, height, egl::EGL_NONE];
        let s = self.drv.create_pbuffer_surface(DISPLAY, config, &attribs);
        assert_ne!(s, NO_HANDLE);
        s
    }

    fn context(&mut self) -> usize {
        let config = self.config();
        let c = self.drv.create_context(&mut self.dev, DISPLAY, config, NO_HANDLE, &ES2);
        assert_ne!(c, NO_HANDLE);
        c
    }

    fn make_current(&mut self, surface: usize, context: usize) -> u32 {
        self.drv.make_current(&mut self.dev, DISPLAY, surface, surface, context)
    }

    /// A context current with a `width`x`height` pbuffer: its surface name.
    fn current_pbuffer(width: EGLint, height: EGLint) -> (Self, u32) {
        let mut g = Self::init();
        let (c, s) = (g.context(), g.pbuffer(width, height));
        assert_eq!(g.make_current(s, c), 1);
        let name = g.drv.surface(s).unwrap().name();
        (g, name)
    }

    fn current_surfaceless() -> Self {
        let mut g = Self::init();
        let c = g.context();
        assert_eq!(g.make_current(NO_HANDLE, c), 1);
        g
    }

    fn submits(&self) -> Vec<(Vec<Command>, Vec<Buffer>)> {
        self.dev
            .log()
            .iter()
            .filter_map(|c| match c {
                Call::Submit { commands, buffers, .. } => Some((commands.clone(), buffers.clone())),
                _ => None,
            })
            .collect()
    }

    /// The commands queued and not yet submitted.
    fn queued(&mut self) -> usize {
        let (_, r) = egl::current().expect("current");
        self.drv.context_mut(r).unwrap().cmds.stream_len()
    }
}

fn ints(g: &mut impl Gpu, pname: GLenum) -> Vec<i32> {
    let (v, n) = get(g, "glGetIntegerv", pname).expect("a value").integers();
    v[..n].to_vec()
}

fn floats(g: &mut impl Gpu, pname: GLenum) -> Vec<f32> {
    let (v, n) = get(g, "glGetFloatv", pname).expect("a value").floats();
    v[..n].to_vec()
}

fn booleans(g: &mut impl Gpu, pname: GLenum) -> Vec<GLboolean> {
    let (v, n) = get(g, "glGetBooleanv", pname).expect("a value").booleans();
    v[..n].to_vec()
}

fn diags() -> Vec<String> {
    crate::sys::take_diagnostics()
}

fn read(g: &mut impl Gpu, x: i32, y: i32, w: i32, h: i32, format: GLenum, type_: GLenum, pixels: &mut [u8]) {
    let ptr = if pixels.is_empty() { core::ptr::null_mut() } else { pixels.as_mut_ptr() };
    unsafe { read_pixels(g, x, y, w, h, format, type_, ptr) }
}

#[test]
fn clear_and_read_encodes_exact_stream() {
    let (mut g, n) = Gl::current_pbuffer(16, 8);
    clear_color(&mut g, 0.2, 0.4, 0.6, 1.0);
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    let mut pixels = vec![0xAB_u8; 16 * 8 * 4];
    read(&mut g, 0, 0, 16, 8, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    let buffer = Buffer { addr: pixels.as_ptr() as usize as u64, len: 512, access: crate::kgpu::KGPU_ACCESS_WRITE };
    assert_eq!(g.submits(), [(
        vec![
            Command::SurfaceCreate { surface: n, width: 16, height: 8 },
            Command::SurfaceBind { surface: n },
            Command::Viewport { x: 0, y: 0, w: 16, h: 8 },
            Command::ClearColor { r: 0.2, g: 0.4, b: 0.6, a: 1.0 },
            Command::Clear { mask: 0x4000 },
            Command::ReadPixels { x: 0, y: 0, w: 16, h: 8, buffer: 0 },
        ],
        vec![buffer],
    )]);
    // The read waited, forever, for exactly that submission, through the
    // unlocked wait.
    assert_eq!(g.dev.log().last(), Some(&Call::Wait { context: 2, seqno: 1, timeout_ns: -1 }));
    assert_eq!(g.waits, 1);
    assert!(diags().is_empty());
}

#[test]
fn the_stream_is_the_encoder_s() {
    // The header this crate finishes by hand is the one Encoder writes.
    let mut cmds = CommandBuffer::new(7);
    let mut dev = FakeDevice::new();
    let commands = [Command::Viewport { x: 1, y: 2, w: 3, h: 4 }, Command::Clear { mask: 0x4000 }];
    for c in commands {
        cmds.record(&mut dev, c).unwrap();
    }
    let mut expected = [0u8; 64];
    let mut e = kgpu_stream::Encoder::new(&mut expected, 7);
    e.viewport(1, 2, 3, 4).unwrap();
    e.clear(0x4000).unwrap();
    let len = e.finish().unwrap();
    assert_eq!(cmds.stream_len(), len);
    struct Bytes(Vec<u8>);
    impl Device for Bytes {
        fn context_create(&mut self) -> Result<u32, i32> {
            unreachable!()
        }
        fn context_destroy(&mut self, _: u32) -> Result<(), i32> {
            unreachable!()
        }
        fn submit(&mut self, _: u32, stream: &[u8], _: &[Buffer]) -> Result<u64, i32> {
            self.0 = stream.to_vec();
            Ok(1)
        }
        fn wait(&mut self, _: u32, _: u64, _: i64) -> Result<(), i32> {
            unreachable!()
        }
    }
    let mut bytes = Bytes(Vec::new());
    assert_eq!(cmds.flush(&mut bytes), Ok(Some(1)));
    assert_eq!(bytes.0, expected[..len]);
    assert!(cmds.is_empty());
    assert_eq!(cmds.flush(&mut bytes), Ok(None), "nothing queued, nothing submitted");
}

#[test]
fn get_calls_make_no_device_calls() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let calls = g.dev.calls();
    for _ in 0..3 {
        assert_eq!(get_error(&mut g), GL_NO_ERROR);
        assert!(get_string(&mut g, GL_VERSION).is_some());
        for pname in state::MODELED_PNAMES {
            let _ = (ints(&mut g, *pname), floats(&mut g, *pname), booleans(&mut g, *pname));
        }
        viewport(&mut g, 1, 1, 2, 2);
        clear_color(&mut g, 0.5, 0.5, 0.5, 0.5);
        clear(&mut g, GL_COLOR_BUFFER_BIT);
    }
    assert_eq!(g.dev.calls(), calls, "no kgpu trip until a flush");
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
}

#[test]
fn modeled_values_and_conversions() {
    let (mut g, _) = Gl::current_pbuffer(16, 8);
    assert_eq!(get_string(&mut g, GL_VENDOR), Some(c"Kandelo"));
    assert_eq!(get_string(&mut g, GL_RENDERER), Some(c"kandelo-gl (WebGL 2)"));
    assert_eq!(get_string(&mut g, GL_VERSION), Some(c"OpenGL ES 2.0 kandelo-gl"));
    assert_eq!(get_string(&mut g, GL_SHADING_LANGUAGE_VERSION), Some(c"OpenGL ES GLSL ES 1.00"));
    assert_eq!(get_string(&mut g, GL_EXTENSIONS), Some(c""));
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    assert_eq!(get_string(&mut g, GL_VIEWPORT), None);
    assert_eq!(get_error(&mut g), GL_INVALID_ENUM);
    assert_eq!(ints(&mut g, GL_MAX_VIEWPORT_DIMS), [4096, 4096]);
    assert_eq!(floats(&mut g, GL_MAX_VIEWPORT_DIMS), [4096.0, 4096.0]);
    for pname in [GL_RED_BITS, GL_GREEN_BITS, GL_BLUE_BITS, GL_ALPHA_BITS] {
        assert_eq!(ints(&mut g, pname), [8]);
    }
    assert_eq!(ints(&mut g, GL_DEPTH_BITS), [0]);
    assert_eq!(booleans(&mut g, GL_STENCIL_BITS), [GL_FALSE]);
    assert_eq!(ints(&mut g, GL_IMPLEMENTATION_COLOR_READ_FORMAT), [GL_RGBA as i32]);
    assert_eq!(ints(&mut g, GL_IMPLEMENTATION_COLOR_READ_TYPE), [GL_UNSIGNED_BYTE as i32]);
    // Clear color: clamped to [0, 1]; integers by Table 4.4's INT rule.
    assert_eq!(floats(&mut g, GL_COLOR_CLEAR_VALUE), [0.0; 4]);
    assert_eq!(booleans(&mut g, GL_COLOR_CLEAR_VALUE), [GL_FALSE; 4]);
    clear_color(&mut g, -1.0, 0.5, 2.0, f32::NAN);
    assert_eq!(floats(&mut g, GL_COLOR_CLEAR_VALUE), [0.0, 0.5, 1.0, 0.0]);
    assert_eq!(ints(&mut g, GL_COLOR_CLEAR_VALUE), [0, 1_073_741_823, i32::MAX, 0]);
    assert_eq!(booleans(&mut g, GL_COLOR_CLEAR_VALUE), [GL_FALSE, GL_TRUE, GL_TRUE, GL_FALSE]);
    // Viewport: integers, coerced to floats, nonzero is true.
    viewport(&mut g, -3, 0, 5, 7);
    assert_eq!(floats(&mut g, GL_VIEWPORT), [-3.0, 0.0, 5.0, 7.0]);
    assert_eq!(booleans(&mut g, GL_VIEWPORT), [GL_TRUE, GL_FALSE, GL_TRUE, GL_TRUE]);
    // An invalid pname: GL_INVALID_ENUM, nothing written.
    assert!(get(&mut g, "glGetIntegerv", 0x1234).is_none());
    assert_eq!(get_error(&mut g), GL_INVALID_ENUM);
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
}

#[test]
fn viewport_defaults_to_surface_size() {
    let (mut g, _) = Gl::current_pbuffer(16, 8);
    assert_eq!(ints(&mut g, GL_VIEWPORT), [0, 0, 16, 8]);
    // Negative sizes are refused; large ones clamped (§2.12.1).
    viewport(&mut g, 1, 2, -1, 3);
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE);
    assert_eq!(ints(&mut g, GL_VIEWPORT), [0, 0, 16, 8], "the refused call changes nothing");
    viewport(&mut g, -5, 6, 100_000, 4097);
    assert_eq!(ints(&mut g, GL_VIEWPORT), [-5, 6, 4096, 4096]);
    // The same value again is not re-encoded.
    let queued = g.queued();
    viewport(&mut g, -5, 6, 4096, 4096);
    clear_color(&mut g, 0.0, 0.0, 0.0, 0.0);
    assert_eq!(g.queued(), queued);

    // A context first made current surfaceless keeps 0x0 (EGL 1.5 §3.7.3),
    // and a 0x0 pbuffer gives 0x0 as well.
    let mut g = Gl::current_surfaceless();
    assert_eq!(ints(&mut g, GL_VIEWPORT), [0, 0, 0, 0]);
    assert_eq!(ints(&mut g, GL_RED_BITS), [0], "no color buffer surfaceless");
    let (mut g, _) = Gl::current_pbuffer(0, 0);
    assert_eq!(ints(&mut g, GL_VIEWPORT), [0, 0, 0, 0]);
}

#[test]
fn state_set_surfaceless_is_encoded_at_bind() {
    let mut g = Gl::init();
    let (c, s) = (g.context(), g.pbuffer(4, 4));
    assert_eq!(g.make_current(NO_HANDLE, c), 1);
    viewport(&mut g, 1, 1, 2, 2);
    clear_color(&mut g, 1.0, 0.0, 0.0, 1.0);
    assert_eq!(g.queued(), 0, "nothing is encoded without a surface");
    assert_eq!(g.make_current(s, c), 1);
    assert_eq!(ints(&mut g, GL_VIEWPORT), [1, 1, 2, 2], "§3.7.3: only the first make-current sets it");
    flush(&mut g);
    let name = g.drv.surface(s).unwrap().name();
    assert_eq!(g.submits(), [(
        vec![
            Command::SurfaceCreate { surface: name, width: 4, height: 4 },
            Command::SurfaceBind { surface: name },
            Command::Viewport { x: 1, y: 1, w: 2, h: 2 },
            Command::ClearColor { r: 1.0, g: 0.0, b: 0.0, a: 1.0 },
        ],
        vec![],
    )]);
    assert!(!g.dev.log().iter().any(|c| matches!(c, Call::Wait { .. })), "glFlush does not wait");
}

#[test]
fn first_error_sticks() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    clear(&mut g, 0x1);
    viewport(&mut g, 0, 0, -1, -1);
    assert!(get_string(&mut g, 0).is_none());
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE, "the first error");
    assert_eq!(get_error(&mut g), GL_NO_ERROR, "and only it");
}

#[test]
fn clear_surfaceless_invalid_framebuffer_operation() {
    let mut g = Gl::current_surfaceless();
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    assert_eq!(get_error(&mut g), GL_INVALID_FRAMEBUFFER_OPERATION);
    assert_eq!(g.queued(), 0);
    flush(&mut g);
    finish(&mut g);
    assert!(g.submits().is_empty(), "nothing encoded, nothing submitted");
    assert_eq!(g.waits, 0);
}

#[test]
fn clear_bad_mask_invalid_value() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let queued = g.queued();
    for mask in [0x1, 0x8000, GL_COLOR_BUFFER_BIT | 0x2] {
        clear(&mut g, mask);
        assert_eq!(get_error(&mut g), GL_INVALID_VALUE, "{mask:#x}");
    }
    assert_eq!(g.queued(), queued);
    clear(&mut g, GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    assert_eq!(g.queued(), queued + RECORD_HEADER_SIZE + 4);
}

#[test]
fn read_pixels_negative_invalid_value() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let mut pixels = vec![0u8; 64];
    let calls = g.dev.calls();
    read(&mut g, 0, 0, -1, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE);
    read(&mut g, 0, 0, 4, -1, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE);
    assert_eq!(g.dev.calls(), calls);
}

#[test]
fn read_pixels_bad_format_invalid_operation() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let mut pixels = vec![0u8; 64];
    let calls = g.dev.calls();
    // Allowable enums in an unsupported pair (§4.3.1).
    for (format, type_) in [
        (GL_RGB, GL_UNSIGNED_BYTE),
        (GL_RGBA, GL_UNSIGNED_SHORT_4_4_4_4),
        (GL_LUMINANCE, GL_UNSIGNED_BYTE),
        (GL_RGB, GL_UNSIGNED_SHORT_5_6_5),
    ] {
        read(&mut g, 0, 0, 4, 4, format, type_, &mut pixels);
        assert_eq!(get_error(&mut g), GL_INVALID_OPERATION, "{format:#x} {type_:#x}");
    }
    // Not allowable for ReadPixels at all (§2.5).
    for (format, type_) in [(GL_RGBA, 0x1406), (0x1234, GL_UNSIGNED_BYTE), (GL_DEPTH_BITS, GL_UNSIGNED_BYTE)] {
        read(&mut g, 0, 0, 4, 4, format, type_, &mut pixels);
        assert_eq!(get_error(&mut g), GL_INVALID_ENUM, "{format:#x} {type_:#x}");
    }
    assert_eq!(g.dev.calls(), calls);
    // Surfaceless: the framebuffer is incomplete (§4.4.5).
    let mut g = Gl::current_surfaceless();
    let calls = g.dev.calls();
    read(&mut g, 0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert_eq!(get_error(&mut g), GL_INVALID_FRAMEBUFFER_OPERATION);
    assert_eq!(g.dev.calls(), calls);
}

#[test]
fn read_pixels_zero_area_no_submit() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let calls = g.dev.calls();
    let mut pixels = vec![0u8; 64];
    read(&mut g, 0, 0, 0, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    read(&mut g, 0, 0, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, &mut []);
    // Entirely outside the surface: nothing to read, the pixels stay.
    pixels.fill(0xAB);
    read(&mut g, 4, 0, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    read(&mut g, -4, -4, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert!(pixels.iter().all(|&b| b == 0xAB));
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    assert_eq!(g.dev.calls(), calls);
    // A 0x0 pbuffer has 1x1 storage, but the read clips to its EGL size.
    let (mut g, _) = Gl::current_pbuffer(0, 0);
    let calls = g.dev.calls();
    read(&mut g, 0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert_eq!((get_error(&mut g), g.dev.calls()), (GL_NO_ERROR, calls));
}

#[test]
fn read_pixels_partly_outside_reads_the_inside() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let mut pixels = vec![0xAB_u8; 3 * 2 * 4];
    // Columns 3..6 of rows -1..1: only (3, 0) is inside.
    read(&mut g, 3, -1, 3, 2, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    let (commands, buffers) = g.submits().pop().unwrap();
    assert_eq!(commands.last(), Some(&Command::ReadPixels { x: 3, y: 0, w: 1, h: 1, buffer: 0 }));
    assert_eq!(buffers.len(), 1);
    assert_eq!(buffers[0].len, 4);
    assert_ne!(buffers[0].addr, pixels.as_ptr() as usize as u64, "a staging buffer");
    // The staged pixel (zeros: the fake writes nothing) lands at row 1,
    // column 0; the rest stays.
    let mut expected = vec![0xAB_u8; 24];
    expected[12..16].fill(0);
    assert_eq!(pixels, expected);
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
}

#[test]
fn read_pixels_null_invalid_value() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let calls = g.dev.calls();
    read(&mut g, 0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, &mut []);
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE);
    // A range no wasm32 buffer can be: refused rather than handed on.
    let mut one = [0u8; 4];
    read(&mut g, 0, 0, 65536, 65536, GL_RGBA, GL_UNSIGNED_BYTE, &mut one);
    assert_eq!(get_error(&mut g), GL_INVALID_VALUE);
    assert_eq!(g.dev.calls(), calls);
}

#[test]
fn no_current_context_is_noop() {
    let mut g = Gl::init();
    assert_eq!(egl::current(), None);
    let calls = g.dev.calls();
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    assert_eq!(get_string(&mut g, GL_VENDOR), None);
    assert_eq!(get_string(&mut g, 0x1234), None);
    assert!(get(&mut g, "glGetIntegerv", GL_VIEWPORT).is_none());
    assert!(get(&mut g, "glGetIntegerv", GL_DEPTH_RANGE).is_none(), "no abort without a context");
    viewport(&mut g, 0, 0, -1, -1);
    clear_color(&mut g, 1.0, 1.0, 1.0, 1.0);
    clear(&mut g, 0xFFFF_FFFF);
    let mut pixels = [0xABu8; 4];
    read(&mut g, 0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    flush(&mut g);
    finish(&mut g);
    assert_eq!(pixels, [0xAB; 4]);
    assert_eq!((g.dev.calls(), g.waits), (calls, 0));
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    assert!(diags().is_empty());
}

#[test]
fn two_threads_errors_isolated() {
    let shared = Mutex::new(Gl::init());
    let (a, b, s) = {
        let mut g = shared.lock().unwrap();
        (g.context(), g.context(), g.pbuffer(8, 8))
    };
    assert_eq!(shared.lock().unwrap().make_current(s, a), 1);
    clear(&mut &shared, 0x1);
    viewport(&mut &shared, 1, 2, 3, 4);
    std::thread::scope(|scope| {
        let shared = &shared;
        scope
            .spawn(move || {
                assert_eq!(shared.lock().unwrap().make_current(NO_HANDLE, b), 1);
                assert_eq!(get_error(&mut &*shared), GL_NO_ERROR, "a's error is a's");
                assert_eq!(ints(&mut &*shared, GL_VIEWPORT), [0, 0, 0, 0], "and so is its viewport");
                clear(&mut &*shared, GL_COLOR_BUFFER_BIT);
                assert_eq!(get_error(&mut &*shared), GL_INVALID_FRAMEBUFFER_OPERATION);
                assert!(get_string(&mut &*shared, 7).is_none());
            })
            .join()
            .unwrap();
    });
    assert_eq!(get_error(&mut &shared), GL_INVALID_VALUE);
    assert_eq!(get_error(&mut &shared), GL_NO_ERROR, "b's INVALID_ENUM stayed b's");
    assert_eq!(ints(&mut &shared, GL_VIEWPORT), [1, 2, 3, 4]);
}

#[test]
fn eio_wait_loses_context() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    diags();
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    g.dev.fail_next(FakeOp::Wait, EIO);
    let mut pixels = vec![0xAB_u8; 64];
    read(&mut g, 0, 0, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    assert!(pixels.iter().all(|&b| b == 0xAB), "a lost read leaves the pixels");
    let calls = g.dev.calls();
    // Later GL calls do nothing.
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    clear(&mut g, 0x1);
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    read(&mut g, 0, 0, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, &mut pixels);
    flush(&mut g);
    finish(&mut g);
    assert_eq!(g.dev.calls(), calls, "nothing more reaches the device");
    let s = g.drv.get_current_surface(egl::EGL_DRAW);
    assert_eq!(g.drv.swap_buffers(&mut g.dev, DISPLAY, s), 0);
    assert_eq!(egl::thread::get_error(), egl::EGL_CONTEXT_LOST);
    assert_eq!(g.dev.calls(), calls);
    assert_eq!(diags(), ["kandelo-gl: glReadPixels: GPU context lost\n"], "exactly one diagnostic");
}

#[test]
fn unexpected_wait_errors_are_loud() {
    // ETIMEDOUT cannot happen with an infinite timeout, so it is a defect.
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    diags();
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    g.dev.fail_next(FakeOp::Wait, -110);
    finish(&mut g);
    assert_eq!(diags(), ["kandelo-gl: glFinish: kgpu wait failed: ETIMEDOUT\n"]);
    let calls = g.dev.calls();
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    flush(&mut g);
    assert_eq!(g.dev.calls(), calls, "the context is lost");
}

#[test]
fn finish_waits_for_the_last_submission() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    flush(&mut g);
    // Nothing new is queued: finish waits for the flushed submission.
    finish(&mut g);
    assert_eq!(g.dev.log().last(), Some(&Call::Wait { context: 2, seqno: 1, timeout_ns: -1 }));
    assert_eq!((g.submits().len(), g.waits), (1, 1));
    // A context that never submitted has nothing to wait for.
    let mut g = Gl::current_surfaceless();
    finish(&mut g);
    assert_eq!(g.waits, 0);
}

#[test]
fn stream_auto_flushes_before_1mib() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    const CLEARS: usize = 100_000;
    for _ in 0..CLEARS {
        clear(&mut g, GL_COLOR_BUFFER_BIT);
    }
    flush(&mut g);
    let submits = g.submits();
    assert_eq!(submits.len(), 2);
    let size = |commands: &[Command]| {
        STREAM_HEADER_SIZE
            + commands
                .iter()
                .map(|c| {
                    RECORD_HEADER_SIZE
                        + match c {
                            Command::SurfaceCreate { .. } => 12,
                            Command::Viewport { .. } | Command::ClearColor { .. } => 16,
                            Command::ReadPixels { .. } => 20,
                            _ => 4,
                        }
                })
                .sum::<usize>()
    };
    let first = size(&submits[0].0);
    assert!(first <= KGPU_MAX_STREAM as usize, "{first}");
    assert!(first + RECORD_HEADER_SIZE + 4 > KGPU_MAX_STREAM as usize, "it flushed only when full: {first}");
    let clears = submits.iter().flat_map(|(c, _)| c).filter(|c| matches!(c, Command::Clear { .. })).count();
    assert_eq!(clears, CLEARS, "no record lost at the boundary");
    assert!(!g.dev.log().iter().any(|c| matches!(c, Call::Wait { .. })));
}

#[test]
fn a_failed_auto_flush_loses_the_context() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    diags();
    g.dev.fail_next(FakeOp::Submit, EIO);
    let mut n = 0;
    while g.submits().is_empty() {
        clear(&mut g, GL_COLOR_BUFFER_BIT);
        n += 1;
    }
    let calls = g.dev.calls();
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    finish(&mut g);
    assert_eq!(g.dev.calls(), calls);
    assert!(n > 80_000);
    assert_eq!(diags(), ["kandelo-gl: glClear: GPU context lost\n"]);
}

#[test]
#[should_panic(expected = "glGetIntegerv 0x0b21 not implemented")]
fn unmodeled_valid_pname_aborts() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    let _ = get(&mut g, "glGetIntegerv", GL_LINE_WIDTH);
}

#[test]
fn every_unmodeled_pname_is_a_valid_one() {
    // A pname is modeled or unmodeled, never both, and every one is a GLES
    // 2.0 token (checked against gl2.h below).
    for p in state::UNMODELED_PNAMES {
        assert!(!state::MODELED_PNAMES.contains(p), "{p:#x}");
        assert!(HEADER_TOKENS.iter().any(|&(_, v)| v == *p), "{p:#x}");
    }
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    for p in state::UNMODELED_PNAMES {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| get(&mut g, "glGetFloatv", *p)));
        assert!(r.is_err(), "{p:#x} must not be answered");
    }
    let lines = diags();
    assert_eq!(lines.len(), state::UNMODELED_PNAMES.len());
    assert_eq!(lines[0], format!("kandelo-gl: glGetFloatv {:#06x} not implemented\n", state::UNMODELED_PNAMES[0]));
}

#[test]
fn gl_functions_are_in_get_proc_address() {
    for name in [
        "glGetError", "glGetString", "glGetBooleanv", "glGetIntegerv", "glGetFloatv", "glViewport",
        "glClearColor", "glClear", "glReadPixels", "glFlush", "glFinish",
    ] {
        assert!(egl::get_proc_address(name.as_bytes()).is_some(), "{name}");
    }
    let clear = egl::get_proc_address(b"glClear").unwrap();
    assert_eq!(clear as usize, glClear as *const () as usize);
    assert!(egl::get_proc_address(b"glDrawArrays").is_none());
}

#[test]
fn tokens_match_the_gles2_header() {
    let header = include_str!("../../../../libc/musl-overlay/include/GLES2/gl2.h");
    let defined = |name: &str| -> Option<u32> {
        header.lines().find_map(|line| {
            let mut words = line.split_whitespace();
            if words.next() == Some("#define") && words.next() == Some(name) {
                let v = words.next()?;
                Some(match v.strip_prefix("0x") {
                    Some(hex) => u32::from_str_radix(hex, 16).unwrap(),
                    None => v.parse().unwrap(),
                })
            } else {
                None
            }
        })
    };
    for &(name, value) in HEADER_TOKENS {
        assert_eq!(defined(name), Some(value), "{name}");
    }
    assert_eq!(defined("GL_TRUE"), Some(u32::from(GL_TRUE)));
    assert_eq!(defined("GL_FALSE"), Some(u32::from(GL_FALSE)));
}

#[test]
fn fork_child_drops_state_without_destroys() {
    let lock = egl::thread::DriverLock::new(Gl::init().drv);
    let mut dev = FakeDevice::new();
    let (c, s);
    {
        let mut drv = lock.lock();
        let config = {
            let (mut configs, mut n) = ([0usize; 1], 0);
            drv.choose_config(DISPLAY, &PBUFFER_ES2, Some(&mut configs), Some(&mut n));
            configs[0]
        };
        c = drv.create_context(&mut dev, DISPLAY, config, NO_HANDLE, &ES2);
        s = drv.create_pbuffer_surface(DISPLAY, config, &[egl::EGL_WIDTH, 4, egl::EGL_HEIGHT, 4, egl::EGL_NONE]);
        assert_eq!(drv.make_current(&mut dev, DISPLAY, s, s, c), 1);
    }
    assert!(egl::current().is_some());
    let calls = dev.calls();
    // Another parent thread held the lock at the fork.
    core::mem::forget(lock.lock());
    egl::fork_child_reset_for_test(&lock);
    // The lock is free and the state forgotten, with no kgpu call: the
    // parent's contexts are not the child's.
    let mut drv = lock.lock();
    assert_eq!(egl::current(), None);
    assert_eq!(drv.get_current_context(), NO_HANDLE);
    let mut v = 0;
    assert_eq!(drv.query_surface(DISPLAY, s, egl::EGL_WIDTH, Some(&mut v)), 0);
    assert_eq!(egl::thread::get_error(), egl::EGL_NOT_INITIALIZED);
    assert_eq!(dev.calls(), calls);
    // The child may initialize anew; old handles name nothing.
    assert_eq!(drv.initialize(&mut dev, DISPLAY, None, None), 1);
    assert_eq!(drv.make_current(&mut dev, DISPLAY, s, s, c), 0);
    assert_eq!(egl::thread::get_error(), egl::EGL_BAD_CONTEXT);
    assert!(!dev.log().iter().any(|call| matches!(call, Call::ContextDestroy { context: 1 })));
    drop(drv);
    // And a child whose lock was free drops its state the same way.
    egl::fork_child_reset_for_test(&lock);
    assert!(!lock.lock().initialized_for_test());
}

#[test]
fn gl_calls_in_a_fork_child_are_noops() {
    let (mut g, _) = Gl::current_pbuffer(4, 4);
    clear(&mut g, 0x1);
    let lock = egl::thread::DriverLock::new(Driver::new());
    egl::fork_child_reset_for_test(&lock);
    // The child thread's record is gone: no current context.
    let calls = g.dev.calls();
    assert_eq!(get_error(&mut g), GL_NO_ERROR);
    clear(&mut g, GL_COLOR_BUFFER_BIT);
    finish(&mut g);
    assert_eq!(g.dev.calls(), calls);
}
