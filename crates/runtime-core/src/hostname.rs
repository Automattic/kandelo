//! Host-name interpretation for `getaddrinfo(3)`: the `inet_aton(3)` numeric
//! address grammar and the DNS host-name syntax check.
//!
//! Both are pure computation over the caller's bytes. They used to live in
//! `host/src/networking/hostname.ts`, where each of four host network backends
//! called them before answering `host_getaddrinfo`, and the kernel performed
//! **no** name interpretation at all — `sys_getaddrinfo` handed the caller's
//! bytes straight to the host and trusted whatever came back. That made the
//! grammar a host-backend property rather than a kernel one, so a name's
//! meaning depended on which backend happened to be attached.
//!
//! The kernel now owns both. A numeric address never reaches a host backend,
//! and a syntactically impossible host name is refused before a resolver is
//! consulted.
//!
//! ## `inet_aton(3)` — implemented from the specification
//!
//! POSIX defines the numeric form for `inet_addr()`/`inet_aton()` as one of
//! `a.b.c.d`, `a.b.c`, `a.b`, or `a`, where the final part occupies all the
//! address bits the earlier parts did not, and where **each part is a C
//! integer constant**: a leading `0x`/`0X` means hexadecimal, an otherwise
//! leading `0` means octal, and anything else is decimal. That is also what
//! the musl `inet_aton` sitting above this kernel implements, via
//! `strtoul(s, &z, 0)`.
//!
//! The superseded TypeScript accepted only `^[0-9.]+$` and read every part as
//! decimal with `BigInt`, so it disagreed with the specification — and with
//! Kandelo's own libc — in two ways:
//!
//! * `010.010.010.010` parsed as `10.10.10.10`; per the specification the
//!   parts are octal and the address is `8.8.8.8`.
//! * `0x7f.1` was not recognised as numeric at all and fell through to DNS;
//!   per the specification it is `127.0.0.1`.
//!
//! This module follows the specification in both cases.
//!
//! ## Why a failed numeric parse still does not always reach the resolver
//!
//! `inet_aton` failing does not by itself make a string a host name.
//! RFC 1123 §2.1 is explicit: "a valid host name can never have the
//! dotted-decimal form #.#.#.#, since at least the highest-level component
//! label will be alphabetic". So `256.1` and `1.2.3.4.5` — numeric forms that
//! `inet_aton` rejects — are refused here as host names too, because their
//! top-level label is all-numeric. The rule is stated over the top-level label
//! rather than over "digits and dots", so it also refuses `example.123`, which
//! the TypeScript would have sent to a resolver.

use wasm_posix_shared::Errno;

/// Longest legal DNS name in wire form, including the terminating root label.
const DNS_MAX_WIRE_OCTETS: usize = 255;
/// Longest legal DNS label.
const DNS_MAX_LABEL_OCTETS: usize = 63;

