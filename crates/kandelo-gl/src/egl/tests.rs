//! The EGL model over `FakeDevice`: every expectation is EGL 1.5's, or a
//! skeleton limit the plan documents.

use super::*;
use crate::kgpu::{Call, FakeDevice, FakeOp};
use kgpu_stream::Command;
use std::sync::{Arc, Mutex};
use std::vec::Vec;

const T: EGLBoolean = EGL_TRUE as EGLBoolean;
const F: EGLBoolean = EGL_FALSE as EGLBoolean;
const PBUFFER_ES2: [EGLint; 5] = [EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE];
const ES2: [EGLint; 3] = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];

struct Egl {
    drv: Driver,
    dev: FakeDevice,
}

impl Egl {
    fn new() -> Self {
        Self { drv: Driver::new(), dev: FakeDevice::new() }
    }

    fn init() -> Self {
        let mut e = Self::new();
        assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, None, None), T);
        e
    }

    fn config(&mut self) -> usize {
        let (mut configs, mut n) = ([0usize; 4], 0);
        assert_eq!(self.drv.choose_config(DISPLAY, &PBUFFER_ES2, Some(&mut configs), Some(&mut n)), T);
        assert_eq!(n, 1);
        configs[0]
    }

    fn pbuffer(&mut self, width: EGLint, height: EGLint) -> usize {
        let config = self.config();
        let s = self.drv.create_pbuffer_surface(DISPLAY, config, &[EGL_WIDTH, width, EGL_HEIGHT, height, EGL_NONE]);
        assert_ne!(s, NO_HANDLE, "error {:#x}", error());
        s
    }

    fn context(&mut self) -> usize {
        let config = self.config();
        let c = self.drv.create_context(&mut self.dev, DISPLAY, config, NO_HANDLE, &ES2);
        assert_ne!(c, NO_HANDLE, "error {:#x}", error());
        c
    }

    fn make_current(&mut self, surface: usize, context: usize) -> EGLBoolean {
        self.drv.make_current(&mut self.dev, DISPLAY, surface, surface, context)
    }

    fn release(&mut self) -> EGLBoolean {
        self.make_current(NO_HANDLE, NO_HANDLE)
    }

    fn submits(&self) -> Vec<Vec<Command>> {
        self.dev
            .log()
            .iter()
            .filter_map(|c| match c {
                Call::Submit { commands, .. } => Some(commands.clone()),
                _ => None,
            })
            .collect()
    }
}

fn error() -> EGLint {
    thread::get_error()
}

#[test]
fn initialize_reports_1_5() {
    let mut e = Egl::new();
    let (mut major, mut minor) = (0, 0);
    assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, Some(&mut major), Some(&mut minor)), T);
    assert_eq!((major, minor, error()), (1, 5, EGL_SUCCESS));
    // The probe creates and destroys one kgpu context.
    assert_eq!(e.dev.log(), [Call::ContextCreate, Call::ContextDestroy { context: 1 }]);
    // A repeat call only reports the version again.
    let (mut major, mut minor) = (0, 0);
    assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, Some(&mut major), Some(&mut minor)), T);
    assert_eq!((major, minor), (1, 5));
    assert_eq!(e.dev.calls(), 2);
    // Any handle but the display is EGL_BAD_DISPLAY.
    assert_eq!(e.drv.initialize(&mut e.dev, 7, None, None), F);
    assert_eq!(error(), EGL_BAD_DISPLAY);
}

#[test]
fn initialize_without_renderer_is_not_initialized() {
    // -ENODEV (no renderer) and -EOPNOTSUPP (outside a memory group) are
    // quiet; -EINVAL is a driver defect, reported, with the same answer.
    for errno in [-19, -95, -22] {
        let mut e = Egl::new();
        e.dev.fail_next(FakeOp::ContextCreate, errno);
        let mut major = -7;
        assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, Some(&mut major), None), F);
        assert_eq!(error(), EGL_NOT_INITIALIZED);
        assert_eq!(major, -7, "major is not updated on failure");
        assert_eq!(e.drv.query_string(DISPLAY, EGL_VENDOR), None);
        assert_eq!(error(), EGL_NOT_INITIALIZED);
        let mut n = 0;
        assert_eq!(e.drv.get_configs(DISPLAY, None, Some(&mut n)), F);
        assert_eq!(error(), EGL_NOT_INITIALIZED);
        assert_eq!(e.dev.log(), [Call::ContextCreate]);
    }
}

