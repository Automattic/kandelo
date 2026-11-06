//! Exchange item IDs: kernel-issued UUIDs that can be validated without
//! storing anything per ID.
//!
//! Every exchange item (a batch, an entry inside a batch, a published output)
//! carries one, as the read-only xattr `user.kandelo.id`. The layout is custom,
//! so the version is 8 (RFC 9562 §5.8). Fields are big-endian, so sorting the
//! canonical text form sorts by issue order:
//!
//! | Bits | Field |
//! |---|---|
//! | 48 | Unix time in milliseconds, clamped so it never goes backwards |
//! | 4  | Version `8` |
//! | 12 | Counter, high bits |
//! | 2  | Variant `10` |
//! | 20 | Counter, low bits |
//! | 42 | Mount nonce, random, chosen when the mount is created |
//!
//! An ID is valid on this mount when its version and variant are right, its
//! nonce is this mount's, and its counter is below the next counter. A counter
//! value is consumed only when an item is created, so every valid ID names a
//! real item, including items since removed: provenance references history,
//! not live objects.

use wasm_posix_shared::Errno;

/// One exchange ID, 16 bytes.
pub type ExchangeId = [u8; 16];

/// Length of the canonical text form (`8-4-4-4-12` hex digits).
pub const EXCHANGE_ID_TEXT_LEN: usize = 36;

const VERSION: u8 = 8;
const VARIANT: u8 = 0b10;
const NONCE_BITS: u32 = 42;
const NONCE_MASK: u64 = (1 << NONCE_BITS) - 1;
const TIMESTAMP_MASK: u64 = (1 << 48) - 1;

/// Issues and validates the IDs of one exchange mount.
pub struct IdIssuer {
    nonce: u64,
    next_counter: u64,
    last_ms: u64,
}

impl IdIssuer {
    /// A fresh issuer. `nonce` should come from the host's random source; only
    /// its low 42 bits are used.
    pub const fn new(nonce: u64) -> Self {
        IdIssuer {
            nonce: nonce & NONCE_MASK,
            next_counter: 0,
            last_ms: 0,
        }
    }

    /// Issue the next ID. `now_ms` is Unix time in milliseconds; a clock that
    /// moves backwards is clamped to the last time issued, so IDs still sort
    /// in issue order. Fails with ENOSPC once all 2^32 counter values are used.
    pub fn issue(&mut self, now_ms: u64) -> Result<ExchangeId, Errno> {
        if self.next_counter > u64::from(u32::MAX) {
            return Err(Errno::ENOSPC);
        }
        let ms = now_ms.max(self.last_ms) & TIMESTAMP_MASK;
        self.last_ms = ms;
        let counter = self.next_counter as u32;
        self.next_counter += 1;
        Ok(encode(ms, counter, self.nonce))
    }

    /// Whether `id` was issued by this mount.
    pub fn validate(&self, id: &ExchangeId) -> Result<(), Errno> {
        let fields = decode(id).ok_or(Errno::EINVAL)?;
        if fields.nonce != self.nonce || u64::from(fields.counter) >= self.next_counter {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }
}

struct Fields {
    counter: u32,
    nonce: u64,
}

fn encode(ms: u64, counter: u32, nonce: u64) -> ExchangeId {
    let high = (ms << 16) | (u64::from(VERSION) << 12) | u64::from(counter >> 20);
    let low = (u64::from(VARIANT) << 62) | (u64::from(counter & 0xF_FFFF) << NONCE_BITS) | nonce;
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&high.to_be_bytes());
    id[8..].copy_from_slice(&low.to_be_bytes());
    id
}

fn decode(id: &ExchangeId) -> Option<Fields> {
    let high = u64::from_be_bytes(id[..8].try_into().ok()?);
    let low = u64::from_be_bytes(id[8..].try_into().ok()?);
    if (high >> 12) & 0xF != u64::from(VERSION) || low >> 62 != u64::from(VARIANT) {
        return None;
    }
    let counter_high = (high & 0xFFF) as u32;
    let counter_low = ((low >> NONCE_BITS) & 0xF_FFFF) as u32;
    Some(Fields {
        counter: (counter_high << 20) | counter_low,
        nonce: low & NONCE_MASK,
    })
}

