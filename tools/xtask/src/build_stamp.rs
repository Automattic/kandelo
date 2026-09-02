//! Write/read the `kandelo.build.key` custom section: the cache key a
//! locally-built wasm artifact was produced under. `verify-fresh` compares
//! this stamp against the freshly-computed expected key so a stale mirror
//! fails loud, independent of the ABI version.
//!
//! Append-only: we stamp exactly once, on a fresh build. Appending a
//! custom section to the tail of a valid module is valid and needs no
//! re-encoder; reads use the existing `wasmparser` dependency.

use wasmparser::{Parser, Payload};

pub(crate) const BUILD_KEY_SECTION: &str = "kandelo.build.key";

/// Whether these bytes are a wasm module at all (`\0asm` magic).
///
/// A package may declare non-module artifacts -- zip lazy-archives such as
/// `lsof-docs.zip` or a browser bundle's runtime archive -- as program
/// outputs. Only a wasm module can carry the build-key custom section, so
/// stamping and stamp verification both gate on this instead of parsing and
/// failing on bytes that were never wasm.
pub(crate) fn is_wasm_module(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x00, 0x61, 0x73, 0x6d])
}

pub(crate) fn read_build_key(wasm: &[u8]) -> Result<Option<[u8; 32]>, String> {
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse wasm for build key: {e}"))?;
        if let Payload::CustomSection(section) = payload {
            if section.name() == BUILD_KEY_SECTION {
                let data = section.data();
                if data.len() != 32 {
                    return Err(format!(
                        "{BUILD_KEY_SECTION} custom section is {} bytes, expected 32",
                        data.len()
                    ));
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(data);
                return Ok(Some(key));
            }
        }
    }
    Ok(None)
}

pub(crate) fn stamp_build_key(wasm: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if read_build_key(wasm)?.is_some() {
        return Err(format!(
            "wasm already carries a {BUILD_KEY_SECTION} section; refusing to double-stamp"
        ));
    }
    // Custom section: id(0x00) | uleb size | uleb name-len | name | payload
    let name = BUILD_KEY_SECTION.as_bytes();
    let mut body = Vec::new();
    write_uleb128(&mut body, name.len() as u64);
    body.extend_from_slice(name);
    body.extend_from_slice(key);

    let mut out = wasm.to_vec();
    out.push(0x00);
    write_uleb128(&mut out, body.len() as u64);
    out.extend_from_slice(&body);
    Ok(out)
}

fn write_uleb128(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal valid wasm module: magic + version, no sections.
    fn empty_module() -> Vec<u8> {
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn stamp_roundtrips() {
        let key = [7u8; 32];
        let stamped = stamp_build_key(&empty_module(), &key).unwrap();
        assert_eq!(read_build_key(&stamped).unwrap(), Some(key));
    }

    #[test]
    fn absent_section_reads_none() {
        assert_eq!(read_build_key(&empty_module()).unwrap(), None);
    }

    #[test]
    fn zip_bytes_are_not_a_wasm_module() {
        assert!(is_wasm_module(&empty_module()));
        assert!(!is_wasm_module(b"PK\x03\x04qux"));
        assert!(!is_wasm_module(b""));
    }

    #[test]
    fn double_stamp_is_an_error() {
        let once = stamp_build_key(&empty_module(), &[1u8; 32]).unwrap();
        let err = stamp_build_key(&once, &[2u8; 32]).unwrap_err();
        assert!(err.contains("already"), "{err}");
    }
}