#[test]
fn query_strings_exact() {
    let mut e = Egl::new();
    let q = |e: &mut Egl, dpy, name| e.drv.query_string(dpy, name).map(|s| s.to_str().unwrap());
    // Client strings, before any initialization.
    assert_eq!(q(&mut e, NO_HANDLE, EGL_EXTENSIONS), Some("EGL_EXT_client_extensions EGL_MESA_platform_surfaceless"));
    assert_eq!(q(&mut e, NO_HANDLE, EGL_VERSION), Some("1.5 kandelo-gl"));
    assert_eq!(q(&mut e, NO_HANDLE, EGL_VENDOR), None);
    assert_eq!(error(), EGL_BAD_DISPLAY);
    assert_eq!(q(&mut e, DISPLAY, EGL_VENDOR), None);
    assert_eq!(error(), EGL_NOT_INITIALIZED);
    let mut e = Egl::init();
    assert_eq!(q(&mut e, DISPLAY, EGL_VENDOR), Some("Kandelo"));
    assert_eq!(q(&mut e, DISPLAY, EGL_VERSION), Some("1.5 kandelo-gl"));
    assert_eq!(q(&mut e, DISPLAY, EGL_CLIENT_APIS), Some("OpenGL_ES"));
    assert_eq!(q(&mut e, DISPLAY, EGL_EXTENSIONS), Some("EGL_KHR_surfaceless_context EGL_KHR_no_config_context"));
    assert_eq!(error(), EGL_SUCCESS);
    assert_eq!(q(&mut e, DISPLAY, EGL_WIDTH), None);
    assert_eq!(error(), EGL_BAD_PARAMETER);
}

#[test]
fn displays_are_the_one_surfaceless_display() {
    let mut e = Egl::new();
    assert_eq!(e.drv.get_display(NO_HANDLE), DISPLAY);
    assert_eq!(e.drv.get_platform_display(EGL_PLATFORM_SURFACELESS_MESA as EGLenum, NO_HANDLE, &[]), DISPLAY);
    assert_eq!(
        e.drv.get_platform_display(EGL_PLATFORM_SURFACELESS_MESA as EGLenum, NO_HANDLE, &[EGL_NONE as EGLAttrib]),
        DISPLAY
    );
    // Another native display is unavailable: no display and no error.
    assert_eq!(e.drv.get_display(0x1234), NO_HANDLE);
    assert_eq!(error(), EGL_SUCCESS);
    // GBM (0x31D7) and any other platform are invalid here.
    assert_eq!(e.drv.get_platform_display(0x31D7, NO_HANDLE, &[]), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_PARAMETER);
    assert_eq!(e.drv.get_platform_display(EGL_PLATFORM_SURFACELESS_MESA as EGLenum, 0x1234, &[]), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_PARAMETER);
    assert_eq!(
        e.drv.get_platform_display(EGL_PLATFORM_SURFACELESS_MESA as EGLenum, NO_HANDLE, &[0x3100, 1, EGL_NONE as EGLAttrib]),
        NO_HANDLE
    );
    assert_eq!(error(), EGL_BAD_ATTRIBUTE);
}

