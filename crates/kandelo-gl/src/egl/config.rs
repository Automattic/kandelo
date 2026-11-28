//! The display's one EGLConfig and EGL 1.5 §3.4 config selection.
//!
//! Ownership: the config table is fixed. Its one entry describes what the
//! kgpu executor really allocates for a surface: an RGBA8 color buffer with
//! no depth, stencil or multisample buffer, usable as a pbuffer only (the
//! skeleton has no window platform) and by OpenGL ES 2.0 only. Matching and
//! sorting follow Table 3.4 for every attribute even with one config, so a
//! request the config cannot satisfy gets zero configs rather than a
//! near miss.

use super::*;
use core::cmp::Ordering;

/// The largest pbuffer side; the executor's `MAX_SURFACE_DIM`.
pub const MAX_PBUFFER_DIM: EGLint = kgpu_stream::MAX_SURFACE_DIM as EGLint;

pub struct Config {
    attribs: &'static [(EGLint, EGLint)],
}

impl Config {
    /// Every attribute of Tables 3.1 and 3.4 except
    /// `EGL_MATCH_NATIVE_PIXMAP`, which is a selection-only criterion.
    pub fn get(&self, attribute: EGLint) -> Option<EGLint> {
        self.attribs.iter().find(|&&(a, _)| a == attribute).map(|&(_, v)| v)
    }

    fn value(&self, attribute: EGLint) -> EGLint {
        self.get(attribute).expect("every config defines every Table 3.1 attribute")
    }

    pub fn id(&self) -> EGLint {
        self.value(EGL_CONFIG_ID)
    }
}

pub static CONFIGS: [Config; 1] = [Config {
    attribs: &[
        (EGL_BUFFER_SIZE, 32),
        (EGL_RED_SIZE, 8),
        (EGL_GREEN_SIZE, 8),
        (EGL_BLUE_SIZE, 8),
        (EGL_LUMINANCE_SIZE, 0),
        (EGL_ALPHA_SIZE, 8),
        (EGL_ALPHA_MASK_SIZE, 0),
        (EGL_BIND_TO_TEXTURE_RGB, EGL_FALSE),
        (EGL_BIND_TO_TEXTURE_RGBA, EGL_FALSE),
        (EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER),
        (EGL_CONFIG_CAVEAT, EGL_NONE),
        (EGL_CONFIG_ID, 1),
        (EGL_CONFORMANT, EGL_OPENGL_ES2_BIT),
        (EGL_DEPTH_SIZE, 0),
        (EGL_LEVEL, 0),
        (EGL_MAX_PBUFFER_WIDTH, MAX_PBUFFER_DIM),
        (EGL_MAX_PBUFFER_HEIGHT, MAX_PBUFFER_DIM),
        (EGL_MAX_PBUFFER_PIXELS, MAX_PBUFFER_DIM * MAX_PBUFFER_DIM),
        // eglSwapInterval clamps to these; a pbuffer swap has no effect.
        (EGL_MAX_SWAP_INTERVAL, 1),
        (EGL_MIN_SWAP_INTERVAL, 0),
        (EGL_NATIVE_RENDERABLE, EGL_FALSE),
        // No window support, so no native visual (§3.4).
        (EGL_NATIVE_VISUAL_ID, 0),
        (EGL_NATIVE_VISUAL_TYPE, EGL_NONE),
        (EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT),
        (EGL_SAMPLE_BUFFERS, 0),
        (EGL_SAMPLES, 0),
        (EGL_STENCIL_SIZE, 0),
        (EGL_SURFACE_TYPE, EGL_PBUFFER_BIT),
        (EGL_TRANSPARENT_TYPE, EGL_NONE),
        // Undefined when EGL_TRANSPARENT_TYPE is EGL_NONE; reported as 0.
        (EGL_TRANSPARENT_RED_VALUE, 0),
        (EGL_TRANSPARENT_GREEN_VALUE, 0),
        (EGL_TRANSPARENT_BLUE_VALUE, 0),
    ],
}];

/// The config `handle` names.
pub fn by_handle(handle: usize) -> Option<&'static Config> {
    CONFIGS.iter().find(|c| config_handle(c.id()) == handle)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Criterion {
    AtLeast,
    Exact,
    Mask,
    /// `EGL_CONFIG_ID` and `EGL_MATCH_NATIVE_PIXMAP`.
    Special,
    /// Accepted with a value and never matched (§3.4.1.1).
    Ignored,
}

