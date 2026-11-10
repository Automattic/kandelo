//! The installed compiler binds linked programs to its SDK's program ABI.
//! Existing foreign or duplicate identities are errors, never overwritten.

use wasm_artifact::{ABI_CONTRACT_SECTION as SECTION, read_artifact_facts, read_custom_section};

pub(super) fn stamp(bytes: &[u8], digest: &str) -> crate::Result<Option<Vec<u8>>> {
    let expected = decode_digest(digest)?;
    let facts =
        read_artifact_facts(bytes).map_err(|error| format!("reading program ABI: {error}"))?;
    if facts
        .custom_section_names
        .iter()
        .filter(|name| name.as_str() == SECTION)
        .count()
        > 1
    {
        return Err("program carries duplicate ABI contract sections".into());
    }
    let current = read_custom_section(bytes, SECTION);
    if let Some(current) = current {
        return if current == expected {
            Ok(None)
        } else {
            Err("program carries another ABI contract; rebuild it instead of restamping".into())
        };
    }
    let mut payload = Vec::new();
    leb(SECTION.len() as u32, &mut payload);
    payload.extend_from_slice(SECTION.as_bytes());
    payload.extend_from_slice(&expected);
    let mut result = bytes.to_vec();
    result.push(0); // Custom section.
    leb(payload.len() as u32, &mut result);
    result.extend(payload);
    Ok(Some(result))
}

fn decode_digest(value: &str) -> crate::Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("SDK program ABI digest must be 64 lowercase hexadecimal digits".into());
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn leb(mut value: u32, output: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const EMPTY: &[u8] = b"\0asm\x01\0\0\0";

    #[test]
    fn stamps_the_exact_digest_without_changing_existing_sections() {
        let mut input = EMPTY.to_vec();
        input.extend_from_slice(b"\x00\x05\x03tag\x07");
        let digest = "13".repeat(32);
        let stamped = stamp(&input, &digest).unwrap().unwrap();
        assert!(stamped.starts_with(&input));
        assert_eq!(read_custom_section(&stamped, "tag"), Some(&[7][..]));
        assert_eq!(
            read_custom_section(&stamped, SECTION),
            Some(&[0x13; 32][..])
        );
        assert!(stamp(&stamped, &digest).unwrap().is_none());
    }

    #[test]
    fn refuses_foreign_and_duplicate_contracts() {
        let first = stamp(EMPTY, &"12".repeat(32)).unwrap().unwrap();
        assert!(
            stamp(&first, &"34".repeat(32))
                .unwrap_err()
                .contains("another ABI")
        );
        let mut duplicate = first.clone();
        duplicate.extend_from_slice(&first[EMPTY.len()..]);
        assert!(
            stamp(&duplicate, &"12".repeat(32))
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn refuses_malformed_modules_components_and_digest_configuration() {
        let digest = "12".repeat(32);
        assert!(stamp(b"not a module", &digest).is_err());
        assert!(stamp(b"\0asm\x01\0\0\0\x00\x05\x01x", &digest).is_err());
        assert!(stamp(b"\0asm\x0d\0\x01\0", &digest).is_err());
        for invalid in [
            "".to_owned(),
            "0".repeat(63),
            "AA".repeat(32),
            "gg".repeat(32),
        ] {
            assert!(stamp(EMPTY, &invalid).is_err());
        }
    }
}
