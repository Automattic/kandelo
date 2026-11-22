//! Private engine operations for the pinned Serde converter. This file does not
//! contain an Options schema or a replacement transformer. The caller owns one
//! rooted handle arena for each synchronous transform, including nested calls.
use std::{cell::Cell, ffi::c_void, fmt, panic::resume_unwind};

#[repr(C)]
#[derive(Default)]
pub struct Reply {
    pub value: u32,
    pub flag: u32,
    pub number: f64,
    pub length: usize,
}

#[repr(C)]
pub struct Operations {
    pub version: u32,
    pub size: usize,
    pub owner: *mut c_void,
    pub invoke: unsafe extern "C" fn(
        *mut c_void, u32, u32, u32, u32, *mut u8, usize, f64, *mut Reply,
    ) -> i32,
}

// Keep these discriminants identical to kandelo_amaro_values.h. The operation
// results are real values in the caller's JS engine, never JSON placeholders.
#[repr(u32)]
pub enum Op {
    Type = 1, Number, StringLength, StringCopy, NewString, NewNumber,
    NewBigInt, BigIntString, LooseEq, In, Get, Set, NewObject,
    ObjectEntries, NewArray, ArrayLength, ArrayGet, ArraySet, ArrayFrom,
    IsSafeInteger, NewMap, MapSet, IteratorSymbol, TryIter, IterNext,
    NewBytes, CopyBytesLength, CopyBytes, NewUint8Array, NewError,
    Display, Debug, Uint8String, Falsy, StringUtf16Length, CodePointAt,
}

thread_local! { static ACTIVE: Cell<*const Operations> = const { Cell::new(std::ptr::null()) }; }

pub struct FrameGuard(*const Operations);
impl FrameGuard {
    /// The C++ caller retains the operation table and all referenced roots until
    /// the export returns. A nested transform restores its parent table.
    pub unsafe fn enter(ops: *const Operations) -> Option<Self> {
        let table = unsafe { ops.as_ref() }?;
        if table.version != 1 || table.size != std::mem::size_of::<Operations>() {
            return None;
        }
        Some(Self(ACTIVE.with(|active| active.replace(ops))))
    }
}
impl Drop for FrameGuard {
    fn drop(&mut self) { ACTIVE.with(|active| active.set(self.0)); }
}

/// Only Rust unwinds. The operation callback first returns normally through
/// C++, retaining its real exception/termination in the outer engine catcher.
/// The export catches this private payload after Rust has retired its locals.
#[derive(Debug)]
pub struct Abrupt;

fn invoke(op: Op, a: u32, b: u32, c: u32, bytes: *mut u8, len: usize, number: f64) -> Reply {
    ACTIVE.with(|active| {
        let pointer = active.get();
        assert!(!pointer.is_null(), "native Amaro value used outside its call");
        let table = unsafe { &*pointer };
        let mut reply = Reply::default();
        let status = unsafe { (table.invoke)(table.owner, op as u32, a, b, c, bytes, len, number, &mut reply) };
        if status != 0 { resume_unwind(Box::new(Abrupt)); }
        reply
    })
}
fn op(op: Op, a: u32, b: u32, c: u32) -> Reply {
    invoke(op, a, b, c, std::ptr::null_mut(), 0, 0.0)
}
fn text(op: Op, value: &str) -> JsValue {
    JsValue(invoke(op, 0, 0, 0, value.as_ptr().cast_mut(), value.len(), 0.0).value)
}