/// Which values an attribute accepts in an `eglChooseConfig` list.
#[derive(Clone, Copy)]
enum Values {
    /// A buffer size: non-negative.
    Size,
    Boolean,
    /// Any integer.
    Integer,
    Enum(&'static [EGLint]),
    Bits(EGLint),
    /// `EGL_LEVEL`: any integer, but not `EGL_DONT_CARE`.
    Level,
    /// `EGL_MATCH_NATIVE_PIXMAP`: the surfaceless platform has no native
    /// pixmaps, so only `EGL_NONE` names one (none).
    NoPixmap,
}

struct Rule {
    attribute: EGLint,
    default: EGLint,
    criterion: Criterion,
    values: Values,
}

const SURFACE_BITS: EGLint = EGL_WINDOW_BIT
    | EGL_PIXMAP_BIT
    | EGL_PBUFFER_BIT
    | EGL_MULTISAMPLE_RESOLVE_BOX_BIT
    | EGL_SWAP_BEHAVIOR_PRESERVED_BIT
    | EGL_VG_COLORSPACE_LINEAR_BIT
    | EGL_VG_ALPHA_FORMAT_PRE_BIT;
const API_BITS: EGLint = EGL_OPENGL_ES_BIT | EGL_OPENVG_BIT | EGL_OPENGL_ES2_BIT | EGL_OPENGL_BIT | EGL_OPENGL_ES3_BIT;

const fn rule(attribute: EGLint, default: EGLint, criterion: Criterion, values: Values) -> Rule {
    Rule { attribute, default, criterion, values }
}

/// EGL 1.5 Table 3.4, plus the attributes §3.4.1.1 says are ignored.
static RULES: &[Rule] = {
    use Criterion::*;
    use Values::*;
    &[
        rule(EGL_BUFFER_SIZE, 0, AtLeast, Size),
        rule(EGL_RED_SIZE, 0, AtLeast, Size),
        rule(EGL_GREEN_SIZE, 0, AtLeast, Size),
        rule(EGL_BLUE_SIZE, 0, AtLeast, Size),
        rule(EGL_LUMINANCE_SIZE, 0, AtLeast, Size),
        rule(EGL_ALPHA_SIZE, 0, AtLeast, Size),
        rule(EGL_ALPHA_MASK_SIZE, 0, AtLeast, Size),
        rule(EGL_BIND_TO_TEXTURE_RGB, EGL_DONT_CARE, Exact, Boolean),
        rule(EGL_BIND_TO_TEXTURE_RGBA, EGL_DONT_CARE, Exact, Boolean),
        rule(EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER, Exact, Enum(&[EGL_RGB_BUFFER, EGL_LUMINANCE_BUFFER])),
        rule(EGL_CONFIG_CAVEAT, EGL_DONT_CARE, Exact, Enum(&[EGL_NONE, EGL_SLOW_CONFIG, EGL_NON_CONFORMANT_CONFIG])),
        rule(EGL_CONFIG_ID, EGL_DONT_CARE, Special, Integer),
        rule(EGL_CONFORMANT, 0, Mask, Bits(API_BITS)),
        rule(EGL_DEPTH_SIZE, 0, AtLeast, Size),
        rule(EGL_LEVEL, 0, Exact, Level),
        rule(EGL_MATCH_NATIVE_PIXMAP, EGL_NONE, Special, NoPixmap),
        rule(EGL_MAX_SWAP_INTERVAL, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_MIN_SWAP_INTERVAL, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_NATIVE_RENDERABLE, EGL_DONT_CARE, Exact, Boolean),
        rule(EGL_NATIVE_VISUAL_TYPE, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_RENDERABLE_TYPE, EGL_OPENGL_ES_BIT, Mask, Bits(API_BITS)),
        rule(EGL_SAMPLE_BUFFERS, 0, AtLeast, Size),
        rule(EGL_SAMPLES, 0, AtLeast, Size),
        rule(EGL_STENCIL_SIZE, 0, AtLeast, Size),
        rule(EGL_SURFACE_TYPE, EGL_WINDOW_BIT, Mask, Bits(SURFACE_BITS)),
        rule(EGL_TRANSPARENT_TYPE, EGL_NONE, Exact, Enum(&[EGL_NONE, EGL_TRANSPARENT_RGB])),
        rule(EGL_TRANSPARENT_RED_VALUE, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_TRANSPARENT_GREEN_VALUE, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_TRANSPARENT_BLUE_VALUE, EGL_DONT_CARE, Exact, Integer),
        rule(EGL_MAX_PBUFFER_WIDTH, EGL_DONT_CARE, Ignored, Integer),
        rule(EGL_MAX_PBUFFER_HEIGHT, EGL_DONT_CARE, Ignored, Integer),
        rule(EGL_MAX_PBUFFER_PIXELS, EGL_DONT_CARE, Ignored, Integer),
        rule(EGL_NATIVE_VISUAL_ID, EGL_DONT_CARE, Ignored, Integer),
    ]
};

fn valid(values: Values, value: EGLint) -> bool {
    if value == EGL_DONT_CARE {
        return !matches!(values, Values::Level | Values::NoPixmap);
    }
    match values {
        Values::Size => value >= 0,
        Values::Boolean => value == EGL_TRUE || value == EGL_FALSE,
        Values::Integer | Values::Level => true,
        Values::Enum(allowed) => allowed.contains(&value),
        Values::Bits(known) => value & !known == 0,
        Values::NoPixmap => value == EGL_NONE,
    }
}

/// The requested value of every Table 3.4 attribute: the list's, or the
/// default.
struct Request {
    values: [EGLint; RULE_COUNT],
}

const RULE_COUNT: usize = 33;
const _: () = assert!(RULES.len() == RULE_COUNT);

impl Request {
    fn parse(list: &[EGLint]) -> Result<Self> {
        let mut values = [0; RULE_COUNT];
        for (slot, rule) in values.iter_mut().zip(RULES) {
            *slot = rule.default;
        }
        for pair in attrib_pairs(list) {
            let (attribute, value) = pair?;
            let i = RULES.iter().position(|r| r.attribute == attribute).ok_or(EGL_BAD_ATTRIBUTE)?;
            // §3.4.1.1: the value is a native pixmap handle, and the
            // surfaceless platform has none, so any handle is invalid
            // (§3.1.2: EGL_BAD_NATIVE_PIXMAP where it can tell). §3.4.1
            // forbids EGL_DONT_CARE for it, an out-of-range value.
            if matches!(RULES[i].values, Values::NoPixmap) && value != EGL_NONE && value != EGL_DONT_CARE {
                return Err(EGL_BAD_NATIVE_PIXMAP);
            }
            if !valid(RULES[i].values, value) {
                return Err(EGL_BAD_ATTRIBUTE);
            }
            values[i] = value;
        }
        Ok(Self { values })
    }