#[test]
fn one_config_with_exact_attribs() {
    let mut e = Egl::init();
    let mut n = 0;
    assert_eq!(e.drv.get_configs(DISPLAY, None, Some(&mut n)), T);
    assert_eq!(n, 1);
    let mut configs = [0usize; 4];
    assert_eq!(e.drv.get_configs(DISPLAY, Some(&mut configs), Some(&mut n)), T);
    assert_eq!(n, 1);
    let config = configs[0];
    assert_ne!(config, NO_HANDLE);
    assert_eq!(e.drv.get_configs(DISPLAY, Some(&mut configs), None), F);
    assert_eq!(error(), EGL_BAD_PARAMETER);
    let expected = [
        (EGL_BUFFER_SIZE, 32),
        (EGL_RED_SIZE, 8),
        (EGL_GREEN_SIZE, 8),
        (EGL_BLUE_SIZE, 8),
        (EGL_ALPHA_SIZE, 8),
        (EGL_LUMINANCE_SIZE, 0),
        (EGL_ALPHA_MASK_SIZE, 0),
        (EGL_DEPTH_SIZE, 0),
        (EGL_STENCIL_SIZE, 0),
        (EGL_SAMPLES, 0),
        (EGL_SAMPLE_BUFFERS, 0),
        (EGL_CONFIG_ID, 1),
        (EGL_SURFACE_TYPE, EGL_PBUFFER_BIT),
        (EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT),
        (EGL_CONFORMANT, EGL_OPENGL_ES2_BIT),
        (EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER),
        (EGL_CONFIG_CAVEAT, EGL_NONE),
        (EGL_MAX_PBUFFER_WIDTH, 4096),
        (EGL_MAX_PBUFFER_HEIGHT, 4096),
        (EGL_MAX_PBUFFER_PIXELS, 4096 * 4096),
        (EGL_MIN_SWAP_INTERVAL, 0),
        (EGL_MAX_SWAP_INTERVAL, 1),
        (EGL_BIND_TO_TEXTURE_RGB, EGL_FALSE),
        (EGL_BIND_TO_TEXTURE_RGBA, EGL_FALSE),
        (EGL_LEVEL, 0),
        (EGL_NATIVE_RENDERABLE, EGL_FALSE),
        (EGL_NATIVE_VISUAL_ID, 0),
        (EGL_NATIVE_VISUAL_TYPE, EGL_NONE),
        (EGL_TRANSPARENT_TYPE, EGL_NONE),
    ];
    for (attribute, want) in expected {
        let mut v = -99;
        assert_eq!(e.drv.get_config_attrib(DISPLAY, config, attribute, Some(&mut v)), T, "{attribute:#x}");
        assert_eq!(v, want, "{attribute:#x}");
    }
    let mut v = -99;
    // EGL_MATCH_NATIVE_PIXMAP is selection-only (§3.4.3).
    assert_eq!(e.drv.get_config_attrib(DISPLAY, config, EGL_MATCH_NATIVE_PIXMAP, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_ATTRIBUTE);
    assert_eq!(e.drv.get_config_attrib(DISPLAY, config + 4, EGL_RED_SIZE, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_CONFIG);
    assert_eq!(v, -99);
}

#[test]
fn choose_config_rejects_depth_request() {
    let mut e = Egl::init();
    let choose = |e: &mut Egl, attribs: &[EGLint]| {
        let (mut configs, mut n) = ([0usize; 2], -1);
        let r = e.drv.choose_config(DISPLAY, attribs, Some(&mut configs), Some(&mut n));
        (r, n)
    };
    let with = |extra: &[EGLint]| -> Vec<EGLint> {
        let mut list = PBUFFER_ES2[..4].to_vec();
        list.extend_from_slice(extra);
        list.push(EGL_NONE);
        list
    };
    assert_eq!(choose(&mut e, &with(&[EGL_DEPTH_SIZE, 1])), (T, 0));
    assert_eq!(choose(&mut e, &with(&[EGL_STENCIL_SIZE, 1])), (T, 0));
    assert_eq!(choose(&mut e, &with(&[EGL_SAMPLE_BUFFERS, 1])), (T, 0));
    assert_eq!(choose(&mut e, &with(&[EGL_RED_SIZE, 8, EGL_ALPHA_SIZE, 8])), (T, 1));
    assert_eq!(choose(&mut e, &with(&[EGL_RED_SIZE, 9])), (T, 0));
    assert_eq!(choose(&mut e, &with(&[EGL_DEPTH_SIZE, EGL_DONT_CARE])), (T, 1));
    // The Table 3.4 defaults ask for a window (EGL_SURFACE_TYPE) and
    // OpenGL ES 1.x (EGL_RENDERABLE_TYPE): the config offers neither.
    assert_eq!(choose(&mut e, &[EGL_NONE]), (T, 0));
    assert_eq!(choose(&mut e, &[EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE]), (T, 0));
    assert_eq!(choose(&mut e, &[EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE]), (T, 0));
    // EGL_CONFIG_ID overrides every other attribute.
    assert_eq!(choose(&mut e, &[EGL_CONFIG_ID, 1, EGL_DEPTH_SIZE, 24, EGL_NONE]), (T, 1));
    assert_eq!(choose(&mut e, &[EGL_CONFIG_ID, 2, EGL_NONE]), (T, 0));
    // Ignored attributes still need their value.
    assert_eq!(choose(&mut e, &with(&[EGL_MAX_PBUFFER_WIDTH, 99999])), (T, 1));
    assert_eq!(choose(&mut e, &with(&[EGL_TRANSPARENT_RED_VALUE, 5])), (T, 1));
    // Unknown attributes and unrecognized values.
    for bad in [
        &[0x1234, 0][..],
        &[EGL_LEVEL, EGL_DONT_CARE],
        &[EGL_DEPTH_SIZE, -2],
        &[EGL_SURFACE_TYPE, 0x10_0000],
        &[EGL_COLOR_BUFFER_TYPE, 5],
        &[EGL_MATCH_NATIVE_PIXMAP, 0x1000],
        &[EGL_RED_SIZE],
    ] {
        let mut list = bad.to_vec();
        if bad.len() == 2 {
            list.push(EGL_NONE);
        }
        assert_eq!(choose(&mut e, &list).0, F, "{bad:x?}");
        assert_eq!(error(), EGL_BAD_ATTRIBUTE);
    }
    // configs = NULL counts.
    let mut n = 0;
    assert_eq!(e.drv.choose_config(DISPLAY, &PBUFFER_ES2, None, Some(&mut n)), T);
    assert_eq!(n, 1);
}

#[test]
fn es1_and_es3_contexts_bad_match() {
    let mut e = Egl::init();
    let config = e.config();
    let calls = e.dev.calls();
    for attribs in [
        &[EGL_NONE][..],
        &[EGL_CONTEXT_CLIENT_VERSION, 1, EGL_NONE],
        &[EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE],
        &[EGL_CONTEXT_MAJOR_VERSION, 2, EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE],
        &[EGL_CONTEXT_MAJOR_VERSION, 2, EGL_CONTEXT_OPENGL_ROBUST_ACCESS, EGL_TRUE, EGL_NONE],
    ] {
        assert_eq!(e.drv.create_context(&mut e.dev, DISPLAY, config, NO_HANDLE, attribs), NO_HANDLE);
        assert_eq!(error(), EGL_BAD_MATCH, "{attribs:x?}");
    }
    // OpenGL-only attributes are not ES attributes.
    let gl = [EGL_CONTEXT_MAJOR_VERSION, 2, EGL_CONTEXT_OPENGL_PROFILE_MASK, 1, EGL_NONE];
    assert_eq!(e.drv.create_context(&mut e.dev, DISPLAY, config, NO_HANDLE, &gl), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_ATTRIBUTE);
    assert_eq!(e.dev.calls(), calls, "a refused context makes no kgpu call");
    // ES 2.0 by either name, with a config or with EGL_NO_CONFIG_KHR.
    let c = e.drv.create_context(&mut e.dev, DISPLAY, config, NO_HANDLE, &ES2);
    assert_ne!(c, NO_HANDLE);
    let attribs = [EGL_CONTEXT_MAJOR_VERSION, 2, EGL_CONTEXT_MINOR_VERSION, 0, EGL_CONTEXT_OPENGL_DEBUG, EGL_TRUE, EGL_NONE];
    let nc = e.drv.create_context(&mut e.dev, DISPLAY, NO_HANDLE, NO_HANDLE, &attribs);
    assert_ne!(nc, NO_HANDLE);
    assert_eq!(e.dev.log()[calls..], [Call::ContextCreate, Call::ContextCreate]);
    let mut v = -1;
    assert_eq!(e.drv.query_context(DISPLAY, nc, EGL_CONFIG_ID, Some(&mut v)), T);
    assert_eq!(v, 0);
    assert_eq!(e.drv.query_context(DISPLAY, c, EGL_CONFIG_ID, Some(&mut v)), T);
    assert_eq!(v, 1);
    assert_eq!(e.drv.query_context(DISPLAY, c, EGL_CONTEXT_CLIENT_VERSION, Some(&mut v)), T);
    assert_eq!(v, 2);
    assert_eq!(e.drv.query_context(DISPLAY, c, EGL_CONTEXT_CLIENT_TYPE, Some(&mut v)), T);
    assert_eq!(v, EGL_OPENGL_ES_API);
    // Only OpenGL ES can be bound.
    for api in [EGL_OPENGL_API, EGL_OPENVG_API, 0x1234] {
        assert_eq!(thread::bind_api(api as EGLenum), F);
        assert_eq!(error(), EGL_BAD_PARAMETER);
    }
    assert_eq!(thread::query_api(), EGL_OPENGL_ES_API as EGLenum);
    assert_eq!(thread::bind_api(EGL_OPENGL_ES_API as EGLenum), T);
}

#[test]
fn share_context_bad_match() {
    let mut e = Egl::init();
    let config = e.config();
    let a = e.context();
    let calls = e.dev.calls();
    assert_eq!(e.drv.create_context(&mut e.dev, DISPLAY, config, a, &ES2), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_MATCH);
    // A share context that is not a context at all is EGL_BAD_CONTEXT.
    assert_eq!(e.drv.create_context(&mut e.dev, DISPLAY, config, a + 4, &ES2), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert_eq!(e.dev.calls(), calls);
}

#[test]
fn pbuffer_bounds() {
    let mut e = Egl::init();
    let config = e.config();
    let size = |e: &mut Egl, s| {
        let (mut w, mut h) = (-1, -1);
        assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_WIDTH, Some(&mut w)), T);
        assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_HEIGHT, Some(&mut h)), T);
        (w, h)
    };
    let create = |e: &mut Egl, attribs: &[EGLint]| e.drv.create_pbuffer_surface(DISPLAY, config, attribs);
    let calls = e.dev.calls();
    for (attribs, want) in [
        (&[EGL_WIDTH, -1, EGL_HEIGHT, 8, EGL_NONE][..], EGL_BAD_PARAMETER),
        (&[EGL_WIDTH, 8, EGL_HEIGHT, -1, EGL_NONE], EGL_BAD_PARAMETER),
        // Larger than the executor can allocate.
        (&[EGL_WIDTH, 4097, EGL_HEIGHT, 8, EGL_NONE], EGL_BAD_ALLOC),
        (&[EGL_WIDTH, 8, EGL_HEIGHT, 4097, EGL_NONE], EGL_BAD_ALLOC),
        // The config binds to no texture.
        (&[EGL_TEXTURE_FORMAT, EGL_TEXTURE_RGBA, EGL_TEXTURE_TARGET, EGL_TEXTURE_2D, EGL_NONE], EGL_BAD_MATCH),
        (&[EGL_TEXTURE_FORMAT, EGL_TEXTURE_RGB, EGL_NONE], EGL_BAD_MATCH),
        (&[EGL_TEXTURE_TARGET, EGL_TEXTURE_2D, EGL_NONE], EGL_BAD_MATCH),
        (&[EGL_TEXTURE_FORMAT, 0x1234, EGL_NONE], EGL_BAD_ATTRIBUTE),
        (&[EGL_VG_ALPHA_FORMAT, EGL_VG_ALPHA_FORMAT_PRE, EGL_NONE], EGL_BAD_MATCH),
        (&[EGL_VG_COLORSPACE, EGL_VG_COLORSPACE_LINEAR, EGL_NONE], EGL_BAD_MATCH),
        (&[EGL_RENDER_BUFFER, EGL_BACK_BUFFER, EGL_NONE], EGL_BAD_ATTRIBUTE),
    ] {
        assert_eq!(create(&mut e, attribs), NO_HANDLE, "{attribs:x?}");
        assert_eq!(error(), want, "{attribs:x?}");
    }
    assert_eq!(e.drv.create_pbuffer_surface(DISPLAY, config + 4, &[EGL_NONE]), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_CONFIG);
    // EGL 1.5 §3.5.2: the default size is 0x0, and it is valid.
    let s = create(&mut e, &[EGL_NONE]);
    assert_ne!(s, NO_HANDLE);
    assert_eq!(size(&mut e, s), (0, 0));
    let s = create(&mut e, &[EGL_WIDTH, 4096, EGL_HEIGHT, 4096, EGL_TEXTURE_FORMAT, EGL_NO_TEXTURE, EGL_NONE]);
    assert_eq!(size(&mut e, s), (4096, 4096));
    // EGL_LARGEST_PBUFFER clamps to the largest pbuffer, never beyond the
    // request.
    let s = create(&mut e, &[EGL_WIDTH, 5000, EGL_HEIGHT, 7, EGL_LARGEST_PBUFFER, EGL_TRUE, EGL_NONE]);
    assert_eq!(size(&mut e, s), (4096, 7));
    let mut v = 0;
    assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_LARGEST_PBUFFER, Some(&mut v)), T);
    assert_eq!(v, EGL_TRUE);
    for (attribute, want) in [
        (EGL_CONFIG_ID, 1),
        (EGL_RENDER_BUFFER, EGL_BACK_BUFFER),
        (EGL_TEXTURE_FORMAT, EGL_NO_TEXTURE),
        (EGL_TEXTURE_TARGET, EGL_NO_TEXTURE),
        (EGL_HORIZONTAL_RESOLUTION, EGL_UNKNOWN),
        (EGL_PIXEL_ASPECT_RATIO, EGL_UNKNOWN),
        (EGL_SWAP_BEHAVIOR, EGL_BUFFER_PRESERVED),
        (EGL_GL_COLORSPACE, EGL_GL_COLORSPACE_LINEAR),
    ] {
        assert_eq!(e.drv.query_surface(DISPLAY, s, attribute, Some(&mut v)), T, "{attribute:#x}");
        assert_eq!(v, want, "{attribute:#x}");
    }
    assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_RED_SIZE, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_ATTRIBUTE);
    assert_eq!(e.dev.calls(), calls, "creating a pbuffer makes no kgpu call");
}