#[repr(transparent)]
#[derive(Clone, PartialEq, Eq)]
pub struct JsValue(pub u32);
impl JsValue {
    pub const UNDEFINED: Self = Self(0);
    pub const NULL: Self = Self(1);
    pub const FALSE: Self = Self(2);
    pub const TRUE: Self = Self(3);
    pub fn from_str(value: &str) -> Self { text(Op::NewString, value) }
    fn kind(&self) -> u32 { op(Op::Type, self.0, 0, 0).flag }
    pub fn is_undefined(&self) -> bool { self.kind() == 0 }
    pub fn is_string(&self) -> bool { self.kind() == 4 }
    pub fn is_object(&self) -> bool { self.kind() == 6 }
    pub fn is_bigint(&self) -> bool { self.kind() == 5 }
    pub fn is_falsy(&self) -> bool { op(Op::Falsy, self.0, 0, 0).flag != 0 }
    pub fn as_bool(&self) -> Option<bool> { (self.kind() == 2).then(|| op(Op::Number, self.0, 0, 0).flag != 0) }
    pub fn as_f64(&self) -> Option<f64> { (self.kind() == 3).then(|| self.unchecked_into_f64()) }
    pub fn unchecked_into_f64(&self) -> f64 { op(Op::Number, self.0, 0, 0).number }
    pub fn as_string(&self) -> Option<String> {
        if !self.is_string() { return None; }
        let length = op(Op::StringLength, self.0, 0, 0).length;
        let mut bytes = vec![0; length];
        let result = invoke(Op::StringCopy, self.0, 0, 0, bytes.as_mut_ptr(), length, 0.0);
        assert_eq!(result.length, length, "native string changed while copying");
        Some(String::from_utf8(bytes).expect("native engine UTF-8 contract"))
    }
    pub fn loose_eq(&self, other: &Self) -> bool { op(Op::LooseEq, self.0, other.0, 0).flag != 0 }
    pub fn js_in(&self, object: &Self) -> bool { op(Op::In, self.0, object.0, 0).flag != 0 }
    pub fn is_instance_of<T: JsCast>(&self) -> bool { T::matches(self) }
    pub fn has_type<T: JsCast>(&self) -> bool { T::matches(self) }
    pub fn unchecked_into<T: JsCast>(self) -> T { T::from_value(self) }
    pub fn unchecked_ref<T: JsCast>(&self) -> &T { unsafe { &*(self as *const Self).cast::<T>() } }
    pub fn dyn_into<T: JsCast>(self) -> Result<T, Self> {
        if T::matches(&self) { Ok(T::from_value(self)) } else { Err(self) }
    }
    pub fn dyn_ref<T: JsCast>(&self) -> Option<&T> {
        T::matches(self).then(|| self.unchecked_ref())
    }
    fn rendered(&self, operation: Op) -> String {
        JsValue(op(operation, self.0, 0, 0).value).as_string().expect("native rendering must return string")
    }
}
impl AsRef<JsValue> for JsValue { fn as_ref(&self) -> &JsValue { self } }
impl fmt::Debug for JsValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "JsValue({})", self.rendered(Op::Debug)) }
}

pub trait JsCast: AsRef<JsValue> + Sized {
    fn matches(value: &JsValue) -> bool;
    fn from_value(value: JsValue) -> Self;
    fn unchecked_into<T: JsCast>(self) -> T { T::from_value(self.as_ref().clone()) }
    fn unchecked_ref<T: JsCast>(&self) -> &T { self.as_ref().unchecked_ref() }
    fn dyn_into<T: JsCast>(self) -> Result<T, JsValue> { self.as_ref().clone().dyn_into() }
}
impl JsCast for JsValue {
    fn matches(_: &JsValue) -> bool { true }
    fn from_value(value: JsValue) -> Self { value }
}

macro_rules! wrapper {
    ($name:ident, $tag:expr) => {
        #[repr(transparent)]
        #[derive(Clone, Debug)]
        pub struct $name(JsValue);
        impl AsRef<JsValue> for $name { fn as_ref(&self) -> &JsValue { &self.0 } }
        impl std::ops::Deref for $name { type Target = JsValue; fn deref(&self) -> &JsValue { &self.0 } }
        impl From<$name> for JsValue { fn from(value: $name) -> Self { value.0 } }
        impl JsCast for $name {
            fn matches(value: &JsValue) -> bool { op(Op::Type, value.0, $tag, 0).flag != 0 }
            fn from_value(value: JsValue) -> Self { Self(value) }
        }
    };
}
wrapper!(JsString, 1);
wrapper!(Array, 2);
wrapper!(Uint8Array, 3);
wrapper!(ArrayBuffer, 4);
wrapper!(Map, 5);
wrapper!(Object, 6);
wrapper!(ObjectExt, 6);
wrapper!(Symbol, 7);
wrapper!(JsError, 8);