    fn get(&self, attribute: EGLint) -> EGLint {
        self.values[RULES.iter().position(|r| r.attribute == attribute).expect("a Table 3.4 attribute")]
    }

    fn matches(&self, config: &Config) -> bool {
        let id = self.get(EGL_CONFIG_ID);
        if id != EGL_DONT_CARE {
            // §3.4.1.1: EGL_CONFIG_ID overrides every other attribute.
            return config.id() == id;
        }
        let ignore_transparent_values = self.get(EGL_TRANSPARENT_TYPE) == EGL_NONE;
        RULES.iter().zip(self.values).all(|(rule, wanted)| {
            if wanted == EGL_DONT_CARE {
                return true;
            }
            match rule.attribute {
                // §3.4.1.1: ignored when the platform has no native visual
                // types, and the surfaceless platform has none.
                EGL_NATIVE_VISUAL_TYPE => return true,
                EGL_TRANSPARENT_RED_VALUE | EGL_TRANSPARENT_GREEN_VALUE | EGL_TRANSPARENT_BLUE_VALUE
                    if ignore_transparent_values =>
                {
                    return true;
                }
                // Only EGL_NONE is accepted, and it names no pixmap.
                EGL_MATCH_NATIVE_PIXMAP => return true,
                _ => {}
            }
            let have = config.value(rule.attribute);
            match rule.criterion {
                Criterion::AtLeast => have >= wanted,
                Criterion::Exact => have == wanted,
                Criterion::Mask => have & wanted == wanted,
                Criterion::Special | Criterion::Ignored => true,
            }
        })
    }