/// Parse the numeric address forms `inet_aton(3)` accepts.
///
/// Returns the four address bytes in network order, or `None` when `name` is
/// not a numeric address — including when it *looks* numeric but overflows a
/// field, which `inet_aton` also reports as failure rather than as a wrapped
/// address.
pub fn parse_inet_aton(name: &[u8]) -> Option<[u8; 4]> {
    let mut parts = [0u32; 4];
    let mut count = 0usize;
    let mut rest = name;

    loop {
        // A fifth part, or a trailing '.', is not one of the four forms.
        if count == 4 {
            return None;
        }
        let (value, tail) = parse_c_integer(rest)?;
        parts[count] = value;
        count += 1;
        match tail.first() {
            None => break,
            Some(b'.') => rest = &tail[1..],
            // Any other trailing byte means this was never a numeric address.
            Some(_) => return None,
        }
    }

    // The last part occupies every address bit the earlier parts did not.
    let packed = match count {
        1 => parts[0],
        2 => {
            if parts[0] > 0xff || parts[1] > 0x00ff_ffff {
                return None;
            }
            (parts[0] << 24) | parts[1]
        }
        3 => {
            if parts[0] > 0xff || parts[1] > 0xff || parts[2] > 0xffff {
                return None;
            }
            (parts[0] << 24) | (parts[1] << 16) | parts[2]
        }
        _ => {
            if parts.iter().any(|part| *part > 0xff) {
                return None;
            }
            (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
        }
    };

    Some(packed.to_be_bytes())
}

/// Parse one part of a numeric address as a C integer constant.
///
/// Returns the value and the bytes following it. `None` when the part does not
/// begin with a digit — which is how the specification excludes a sign or
/// leading whitespace that `strtoul` would otherwise accept — or when the value
/// does not fit the 32 bits an IPv4 address has.
fn parse_c_integer(bytes: &[u8]) -> Option<(u32, &[u8])> {
    let first = *bytes.first()?;
    if !first.is_ascii_digit() {
        return None;
    }

    let hex_prefixed = first == b'0'
        && matches!(bytes.get(1), Some(b'x') | Some(b'X'))
        && bytes.get(2).is_some_and(u8::is_ascii_hexdigit);
    let (base, digits) = if hex_prefixed {
        (16u32, &bytes[2..])
    } else if first == b'0' {
        // A lone `0` leaves no further digits and is the value zero.
        (8u32, &bytes[1..])
    } else {
        (10u32, bytes)
    };

    let mut value: u32 = 0;
    let mut consumed = 0usize;
    for byte in digits {
        let digit = match byte {
            b'0'..=b'9' => u32::from(byte - b'0'),
            b'a'..=b'f' => u32::from(byte - b'a') + 10,
            b'A'..=b'F' => u32::from(byte - b'A') + 10,
            _ => break,
        };
        if digit >= base {
            break;
        }
        value = value.checked_mul(base)?.checked_add(digit)?;
        consumed += 1;
    }

    Some((value, &digits[consumed..]))
}

/// Check that `name` can be a DNS host name.
///
/// A single trailing dot is the root label: it is part of the caller's name and
/// is not an empty label. Returns `ENOENT`, the errno musl's
/// `__lookup_name` maps to `EAI_NONAME`, for anything that cannot resolve.
pub fn validate_dns_hostname(name: &[u8]) -> Result<(), Errno> {
    let absolute = match name.split_last() {
        Some((b'.', head)) => head,
        _ => name,
    };
    if absolute.is_empty() {
        return Err(Errno::ENOENT);
    }

    // One octet for the terminating root label.
    let mut wire_octets = 1usize;
    let mut top_label: &[u8] = &[];
    for label in absolute.split(|byte| *byte == b'.') {
        // RFC 1123 §2.1: letters, digits and hyphens, and a label may neither
        // begin nor end with a hyphen. The ASCII-only alphanumeric test also
        // excludes the non-ASCII bytes a resolver would have to punycode first.
        let (Some(first), Some(last)) = (label.first(), label.last()) else {
            return Err(Errno::ENOENT);
        };
        if label.len() > DNS_MAX_LABEL_OCTETS
            || !first.is_ascii_alphanumeric()
            || !last.is_ascii_alphanumeric()
            || !label
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return Err(Errno::ENOENT);
        }
        wire_octets += 1 + label.len();
        top_label = label;
    }

    if wire_octets > DNS_MAX_WIRE_OCTETS {
        return Err(Errno::ENOENT);
    }

    // RFC 1123 §2.1: the top-level label of a host name is never all-numeric,
    // which is what keeps a failed numeric address from becoming a DNS query.
    if top_label.iter().all(u8::is_ascii_digit) {
        return Err(Errno::ENOENT);
    }

    Ok(())
}