impl From<&str> for JsValue { fn from(value: &str) -> Self { Self::from_str(value) } }
impl From<String> for JsValue { fn from(value: String) -> Self { Self::from_str(&value) } }
impl From<bool> for JsValue { fn from(value: bool) -> Self { if value { Self::TRUE } else { Self::FALSE } } }
macro_rules! numbers {
    ($($ty:ty),*) => { $(impl From<$ty> for JsValue {
        fn from(value: $ty) -> Self { Self(invoke(Op::NewNumber, 0, 0, 0, std::ptr::null_mut(), 0, value as f64).value) }
    })* };
}
numbers!(i8, i16, i32, u8, u16, u32, f32, f64);
macro_rules! bigints {
    ($($ty:ty),*) => { $(
        impl From<$ty> for JsValue { fn from(value: $ty) -> Self { text(Op::NewBigInt, &value.to_string()) } }
        impl TryFrom<JsValue> for $ty {
            type Error = JsValue;
            fn try_from(value: JsValue) -> Result<Self, JsValue> {
                if !value.is_bigint() { return Err(value); }
                match value.rendered(Op::BigIntString).parse::<$ty>() { Ok(number) => Ok(number), Err(_) => Err(value) }
            }
        }
    )* };
}
bigints!(i64, u64, i128, u128);
impl From<&str> for JsString { fn from(value: &str) -> Self { Self(value.into()) } }
impl From<char> for JsString { fn from(value: char) -> Self { Self(value.to_string().into()) } }
impl JsString {
    pub fn as_char(&self) -> Option<char> {
        let len = op(Op::StringUtf16Length, self.0.0, 0, 0).flag;
        if len == 0 || len > 2 { return None; }
        let point = JsValue(op(Op::CodePointAt, self.0.0, 0, 0).value);
        let cp = point.as_f64().unwrap_throw() as u32;
        let c = core::char::from_u32(cp)?;
        if c.len_utf16() as u32 == len { Some(c) } else { None }
    }
}
impl Object {
    pub fn new() -> Self { Self(JsValue(op(Op::NewObject, 0, 0, 0).value)) }
    pub fn entries(value: &Self) -> Array { Array(JsValue(op(Op::ObjectEntries, value.0.0, 0, 0).value)) }
}
impl ObjectExt {
    pub fn get_with_ref_key(&self, key: &JsString) -> JsValue { JsValue(op(Op::Get, self.0.0, key.0.0, 0).value) }
    pub fn set(&self, key: JsString, value: JsValue) { op(Op::Set, self.0.0, key.0.0, value.0); }
}
impl Array {
    pub fn new() -> Self { Self(JsValue(op(Op::NewArray, 0, 0, 0).value)) }
    pub fn from(value: &JsValue) -> Self { Self(JsValue(op(Op::ArrayFrom, value.0, 0, 0).value)) }
    pub fn is_array(value: &JsValue) -> bool { Self::matches(value) }
    pub fn length(&self) -> u32 { op(Op::ArrayLength, self.0.0, 0, 0).flag }
    pub fn get(&self, index: u32) -> JsValue { JsValue(op(Op::ArrayGet, self.0.0, index, 0).value) }
    pub fn set(&self, index: u32, value: JsValue) { op(Op::ArraySet, self.0.0, index, value.0); }
    pub fn iter(&self) -> ArrayIter<'_> { ArrayIter { array: self, range: 0..self.length() } }
}
pub struct ArrayIter<'a> { array: &'a Array, range: std::ops::Range<u32> }
impl Iterator for ArrayIter<'_> {
    type Item = JsValue;
    fn next(&mut self) -> Option<Self::Item> { self.range.next().map(|index| self.array.get(index)) }
}
impl Map {
    pub fn new() -> Self { Self(JsValue(op(Op::NewMap, 0, 0, 0).value)) }
    pub fn set(&self, key: &JsValue, value: &JsValue) { op(Op::MapSet, self.0.0, key.0, value.0); }
}
pub struct Number;
impl Number {
    pub const MIN_SAFE_INTEGER: f64 = -9007199254740991.0;
    pub const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;
    pub fn is_safe_integer(value: &JsValue) -> bool { op(Op::IsSafeInteger, value.0, 0, 0).flag != 0 }
}
impl Symbol { pub fn iterator() -> Self { Self(JsValue(op(Op::IteratorSymbol, 0, 0, 0).value)) } }
pub struct IntoIter { value: JsValue, done: bool }
pub fn try_iter(value: &JsValue) -> Result<Option<IntoIter>, JsValue> {
    let reply = op(Op::TryIter, value.0, 0, 0);
    Ok((reply.flag != 0).then(|| IntoIter { value: JsValue(reply.value), done: false }))
}
impl Iterator for IntoIter {
    type Item = Result<JsValue, JsValue>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done { return None; }
        let reply = op(Op::IterNext, self.value.0, 0, 0);
        self.done = reply.flag != 0;
        (!self.done).then(|| Ok(JsValue(reply.value)))
    }
}
impl Uint8Array {
    pub fn new(value: &JsValue) -> Self { Self(JsValue(op(Op::NewUint8Array, value.0, 0, 0).value)) }
    pub unsafe fn view(bytes: &[u8]) -> Self {
        // Copy into a real engine Uint8Array before returning. Rust/guest memory
        // is never exposed as an engine backing store with a borrowed lifetime.
        Self(JsValue(invoke(Op::NewBytes, 0, 0, 0, bytes.as_ptr().cast_mut(), bytes.len(), 0.0).value))
    }
    pub fn to_vec(&self) -> Vec<u8> {
        let length = op(Op::CopyBytesLength, self.0.0, 0, 0).length;
        let mut bytes = vec![0; length];
        let reply = invoke(Op::CopyBytes, self.0.0, 0, 0, bytes.as_mut_ptr(), length, 0.0);
        assert_eq!(reply.length, length, "native byte copy length contract"); bytes
    }
    pub fn to_string(&self) -> JsValue { JsValue(op(Op::Uint8String, self.0.0, 0, 0).value) }
}
impl JsError { pub fn new(message: &str) -> Self { Self(text(Op::NewError, message)) } }

