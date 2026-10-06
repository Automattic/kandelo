//! Tiny shared helpers used across xtask modules.
//!
//! Kept deliberately minimal — anything that grows past a few lines or
//! gains domain-specific knowledge belongs in its caller's module.

/// Format a byte slice as lowercase hex (`0` → `"00"`, `255` → `"ff"`).
///
/// Used by the cache-key sha printer (`build_deps`) and the archive
/// sha verifier (`remote_fetch`); both expected the same encoding so
/// the function is consolidated here.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Decode a 64-character lowercase hex sha256 digest into 32 raw bytes.
///
/// The inverse of `hex` for the fixed-width case used throughout
/// `build_deps` (`cache_key_sha256`, `manifest_sha256`, ...): every value
/// this decodes is a sha256 digest, never an arbitrary-length blob.
pub fn hex_to_32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!(
            "expected a 64-character hex sha256 digest, got {} characters",
            s.len()
        ));
    }
    if !s.is_ascii() {
        // `s.len()` above is a BYTE count, so a 64-byte string can still
        // contain a multibyte UTF-8 character and fewer than 64 chars, with
        // a non-char-boundary landing inside one of the 2-byte slice
        // windows below. Reject it here instead of panicking on that slice.
        return Err(format!(
            "invalid hex digest {s:?}: expected 64 ASCII hex characters, found non-ASCII bytes"
        ));
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|error| {
            format!("invalid hex digest {s:?} at byte offset {i}: {error}")
        })?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{hex, hex_to_32};

    #[test]
    fn hex_empty_is_empty() {
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn hex_encodes_known_bytes() {
        assert_eq!(hex(&[0x00, 0x01, 0xab, 0xff]), "0001abff");
    }

    #[test]
    fn hex_length_is_double_input() {
        let v: Vec<u8> = (0u8..32).collect();
        assert_eq!(hex(&v).len(), 64);
    }

    #[test]
    fn hex_to_32_roundtrips_through_hex() {
        let bytes: Vec<u8> = (0u8..32).collect();
        let mut array = [0u8; 32];
        array.copy_from_slice(&bytes);
        assert_eq!(hex_to_32(&hex(&bytes)).unwrap(), array);
    }

    #[test]
    fn hex_to_32_rejects_wrong_length() {
        let error = hex_to_32("ab").unwrap_err();
        assert!(error.contains("64-character"), "{error}");
    }

    #[test]
    fn hex_to_32_rejects_non_hex_characters() {
        let error = hex_to_32(&"z".repeat(64)).unwrap_err();
        assert!(error.contains("invalid hex digest"), "{error}");
    }

    #[test]
    fn hex_to_32_rejects_a_64_byte_non_ascii_string_without_panicking() {
        // A multibyte UTF-8 character can make `s.len()` (a BYTE count) equal
        // 64 while `s` has fewer than 64 chars and a non-char-boundary sits
        // inside one of the 2-byte slice windows `hex_to_32` walks. This must
        // return an `Err`, not panic on a non-char-boundary slice index.
        let s = format!("{}{}", "0".repeat(61), '\u{20AC}'); // 61 + 3 bytes = 64 bytes
        assert_eq!(s.len(), 64);
        let error = hex_to_32(&s).unwrap_err();
        assert!(error.contains("invalid hex digest"), "{error}");
    }
}
