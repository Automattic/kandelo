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

#[cfg(test)]
mod tests {
    use super::hex;

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
}
