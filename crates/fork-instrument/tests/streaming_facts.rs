use flate2::{Compression, write::ZlibEncoder};
use fork_instrument::facts::{definitions::DefinitionIndex, stream::*};
use std::io::Write;

const FIRST: &str = "#kandelo-calltypes\t5\nM\té.c\nF\tfirst\t1\nD\tfirst\t0\t0\n";
const SECOND: &str = "#kandelo-calltypes\t5\nF\tsecond\t0\nD\tsecond\t0\t0\n";

fn pack(text: &str) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    let encoded = encoder.finish().unwrap();
    let mut frame = b"KCTZ\0\0\0\x01".to_vec();
    frame.extend_from_slice(&(text.len() as u64).to_le_bytes());
    frame.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
    frame.extend(encoded);
    frame
}

fn read(sections: &[&[u8]], limits: ReadLimits) -> anyhow::Result<(ReadReport, Vec<Vec<String>>)> {
    let mut chunks: Vec<Vec<String>> = vec![];
    let report = visit_lines(sections.iter().copied(), limits, |event| {
        match event {
            Event::Begin { chunk } => {
                assert_eq!(chunks.len(), chunk);
                chunks.push(vec![]);
            }
            Event::Line {
                chunk,
                number,
                text,
            } => {
                assert_eq!(chunks[chunk].len() + 1, number);
                chunks[chunk].push(text.to_owned());
            }
            Event::End { chunk } => assert_eq!(chunks.len(), chunk + 1),
        }
        Ok(())
    })?;
    Ok((report, chunks))
}

#[test]
fn plain_and_compressed_chunks_keep_order_across_every_section_boundary() {
    for bytes in [
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
        let expected = read(&[&bytes], ReadLimits::default()).unwrap();
        for split in 0..=bytes.len() {
            let (report, chunks) = read(
                &[&bytes[..split], &[], &bytes[split..]],
                ReadLimits::default(),
            )
            .unwrap();
            assert_eq!(chunks, expected.1);
            assert_eq!(report.decoded_bytes, expected.0.decoded_bytes);
        }
        let slices: Vec<_> = bytes.chunks(1).collect();
        assert_eq!(read(&slices, ReadLimits::default()).unwrap().1, expected.1);
        let definitions = DefinitionIndex::read(slices).unwrap();
        assert_eq!(definitions.chunks[0][0].name, "first");
        assert_eq!(definitions.chunks[1][0].name, "second");
        assert_eq!(definitions.decoded_bytes, expected.0.decoded_bytes);
    }
}

#[test]
fn compressed_frame_magic_can_straddle_the_input_read_buffer() {
    for suffix in 0..4 {
        let filler = 64 * 1024 - FIRST.len() - 3 - suffix;
        let prefix = format!("{FIRST}X\t{}\n", "x".repeat(filler));
        assert_eq!(prefix.len(), 64 * 1024 - suffix);
        let input = [prefix.into_bytes(), pack(SECOND)].concat();
        let (report, chunks) = read(&[&input], ReadLimits::default()).unwrap();
        assert_eq!(report.chunks, 2);
        assert_eq!(chunks[1][1], "F\tsecond\t0");
    }
}

#[test]
fn malformed_frames_never_produce_a_successful_facts_index() {
    let good = pack(FIRST);
    for length in [1, 4, 8, 23, good.len() - 1, good.len() - 4] {
        assert!(
            DefinitionIndex::read([&good[..length]]).is_err(),
            "length {length}"
        );
    }
    for offset in [7, 8, 16, 24, good.len() - 1] {
        let mut malformed = good.clone();
        malformed[offset] ^= 1;
        assert!(
            DefinitionIndex::read([malformed.as_slice()]).is_err(),
            "offset {offset}"
        );
    }
    let mut trailing = good.clone();
    let encoded = u64::from_le_bytes(trailing[16..24].try_into().unwrap());
    trailing[16..24].copy_from_slice(&(encoded + 1).to_le_bytes());
    trailing.push(0);
    assert!(DefinitionIndex::read([trailing.as_slice()]).is_err());
    for malformed in [
        pack(&format!("{FIRST}{SECOND}")),
        pack("not compiler facts\n"),
        pack(""),
        format!("#kandelo-calltypes\t5#kandelo-calltypes\t5\n").into_bytes(),
    ] {
        assert!(DefinitionIndex::read([malformed.as_slice()]).is_err());
    }
}

#[test]
fn line_chunk_and_aggregate_expansion_limits_apply_before_unbounded_growth() {
    let sources = [FIRST.as_bytes().to_vec(), pack(FIRST)];
    for bytes in sources {
        for limits in [
            ReadLimits {
                line_bytes: 10,
                ..Default::default()
            },
            ReadLimits {
                chunk_bytes: 10,
                ..Default::default()
            },
            ReadLimits {
                total_bytes: 10,
                ..Default::default()
            },
        ] {
            let error = read(&[&bytes], limits).unwrap_err();
            assert!(error.to_string().contains("budget"), "{error:#}");
        }
    }
    let input = [pack(FIRST), pack(SECOND)].concat();
    let limits = ReadLimits {
        total_bytes: FIRST.len() as u64,
        ..Default::default()
    };
    assert!(read(&[&input], limits).is_err());
    let plain = format!("{FIRST}X\t{}\n", "x".repeat(1024 * 1024));
    let compressed = pack(&plain);
    let error = DefinitionIndex::read([compressed.as_slice()]).unwrap_err();
    assert!(error.to_string().contains("line budget"), "{error:#}");
}

#[test]
fn crlf_and_final_lines_without_newlines_match_text_line_semantics() {
    let crlf = FIRST.replace('\n', "\r\n");
    let no_newline = SECOND.trim_end_matches('\n');
    let bytes = [pack(&crlf), no_newline.as_bytes().to_vec()].concat();
    let index = DefinitionIndex::read([bytes.as_slice()]).unwrap();
    assert_eq!(index.chunks[0][0].name, "first");
    assert_eq!(index.chunks[1][0].name, "second");
    assert_eq!(index.decoded_bytes, (crlf.len() + no_newline.len()) as u64);
}
