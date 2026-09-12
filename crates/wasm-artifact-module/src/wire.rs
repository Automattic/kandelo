//! The host↔module byte format.
//!
//! # Why a hand-written format rather than JSON
//!
//! The module is `no_std`, and every byte it emits is read exactly once by one
//! decoder in `host/src/wasm-artifact-driver.ts`. A self-describing format
//! would buy interoperability this pair does not need and cost a serializer in
//! a crate whose whole point is to stay small enough to instantiate in a
//! process worker.
//!
//! # The rule that keeps the two sides honest
//!
//! Every record is length-prefixed and every blob opens with [`WIRE_VERSION`].
//! The driver refuses a version it does not know rather than reading the bytes
//! optimistically, because the failure mode of a silently-drifted binary format
//! is a *plausible wrong answer* about whether an artifact may run — which is
//! precisely the class of failure this crate exists to remove.
//!
//! Integers are little-endian and fixed-width. LEB128 is what the artifact
//! format uses; using it here as well would mean two decoders in the driver
//! where one is a walker of untrusted input and the other is a reader of the
//! module's own output, and conflating those was how the TypeScript reader
//! ended up with a 32-bit accumulator on a 64-bit quantity.

use alloc::string::String;
use alloc::vec::Vec;

/// The version every blob this module emits or accepts opens with.
///
/// Bump it when a record's shape changes. This is NOT the ABI epoch: it
/// versions one private host↔module format, not the platform's contract with
/// guest programs, so a change here does not imply an `ABI_VERSION` bump.
pub const WIRE_VERSION: u32 = 1;

/// A little-endian byte writer.
#[derive(Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Writer { bytes: Vec::new() }
    }

    /// Open a blob with the wire version.
    pub fn versioned() -> Self {
        let mut writer = Writer::new();
        writer.u32(WIRE_VERSION);
        writer
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub fn bool(&mut self, value: bool) {
        self.bytes.push(u8::from(value));
    }

    pub fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn i64(&mut self, value: i64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    /// A length-prefixed UTF-8 string.
    pub fn string(&mut self, value: &str) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value.as_bytes());
    }

    /// Length-prefixed raw bytes.
    pub fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value);
    }

    /// A count-prefixed list of strings.
    pub fn strings(&mut self, values: &[String]) {
        self.u32(values.len() as u32);
        for value in values {
            self.string(value);
        }
    }

    /// An optional `i32`, as a presence byte then the value.
    ///
    /// The value is written even when absent so a record's size does not depend
    /// on its content, which keeps a hand-checked offset stable while the format
    /// is being read by a human.
    pub fn option_i32(&mut self, value: Option<i32>) {
        self.bool(value.is_some());
        self.u32(value.unwrap_or(0) as u32);
    }

    /// An optional `u64`, as a presence byte then the value.
    pub fn option_u64(&mut self, value: Option<u64>) {
        self.bool(value.is_some());
        self.u64(value.unwrap_or(0));
    }
}

/// A little-endian byte reader over a request the driver wrote.
///
/// Every read is bounds-checked and returns `None` past the end. The module
/// treats a short request as a malformed request rather than reading whatever
/// follows it in linear memory: the driver is the module's only caller, but
/// "the only caller is trusted" is the assumption the previous reader made
/// before it read past the end of its buffer.
pub struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, offset: 0 }
    }

    /// Open a blob, checking the wire version.
    pub fn versioned(bytes: &'a [u8]) -> Option<Self> {
        let mut reader = Reader::new(bytes);
        match reader.u32()? {
            WIRE_VERSION => Some(reader),
            _ => None,
        }
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.offset.checked_add(len)?;
        let slice = self.bytes.get(self.offset..end)?;
        self.offset = end;
        Some(slice)
    }

    pub fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    pub fn bool(&mut self) -> Option<bool> {
        Some(self.u8()? != 0)
    }

    pub fn u32(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn str(&mut self) -> Option<&'a str> {
        let len = self.u32()? as usize;
        core::str::from_utf8(self.take(len)?).ok()
    }

    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    pub fn strings(&mut self) -> Option<Vec<&'a str>> {
        let count = self.u32()? as usize;
        let mut out = Vec::with_capacity(count.min(self.bytes.len()));
        for _ in 0..count {
            out.push(self.str()?);
        }
        Some(out)
    }
}