    /// The §3.4.1.2 sort: caveat, color buffer type, larger requested color
    /// depth, then smaller buffer size, sample buffers, samples, depth,
    /// stencil and alpha mask, native visual type, and config ID last.
    fn order(&self, a: &Config, b: &Config) -> Ordering {
        let caveat = |c: &Config| match c.value(EGL_CONFIG_CAVEAT) {
            EGL_NONE => 0,
            EGL_SLOW_CONFIG => 1,
            _ => 2,
        };
        let buffer_type = |c: &Config| (c.value(EGL_COLOR_BUFFER_TYPE) != EGL_RGB_BUFFER) as u8;
        // Only components requested with a nonzero, cared-about size count.
        let color_bits = |c: &Config| {
            [EGL_RED_SIZE, EGL_GREEN_SIZE, EGL_BLUE_SIZE, EGL_LUMINANCE_SIZE, EGL_ALPHA_SIZE]
                .iter()
                .filter(|&&attr| !matches!(self.get(attr), 0 | EGL_DONT_CARE))
                .map(|&attr| c.value(attr))
                .sum::<EGLint>()
        };
        let smaller = |attr: EGLint| a.value(attr).cmp(&b.value(attr));
        caveat(a)
            .cmp(&caveat(b))
            .then(buffer_type(a).cmp(&buffer_type(b)))
            .then(color_bits(b).cmp(&color_bits(a)))
            .then_with(|| smaller(EGL_BUFFER_SIZE))
            .then_with(|| smaller(EGL_SAMPLE_BUFFERS))
            .then_with(|| smaller(EGL_SAMPLES))
            .then_with(|| smaller(EGL_DEPTH_SIZE))
            .then_with(|| smaller(EGL_STENCIL_SIZE))
            .then_with(|| smaller(EGL_ALPHA_MASK_SIZE))
            // Native visual types have no meaning here; they never order.
            .then_with(|| smaller(EGL_CONFIG_ID))
    }
}

/// Writes the configs into `out` (when given) and their count into `num`.
fn deliver<'a>(
    configs: impl Iterator<Item = &'a Config>,
    out: Option<&mut [usize]>,
    num: Option<&mut EGLint>,
) -> Result<()> {
    let num = num.ok_or(EGL_BAD_PARAMETER)?;
    let mut count = 0;
    match out {
        None => count = configs.count(),
        Some(out) => {
            for (slot, config) in out.iter_mut().zip(configs) {
                *slot = config_handle(config.id());
                count += 1;
            }
        }
    }
    *num = count as EGLint;
    Ok(())
}

impl Driver {
    /// `eglGetConfigs`.
    pub fn get_configs(&mut self, dpy: usize, configs: Option<&mut [usize]>, num: Option<&mut EGLint>) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| deliver(CONFIGS.iter(), configs, num));
        thread::report(result.map(|()| EGL_TRUE as EGLBoolean), EGL_FALSE as EGLBoolean)
    }

    /// `eglChooseConfig`.
    pub fn choose_config(
        &mut self,
        dpy: usize,
        attribs: &[EGLint],
        configs: Option<&mut [usize]>,
        num: Option<&mut EGLint>,
    ) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            let request = Request::parse(attribs)?;
            let mut chosen: alloc::vec::Vec<&Config> = CONFIGS.iter().filter(|c| request.matches(c)).collect();
            chosen.sort_unstable_by(|a, b| request.order(a, b));
            deliver(chosen.into_iter(), configs, num)
        });
        thread::report(result.map(|()| EGL_TRUE as EGLBoolean), EGL_FALSE as EGLBoolean)
    }

    /// `eglGetConfigAttrib`.
    pub fn get_config_attrib(
        &mut self,
        dpy: usize,
        config: usize,
        attribute: EGLint,
        value: Option<&mut EGLint>,
    ) -> EGLBoolean {
        let result = self.initialized_display(dpy).and_then(|()| {
            let config = by_handle(config).ok_or(EGL_BAD_CONFIG)?;
            let v = config.get(attribute).ok_or(EGL_BAD_ATTRIBUTE)?;
            *value.ok_or(EGL_BAD_PARAMETER)? = v;
            Ok(EGL_TRUE as EGLBoolean)
        });
        thread::report(result, EGL_FALSE as EGLBoolean)
    }
}