#[test]
fn make_current_surfaceless_ok() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(NO_HANDLE, c), T);
    assert_eq!(e.drv.get_current_context(), c);
    assert_eq!(e.drv.get_current_surface(EGL_DRAW), NO_HANDLE);
    assert_eq!(e.drv.get_current_display(), DISPLAY);
    let (_, r) = current().expect("current");
    assert_eq!(r.kgpu_context(), 2, "the probe used kgpu context 1");
    assert_eq!(e.drv.context_mut(r).unwrap().first_bind, Some((0, 0)));
    let mut v = 0;
    assert_eq!(e.drv.query_context(DISPLAY, c, EGL_RENDER_BUFFER, Some(&mut v)), T);
    assert_eq!(v, EGL_NONE);
    // One surface without the other, or two different surfaces.
    let s2 = e.pbuffer(4, 4);
    assert_eq!(e.drv.make_current(&mut e.dev, DISPLAY, s, NO_HANDLE, c), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    assert_eq!(e.drv.make_current(&mut e.dev, DISPLAY, s, s2, c), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    // A surface with no context, an invalid surface or context.
    assert_eq!(e.drv.make_current(&mut e.dev, DISPLAY, s, s, NO_HANDLE), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    assert_eq!(e.make_current(s2 + 400, c), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.make_current(NO_HANDLE, c + 4), F);
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert_eq!(e.drv.get_current_context(), c, "failed calls leave the binding");
    // Nothing reached the executor: surfaceless needs no storage.
    assert!(e.submits().is_empty());
    assert_eq!(e.release(), T);
    assert_eq!(e.drv.get_current_context(), NO_HANDLE);
    assert_eq!(current(), None);
}

#[test]
fn first_bind_gives_the_surface_size_once() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(16, 8);
    let s2 = e.pbuffer(3, 2);
    assert_eq!(e.make_current(s, c), T);
    let (_, r) = current().unwrap();
    assert_eq!(e.drv.context_mut(r).unwrap().first_bind, Some((16, 8)));
    assert_eq!(e.make_current(s2, c), T);
    assert_eq!(e.drv.context_mut(r).unwrap().first_bind, Some((16, 8)), "§3.7.3: only the first time");
    assert_eq!(e.drv.get_current_surface(EGL_READ), s2);
    assert_eq!(e.drv.get_current_surface(0x1234), NO_HANDLE);
    assert_eq!(error(), EGL_BAD_PARAMETER);
    assert_eq!(e.release(), T);
    let (n, n2) = (e.drv.surface(s).unwrap().name(), e.drv.surface(s2).unwrap().name());
    assert_eq!(e.submits(), [vec![
        Command::SurfaceCreate { surface: n, width: 16, height: 8 },
        Command::SurfaceBind { surface: n },
        Command::SurfaceCreate { surface: n2, width: 3, height: 2 },
        Command::SurfaceBind { surface: n2 },
    ]]);
}

#[test]
fn surface_current_on_two_threads_bad_access() {
    let shared = Arc::new(Mutex::new(Egl::init()));
    let (a, b, s) = {
        let mut e = shared.lock().unwrap();
        (e.context(), e.context(), e.pbuffer(4, 4))
    };
    assert_eq!(shared.lock().unwrap().make_current(s, a), T);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut e = shared.lock().unwrap();
            // The surface is current on the first thread, and so is a.
            assert_eq!(e.make_current(s, b), F);
            assert_eq!(error(), EGL_BAD_ACCESS);
            assert_eq!(e.make_current(NO_HANDLE, a), F);
            assert_eq!(error(), EGL_BAD_ACCESS);
            // This thread has nothing current.
            assert_eq!(e.drv.get_current_context(), NO_HANDLE);
            assert_eq!(e.make_current(NO_HANDLE, b), T);
            assert_eq!(e.drv.get_current_context(), b);
        });
    });
    let mut e = shared.lock().unwrap();
    assert_eq!(e.drv.get_current_context(), a);
    assert_eq!(e.drv.get_current_surface(EGL_DRAW), s);
}

