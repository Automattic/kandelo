//! Lossless storage for large compiler-facts chunks. The logical format stays
//! version 5; wasm-ld can concatenate plain and framed chunks in any order.
use anyhow::{Context, Result, ensure};
use flate2::{Decompress, FlushDecompress, Status};

const MAGIC: &[u8; 8] = b"KCTZ\0\0\0\x01";
const HEADER_BYTES: usize = 24;
// Bound allocation before trusting an input's declared expansion. Decode and
// parse one unit at a time, so a large link does not retain all expanded text.
const MAX_CHUNK_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;

pub(super) fn visit_chunks(
    mut section: &[u8],
    mut visit: impl FnMut(usize, &str) -> Result<()>,
) -> Result<()> {
    ensure!(!section.is_empty(), "empty facts section");
    let mut index = 0;
    let mut total = 0u64;
    let mut parse = |text: &str| -> Result<()> {
        for chunk in super::side::split_chunks(text)? {
            ensure!(
                chunk.len() as u64 <= MAX_CHUNK_BYTES,
                "facts chunk exceeds decoded size limit"
            );
            total = total
                .checked_add(chunk.len() as u64)
                .context("facts decoded size overflow")?;
            ensure!(
                total <= MAX_TOTAL_BYTES,
                "facts section exceeds decoded size limit"
            );
            visit(index, chunk)?;
            index += 1;
        }
        Ok(())
    };
    while !section.is_empty() {
        if section.starts_with(b"KCTZ") {
            ensure!(
                section.len() >= HEADER_BYTES,
                "truncated compressed facts header"
            );
            ensure!(
                &section[..8] == MAGIC,
                "unsupported compressed facts encoding"
            );
            let decoded = u64::from_le_bytes(section[8..16].try_into().unwrap());
            let encoded = u64::from_le_bytes(section[16..24].try_into().unwrap());
            ensure!(
                decoded <= MAX_CHUNK_BYTES,
                "compressed facts chunk exceeds decoded size limit"
            );
            let encoded = usize::try_from(encoded).context("compressed facts length overflow")?;
            let end = HEADER_BYTES
                .checked_add(encoded)
                .context("compressed facts length overflow")?;
            let payload = section
                .get(HEADER_BYTES..end)
                .context("truncated compressed facts payload")?;
            let decoded = usize::try_from(decoded).context("decoded facts length overflow")?;
            let mut text = Vec::new();
            text.try_reserve_exact(decoded)
                .context("allocating decoded facts chunk")?;
            text.resize(decoded, 0);
            let mut inflater = Decompress::new(true);
            let status = inflater
                .decompress(payload, &mut text, FlushDecompress::Finish)
                .context("invalid compressed facts payload")?;
            ensure!(
                status == Status::StreamEnd,
                "incomplete compressed facts stream"
            );
            ensure!(
                inflater.total_in() == encoded as u64,
                "trailing compressed facts bytes"
            );
            ensure!(
                inflater.total_out() == decoded as u64,
                "compressed facts decoded length mismatch"
            );
            let text = std::str::from_utf8(&text).context("decoded facts chunk is not UTF-8")?;
            ensure!(
                super::side::split_chunks(text)?.len() == 1,
                "compressed frame must contain one facts chunk"
            );
            parse(text)?;
            section = &section[end..];
        } else {
            // A packed chunk follows the newline ending a plain object chunk.
            // Never search inside a packed stream: its exact length frames it.
            let end = section
                .windows(MAGIC.len())
                .enumerate()
                .find(|(i, bytes)| *bytes == MAGIC && (*i == 0 || section[*i - 1] == b'\n'))
                .map_or(section.len(), |(i, _)| i);
            parse(std::str::from_utf8(&section[..end]).context("facts section is not UTF-8")?)?;
            section = &section[end..];
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::ZlibEncoder};
    use std::io::Write;

    const FIRST: &str =
        "#kandelo-calltypes\t5\nM\tfirst.c\nF\tmain\t0\tE\t0\tmain\nD\tmain\t0\t0\n";
    const SECOND: &str = "#kandelo-calltypes\t5\nM\tsecond.c\n";

    fn pack(text: &str) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        let payload = encoder.finish().unwrap();
        let mut frame = MAGIC.to_vec();
        frame.extend_from_slice(&(text.len() as u64).to_le_bytes());
        frame.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        frame.extend(payload);
        frame
    }

    fn decode(section: &[u8]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        visit_chunks(section, |i, text| {
            assert_eq!(i, out.len());
            out.push(text.to_owned());
            Ok(())
        })?;
        Ok(out)
    }

    #[test]
    fn preserves_chunk_order_for_plain_and_compressed_objects() {
        for section in [
            [FIRST.as_bytes(), SECOND.as_bytes()].concat(),
            [pack(FIRST), pack(SECOND)].concat(),
            [
                FIRST.as_bytes().to_vec(),
                pack(SECOND),
                pack(FIRST),
                SECOND.as_bytes().to_vec(),
            ]
            .concat(),
        ] {
            let chunks = decode(&section).unwrap();
            assert_eq!(
                chunks,
                if chunks.len() == 4 {
                    vec![FIRST, SECOND, FIRST, SECOND]
                } else {
                    vec![FIRST, SECOND]
                }
            );
        }
    }

    #[test]
    fn rejects_malformed_frames_without_losing_facts() {
        let packed = pack(FIRST);
        for length in [4, 8, 23, packed.len() - 1] {
            assert!(decode(&packed[..length]).is_err());
        }
        for offset in [7, 8, 16, 24] {
            let mut malformed = packed.clone();
            malformed[offset] ^= 1;
            assert!(decode(&malformed).is_err(), "offset {offset}");
        }
        let mut oversized = packed.clone();
        oversized[8..16].copy_from_slice(&(MAX_CHUNK_BYTES + 1).to_le_bytes());
        assert!(decode(&oversized).is_err());
        assert!(decode(&pack("not compiler facts")).is_err());
        assert!(decode(&pack(&format!("{FIRST}{SECOND}"))).is_err());
        let mut trailing = packed;
        let length = u64::from_le_bytes(trailing[16..24].try_into().unwrap());
        trailing[16..24].copy_from_slice(&(length + 1).to_le_bytes());
        trailing.push(0);
        assert!(decode(&trailing).is_err());
    }
}