/// Resolve `name` without consulting a resolver, when the name says its own
/// address.
///
/// Returns `Ok(Some(addr))` for a numeric address, `Ok(None)` when `name` is a
/// syntactically valid host name that a resolver must answer, and `Err` when
/// the name cannot name a host at all.
pub fn resolve_locally(name: &[u8]) -> Result<Option<[u8; 4]>, Errno> {
    if let Some(addr) = parse_inet_aton(name) {
        return Ok(Some(addr));
    }
    validate_dns_hostname(name)?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str) -> Option<[u8; 4]> {
        parse_inet_aton(name.as_bytes())
    }

    #[test]
    fn parses_the_four_specified_forms() {
        assert_eq!(parse("127.0.0.1"), Some([127, 0, 0, 1]));
        assert_eq!(parse("127.1.1"), Some([127, 1, 0, 1]));
        assert_eq!(parse("127.1"), Some([127, 0, 0, 1]));
        assert_eq!(parse("2130706433"), Some([127, 0, 0, 1]));
    }

    #[test]
    fn the_final_part_fills_the_remaining_address_bits() {
        assert_eq!(parse("4294967295"), Some([255, 255, 255, 255]));
        assert_eq!(parse("255.16777215"), Some([255, 255, 255, 255]));
        assert_eq!(parse("255.255.65535"), Some([255, 255, 255, 255]));
    }

    #[test]
    fn a_leading_zero_is_octal_and_0x_is_hexadecimal() {
        // The superseded TypeScript answered 10.10.10.10 here.
        assert_eq!(parse("010.010.010.010"), Some([8, 8, 8, 8]));
        assert_eq!(parse("0177.0.0.01"), Some([127, 0, 0, 1]));
        // The superseded TypeScript did not recognise these as numeric at all.
        assert_eq!(parse("0x7f.1"), Some([127, 0, 0, 1]));
        assert_eq!(parse("0X7F000001"), Some([127, 0, 0, 1]));
        assert_eq!(parse("0xffffffff"), Some([255, 255, 255, 255]));
        // A lone zero is the value zero, not a truncated octal prefix.
        assert_eq!(parse("0"), Some([0, 0, 0, 0]));
        assert_eq!(parse("0.0.0.0"), Some([0, 0, 0, 0]));
    }

    #[test]
    fn rejects_a_part_that_does_not_fit_its_field() {
        assert_eq!(parse("4294967296"), None);
        assert_eq!(parse("256.1"), None);
        assert_eq!(parse("1.16777216"), None);
        assert_eq!(parse("1.256.1"), None);
        assert_eq!(parse("1.2.65536"), None);
        assert_eq!(parse("1.2.3.256"), None);
        assert_eq!(parse("0x100000000"), None);
    }

    #[test]
    fn rejects_malformed_numeric_shapes() {
        for name in [".", ".1", "1.", "1..2", "1.2.3.4.5", "", "+1.2.3.4", " 1"] {
            assert_eq!(parse(name), None, "{name} should not parse");
        }
        // A digit run that ends in a non-digit is not a numeric address; `09`
        // stops the octal scan at `9`, exactly as `strtoul` with base 0 does.
        assert_eq!(parse("09"), None);
        assert_eq!(parse("0x"), None);
        assert_eq!(parse("1.2.3.4x"), None);
    }

    #[test]
    fn leaves_ordinary_names_to_the_resolver() {
        assert_eq!(parse("example.com"), None);
        assert!(validate_dns_hostname(b"example.com").is_ok());
        assert!(validate_dns_hostname(b"example.com.").is_ok());
        assert_eq!(resolve_locally(b"example.com"), Ok(None));
    }

    #[test]
    fn accepts_the_longest_legal_wire_name_and_refuses_one_octet_more() {
        let mut longest = alloc::vec::Vec::new();
        for (index, length) in [63usize, 63, 63, 61].iter().enumerate() {
            if index > 0 {
                longest.push(b'.');
            }
            longest.extend(core::iter::repeat(b'a').take(*length));
        }
        assert!(validate_dns_hostname(&longest).is_ok());
        let mut with_root = longest.clone();
        with_root.push(b'.');
        assert!(validate_dns_hostname(&with_root).is_ok());

        let mut too_long = longest.clone();
        too_long.push(b'a');
        assert_eq!(validate_dns_hostname(&too_long), Err(Errno::ENOENT));
    }

    #[test]
    fn refuses_names_no_resolver_can_answer() {
        for name in [
            &b"www.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com"[..],
            b".example.com",
            b"example..com",
            b"-example.com",
            b"example-.com",
            b"m\xc3\xbcnich.example",
            b"",
            b".",
            b"under_score.example",
        ] {
            assert_eq!(
                validate_dns_hostname(name),
                Err(Errno::ENOENT),
                "{:?} should be refused",
                core::str::from_utf8(name)
            );
        }
    }

    #[test]
    fn refuses_an_all_numeric_top_level_label() {
        // RFC 1123 §2.1. These are also the numeric forms `inet_aton` refuses,
        // which is what keeps them from reaching a resolver.
        assert_eq!(resolve_locally(b"256.1"), Err(Errno::ENOENT));
        assert_eq!(resolve_locally(b"1.2.3.4.5"), Err(Errno::ENOENT));
        assert_eq!(resolve_locally(b"4294967296"), Err(Errno::ENOENT));
        assert_eq!(resolve_locally(b"example.123"), Err(Errno::ENOENT));
        // A numeric label that is not the top-level one is legal.
        assert_eq!(resolve_locally(b"123.example"), Ok(None));
    }

    #[test]
    fn resolves_numeric_names_without_a_resolver() {
        assert_eq!(resolve_locally(b"127.0.0.1"), Ok(Some([127, 0, 0, 1])));
        assert_eq!(resolve_locally(b"010.1"), Ok(Some([8, 0, 0, 1])));
    }

}