#[test]
fn per_thread_error_isolated() {
    let shared = Arc::new(Mutex::new(Egl::init()));
    {
        let mut e = shared.lock().unwrap();
        assert_eq!(e.drv.query_string(DISPLAY, 0x1234), None);
    }
    std::thread::scope(|scope| {
        scope.spawn(|| {
            // Another thread starts with no error, and its own error stays
            // its own.
            assert_eq!(error(), EGL_SUCCESS);
            assert_eq!(thread::bind_api(EGL_OPENVG_API as EGLenum), F);
            let c = shared.lock().unwrap().context();
            assert_eq!(shared.lock().unwrap().make_current(NO_HANDLE, c), T);
            assert_eq!(error(), EGL_SUCCESS);
        })
        .join()
        .unwrap();
    });
    assert_eq!(error(), EGL_BAD_PARAMETER);
    assert_eq!(error(), EGL_SUCCESS, "eglGetError itself succeeds");
    // The other thread's current context is not this thread's.
    assert_eq!(shared.lock().unwrap().drv.get_current_context(), NO_HANDLE);
}

#[test]
fn destroy_current_surface_deferred() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, c), T);
    let name = e.drv.surface(s).unwrap().name();
    assert_eq!(e.drv.destroy_surface(&mut e.dev, DISPLAY, s), T);
    // The handle is invalid at once, but the storage stays while current.
    let mut v = 0;
    assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_WIDTH, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.drv.destroy_surface(&mut e.dev, DISPLAY, s), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.drv.get_current_surface(EGL_DRAW), s);
    assert!(e.submits().is_empty(), "nothing is destroyed while current");
    assert_eq!(e.release(), T);
    assert_eq!(e.submits(), [vec![
        Command::SurfaceCreate { surface: name, width: 4, height: 4 },
        Command::SurfaceBind { surface: name },
        Command::SurfaceDestroy { surface: name },
    ]]);
    assert!(e.drv.surface(s).is_none());
    // A current context is destroyed only when released too.
    assert_eq!(e.make_current(NO_HANDLE, c), T);
    assert_eq!(e.drv.destroy_context(&mut e.dev, DISPLAY, c), T);
    assert!(!e.dev.log().iter().any(|c| matches!(c, Call::ContextDestroy { context: 2 })));
    assert_eq!(e.make_current(NO_HANDLE, c), F, "the handle is invalid");
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert_eq!(e.release(), T);
    assert_eq!(e.dev.log().last(), Some(&Call::ContextDestroy { context: 2 }));
}