pub trait UnwrapThrowExt<T> { fn unwrap_throw(self) -> T; }
impl<T> UnwrapThrowExt<T> for Option<T> { fn unwrap_throw(self) -> T { self.expect("native Amaro internal Option invariant") } }
impl<T, E: fmt::Debug> UnwrapThrowExt<T> for Result<T, E> { fn unwrap_throw(self) -> T { self.expect("native Amaro internal Result invariant") } }

pub mod convert {
    use super::JsValue;
    pub trait IntoWasmAbi { fn into_abi(self) -> u32; }
    impl IntoWasmAbi for JsValue { fn into_abi(self) -> u32 { self.0 } }
    impl IntoWasmAbi for &JsValue { fn into_abi(self) -> u32 { self.0 } }
    pub trait FromWasmAbi { unsafe fn from_abi(value: u32) -> Self; }
    impl FromWasmAbi for JsValue { unsafe fn from_abi(value: u32) -> Self { Self(value) } }
    pub struct Borrowed(JsValue);
    impl AsRef<JsValue> for Borrowed { fn as_ref(&self) -> &JsValue { &self.0 } }
    pub trait RefFromWasmAbi { unsafe fn ref_from_abi(value: u32) -> Borrowed; }
    impl RefFromWasmAbi for JsValue { unsafe fn ref_from_abi(value: u32) -> Borrowed { Borrowed(Self(value)) } }
}
pub fn display(value: &JsValue) -> String { value.rendered(Op::Display) }
pub mod prelude { pub use super::{JsError, JsValue, UnwrapThrowExt}; }