/// Canonical lowercase text form, `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
pub fn format(id: &ExchangeId) -> [u8; EXCHANGE_ID_TEXT_LEN] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [b'-'; EXCHANGE_ID_TEXT_LEN];
    let mut position = 0;
    for (index, byte) in id.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            position += 1;
        }
        out[position] = HEX[usize::from(byte >> 4)];
        out[position + 1] = HEX[usize::from(byte & 0xF)];
        position += 2;
    }
    out
}

/// Parse the canonical text form. Only lowercase hex is accepted, so every ID
/// has exactly one spelling; anything else is EINVAL.
pub fn parse(text: &[u8]) -> Result<ExchangeId, Errno> {
    if text.len() != EXCHANGE_ID_TEXT_LEN {
        return Err(Errno::EINVAL);
    }
    let mut id = [0u8; 16];
    let mut nibbles = 0usize;
    for (index, &character) in text.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if character != b'-' {
                return Err(Errno::EINVAL);
            }
            continue;
        }
        let value = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            _ => return Err(Errno::EINVAL),
        };
        id[nibbles / 2] |= if nibbles % 2 == 0 { value << 4 } else { value };
        nibbles += 1;
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[test]
    fn issued_ids_are_version_8_variant_10_and_round_trip_as_text() {
        let mut issuer = IdIssuer::new(0x2A5_5555_5555);
        let id = issuer.issue(1_761_100_000_000).unwrap();
        let text = format(&id);
        assert_eq!(text[14], b'8', "version nibble");
        assert!(matches!(text[19], b'8' | b'9' | b'a' | b'b'), "variant 10");
        assert_eq!(parse(&text).unwrap(), id);
        assert!(text.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c) || *c == b'-'));
    }

    #[test]
    fn text_order_is_issue_order_even_within_one_millisecond() {
        let mut issuer = IdIssuer::new(7);
        let mut texts = Vec::new();
        for step in 0..3000u64 {
            // Many IDs per millisecond, then a clock that steps backwards.
            let now = 1_000 + step / 500 - if step == 2500 { 900 } else { 0 };
            texts.push(format(&issuer.issue(now).unwrap()));
        }
        let mut sorted = texts.clone();
        sorted.sort();
        assert_eq!(sorted, texts);
    }

    #[test]
    fn validation_needs_this_mounts_nonce_and_an_issued_counter() {
        let mut issuer = IdIssuer::new(0x123);
        let first = issuer.issue(5).unwrap();
        let second = issuer.issue(5).unwrap();
        assert_eq!(issuer.validate(&first), Ok(()));
        assert_eq!(issuer.validate(&second), Ok(()));

        let other_mount = IdIssuer::new(0x124);
        assert_eq!(other_mount.validate(&first), Err(Errno::EINVAL));

        let future = encode(5, 2, 0x123);
        assert_eq!(issuer.validate(&future), Err(Errno::EINVAL));

        let mut wrong_version = first;
        wrong_version[6] = (wrong_version[6] & 0x0F) | 0x40;
        assert_eq!(issuer.validate(&wrong_version), Err(Errno::EINVAL));
        let mut wrong_variant = first;
        wrong_variant[8] &= 0x3F;
        assert_eq!(issuer.validate(&wrong_variant), Err(Errno::EINVAL));
    }

    #[test]
    fn the_counter_is_exhausted_after_2_pow_32_items() {
        let mut issuer = IdIssuer::new(1);
        issuer.next_counter = u64::from(u32::MAX);
        let last = issuer.issue(9).unwrap();
        assert_eq!(issuer.validate(&last), Ok(()));
        assert_eq!(issuer.issue(9), Err(Errno::ENOSPC));
    }

    #[test]
    fn parse_rejects_anything_but_the_canonical_form() {
        let id = IdIssuer::new(0x2AB_CDEF_ABCD).issue(0xABC_DEF0).unwrap();
        let text = format(&id);
        let mut upper = text;
        upper.make_ascii_uppercase();
        assert_ne!(upper, text, "the example must contain hex letters");
        assert_eq!(parse(&upper), Err(Errno::EINVAL));
        assert_eq!(parse(&text[..35]), Err(Errno::EINVAL));
        let mut misplaced = text;
        misplaced.swap(8, 9);
        assert_eq!(parse(&misplaced), Err(Errno::EINVAL));
        assert_eq!(parse(b"7"), Err(Errno::EINVAL));
    }
}