#[test]
fn destroying_an_idle_surface_flushes_its_context() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, c), T);
    assert_eq!(e.release(), T);
    let name = e.drv.surface(s).unwrap().name();
    assert_eq!(e.drv.destroy_surface(&mut e.dev, DISPLAY, s), T);
    assert_eq!(e.submits().last().unwrap(), &[Command::SurfaceDestroy { surface: name }]);
    // A never-bound surface has no storage to release.
    let calls = e.dev.calls();
    let s2 = e.pbuffer(4, 4);
    assert_eq!(e.drv.destroy_surface(&mut e.dev, DISPLAY, s2), T);
    assert_eq!(e.dev.calls(), calls);
}

#[test]
fn surface_with_second_context_bad_match() {
    let mut e = Egl::init();
    let (a, b) = (e.context(), e.context());
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, a), T);
    // Switching straight to b fails before anything changes.
    assert_eq!(e.make_current(s, b), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    assert_eq!(e.drv.get_current_context(), a);
    assert_eq!(e.release(), T);
    assert_eq!(e.make_current(s, b), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    // Once a is destroyed, its storage is gone with it.
    assert_eq!(e.drv.destroy_context(&mut e.dev, DISPLAY, a), T);
    assert_eq!(e.make_current(s, b), F);
    assert_eq!(error(), EGL_BAD_MATCH);
    assert_eq!(e.make_current(NO_HANDLE, b), T);
}

#[test]
fn swap_pbuffer_submits_without_wait() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(16, 8);
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, s), F, "not current");
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.make_current(s, c), T);
    let name = e.drv.surface(s).unwrap().name();
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, s), T);
    assert_eq!(e.submits(), [vec![
        Command::SurfaceCreate { surface: name, width: 16, height: 8 },
        Command::SurfaceBind { surface: name },
    ]]);
    assert!(!e.dev.log().iter().any(|c| matches!(c, Call::Wait { .. })));
    assert!(e.dev.log().iter().any(|call| matches!(call, Call::Submit { context: 2, stream_context: 2, .. })));
    // Nothing queued: no submission.
    let calls = e.dev.calls();
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, s), T);
    assert_eq!(e.drv.wait_client(&mut e.dev), T);
    assert_eq!(e.dev.calls(), calls);
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, NO_HANDLE), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    // Swap interval: clamped and stored on the draw surface.
    assert_eq!(e.drv.swap_interval(DISPLAY, 7), T);
    assert_eq!(e.drv.surface(s).unwrap().swap_interval, 1);
    assert_eq!(e.drv.swap_interval(DISPLAY, -3), T);
    assert_eq!(e.drv.surface(s).unwrap().swap_interval, 0);
    assert_eq!(e.make_current(NO_HANDLE, c), T);
    assert_eq!(e.drv.swap_interval(DISPLAY, 1), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.release(), T);
    assert_eq!(e.drv.swap_interval(DISPLAY, 1), F);
    assert_eq!(error(), EGL_BAD_CONTEXT);
}

