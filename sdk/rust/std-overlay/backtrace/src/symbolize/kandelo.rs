use super::{BytesOrWideString, ResolveWhat, SymbolName};
use core::{ffi::c_void, marker::PhantomData};

pub unsafe fn resolve(what: ResolveWhat<'_>, cb: &mut dyn FnMut(&super::Symbol)) {
    // A bare address has no owning module/frame metadata. Never guess its
    // module or use a lifetime-broken global cache of the last capture.
    let ResolveWhat::Frame(frame) = what else {
        return;
    };
    cb(&super::Symbol {
        inner: Symbol {
            inner: frame.inner.clone(),
            _lifetime: PhantomData,
        },
    });
}
pub struct Symbol<'a> {
    inner: super::super::backtrace::kandelo::Frame,
    _lifetime: PhantomData<&'a ()>,
}
impl Symbol<'_> {
    pub fn name(&self) -> Option<SymbolName<'_>> {
        (!self.inner.name.is_empty()).then(|| SymbolName::new(&self.inner.name))
    }
    pub fn addr(&self) -> Option<*mut c_void> {
        None
    }
    pub fn filename_raw(&self) -> Option<BytesOrWideString<'_>> {
        (!self.inner.filename.is_empty()).then_some(BytesOrWideString::Bytes(&self.inner.filename))
    }
    pub fn lineno(&self) -> Option<u32> {
        self.inner.line
    }
    pub fn colno(&self) -> Option<u32> {
        self.inner.column
    }
    #[cfg(feature = "std")]
    pub fn filename(&self) -> Option<&std::path::Path> {
        core::str::from_utf8(&self.inner.filename)
            .ok()
            .filter(|path| !path.is_empty())
            .map(std::path::Path::new)
    }
}
pub unsafe fn clear_symbol_cache() {}