#[test]
fn lost_context_fails_swap_and_bind() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, c), T);
    e.dev.fail_next(FakeOp::Submit, -5);
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, s), F);
    assert_eq!(error(), EGL_CONTEXT_LOST);
    assert_eq!(e.drv.swap_buffers(&mut e.dev, DISPLAY, s), F);
    assert_eq!(error(), EGL_CONTEXT_LOST);
    let calls = e.dev.calls();
    // Releasing a lost context succeeds; binding it again does not.
    assert_eq!(e.release(), T);
    assert_eq!(e.make_current(s, c), F);
    assert_eq!(error(), EGL_CONTEXT_LOST);
    assert_eq!(e.dev.calls(), calls, "a lost context submits nothing more");
    // It can still be destroyed.
    assert_eq!(e.drv.destroy_context(&mut e.dev, DISPLAY, c), T);
    assert_eq!(e.dev.log().last(), Some(&Call::ContextDestroy { context: 2 }));
}

#[test]
fn terminate_invalidates_handles_and_defers_current() {
    let mut e = Egl::init();
    // The second context (kgpu 3) stays idle.
    let (a, _b) = (e.context(), e.context());
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, a), T);
    assert_eq!(e.drv.terminate(&mut e.dev, DISPLAY), T);
    // b was idle: destroyed now. a is current: kept until released.
    assert_eq!(e.dev.log().last(), Some(&Call::ContextDestroy { context: 3 }));
    assert_eq!(e.drv.get_current_context(), a);
    let mut v = 0;
    assert_eq!(e.drv.query_context(DISPLAY, a, EGL_CONFIG_ID, Some(&mut v)), F);
    assert_eq!(error(), EGL_NOT_INITIALIZED);
    // Re-initializing does not revive marked handles.
    assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, None, None), T);
    assert_eq!(e.drv.query_context(DISPLAY, a, EGL_CONFIG_ID, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert_eq!(e.drv.terminate(&mut e.dev, DISPLAY), T);
    assert_eq!(e.drv.terminate(&mut e.dev, DISPLAY), T, "terminating twice is allowed");
    // Releasing on the uninitialized display completes the deletion.
    let destroys = |e: &Egl| e.dev.log().iter().filter(|c| matches!(c, Call::ContextDestroy { .. })).count();
    let before = destroys(&e);
    assert_eq!(e.release(), T);
    assert_eq!(destroys(&e), before + 1);
    assert_eq!(e.dev.log().last(), Some(&Call::ContextDestroy { context: 2 }));
    assert_eq!(e.drv.get_current_context(), NO_HANDLE);
}

#[test]
fn release_thread_releases_and_resets() {
    let mut e = Egl::init();
    let c = e.context();
    assert_eq!(e.make_current(NO_HANDLE, c), T);
    assert_eq!(e.drv.release_thread(&mut e.dev), T);
    assert_eq!(e.drv.get_current_context(), NO_HANDLE);
    assert_eq!(thread::query_api(), EGL_OPENGL_ES_API as EGLenum);
    assert_eq!(error(), EGL_SUCCESS);
}

#[test]
fn get_proc_address_known_and_unknown() {
    let names = [
        "eglGetError", "eglGetDisplay", "eglGetPlatformDisplay", "eglInitialize", "eglTerminate",
        "eglQueryString", "eglGetConfigs", "eglChooseConfig", "eglGetConfigAttrib",
        "eglCreatePbufferSurface", "eglDestroySurface", "eglQuerySurface", "eglBindAPI", "eglQueryAPI",
        "eglCreateContext", "eglDestroyContext", "eglMakeCurrent", "eglGetCurrentContext",
        "eglGetCurrentSurface", "eglGetCurrentDisplay", "eglQueryContext", "eglSwapBuffers",
        "eglSwapInterval", "eglWaitClient", "eglReleaseThread", "eglGetProcAddress",
    ];
    for name in names {
        assert!(get_proc_address(name.as_bytes()).is_some(), "{name}");
    }
    let get_error = get_proc_address(b"eglGetError").unwrap();
    assert_eq!(get_error as usize, eglGetError as *const () as usize);
    // Defined nowhere in this library.
    for name in ["eglCreateWindowSurface", "eglGetPlatformDisplayEXT", "glDrawArrays", "", "eglgeterror"] {
        assert!(get_proc_address(name.as_bytes()).is_none(), "{name}");
    }
}

#[test]
fn pid_change_drops_state_without_destroys() {
    let mut e = Egl::new();
    e.drv.set_test_pid(Some(100));
    assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, None, None), T);
    let c = e.context();
    let s = e.pbuffer(4, 4);
    assert_eq!(e.make_current(s, c), T);
    let log = e.dev.calls();
    // The fork child.
    e.drv.set_test_pid(Some(101));
    assert_eq!(e.drv.get_current_context(), NO_HANDLE);
    assert_eq!(current(), None);
    let mut v = 0;
    assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_WIDTH, Some(&mut v)), F);
    assert_eq!(error(), EGL_NOT_INITIALIZED);
    assert_eq!(e.dev.calls(), log, "no kgpu call: the parent's contexts are not the child's");
    // The child may initialize anew; old handles name nothing.
    assert_eq!(e.drv.initialize(&mut e.dev, DISPLAY, None, None), T);
    assert_eq!(e.dev.log()[log..], [Call::ContextCreate, Call::ContextDestroy { context: 3 }]);
    assert_eq!(e.make_current(s, c), F);
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert!(!e.dev.log().iter().any(|call| matches!(call, Call::ContextDestroy { context: 2 })));
}

#[test]
fn queries_make_no_device_calls() {
    let mut e = Egl::init();
    let c = e.context();
    let s = e.pbuffer(4, 4);
    let config = e.config();
    assert_eq!(e.make_current(s, c), T);
    let calls = e.dev.calls();
    let mut v = 0;
    for _ in 0..3 {
        assert!(e.drv.query_string(DISPLAY, EGL_VENDOR).is_some());
        assert!(e.drv.query_string(NO_HANDLE, EGL_EXTENSIONS).is_some());
        assert_eq!(e.drv.get_config_attrib(DISPLAY, config, EGL_RED_SIZE, Some(&mut v)), T);
        assert_eq!(e.drv.query_surface(DISPLAY, s, EGL_WIDTH, Some(&mut v)), T);
        assert_eq!(e.drv.query_context(DISPLAY, c, EGL_RENDER_BUFFER, Some(&mut v)), T);
        assert_eq!(v, EGL_BACK_BUFFER);
        assert_eq!(e.drv.get_current_context(), c);
        assert_eq!(error(), EGL_SUCCESS);
    }
    assert_eq!(e.dev.calls(), calls);
}

#[test]
fn handles_are_tagged_by_kind() {
    let mut e = Egl::init();
    let (c, s) = (e.context(), e.pbuffer(1, 1));
    let config = e.config();
    let mut v = 0;
    // A context is not a surface, a surface not a context or config.
    assert_eq!(e.drv.query_surface(DISPLAY, c, EGL_WIDTH, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_SURFACE);
    assert_eq!(e.drv.query_context(DISPLAY, s, EGL_CONFIG_ID, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_CONTEXT);
    assert_eq!(e.drv.get_config_attrib(DISPLAY, s, EGL_RED_SIZE, Some(&mut v)), F);
    assert_eq!(error(), EGL_BAD_CONFIG);
    assert!([c, s, config].iter().all(|&h| h != NO_HANDLE && h != DISPLAY));
}

#[test]
fn the_storage_limit_matches_the_executor() {
    let executor = include_str!("../../../gpu-executor/src/lib.rs");
    assert!(
        executor.contains(&format!("pub const MAX_SURFACES_PER_CONTEXT: usize = {};", context::MAX_SURFACES_PER_CONTEXT)),
        "crates/gpu-executor's MAX_SURFACES_PER_CONTEXT changed"
    );
}

#[test]
fn a_context_holds_at_most_the_executor_s_surfaces() {
    let mut e = Egl::init();
    let c = e.context();
    for _ in 0..context::MAX_SURFACES_PER_CONTEXT {
        let s = e.pbuffer(1, 1);
        assert_eq!(e.make_current(s, c), T);
    }
    let s = e.pbuffer(1, 1);
    assert_eq!(e.make_current(s, c), F);
    assert_eq!(error(), EGL_BAD_ALLOC);
}

#[test]
fn tokens_match_the_khronos_headers() {
    let headers = [
        include_str!("../../../../libc/musl-overlay/include/EGL/egl.h"),
        include_str!("../../../../libc/musl-overlay/include/EGL/eglext.h"),
    ];
    let defined = |name: &str| -> Option<String> {
        headers.iter().flat_map(|h| h.lines()).find_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("#define") && words.next() == Some(name)).then(|| words.collect::<String>())
        })
    };
    for &(name, value) in HEADER_TOKENS {
        let text = defined(name).unwrap_or_else(|| panic!("{name} is not in the EGL headers"));
        let parsed = if let Some(hex) = text.strip_prefix("0x") {
            i64::from_str_radix(hex, 16).unwrap()
        } else if let Some(inner) = text.strip_prefix("EGL_CAST(EGLint,").and_then(|t| t.strip_suffix(')')) {
            inner.parse().unwrap()
        } else {
            text.parse().unwrap_or_else(|_| panic!("{name}: cannot read {text}"))
        };
        assert_eq!(parsed, value as i64, "{name}");
    }
}
