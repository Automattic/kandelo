//! Copy original section headers verbatim, including padded LEB lengths.
use anyhow::{Result, ensure};
use std::io::Write;
use wasmparser::{Parser, Payload};

pub(crate) fn copy_without_custom(
    input: &[u8],
    output: &mut impl Write,
    omit: impl Fn(&str) -> bool,
) -> Result<()> {
    ensure!(
        input.starts_with(b"\0asm\x01\0\0\0"),
        "expected a core Wasm module"
    );
    output.write_all(&input[..8])?;
    let mut cursor = 8;
    for payload in Parser::new(0).parse_all(input) {
        let payload = payload?;
        if let Some((_, range)) = payload.as_section() {
            let skip = matches!(&payload, Payload::CustomSection(section) if omit(section.name()));
            ensure!(
                cursor <= range.start && range.end <= input.len(),
                "invalid section span"
            );
            if !skip {
                output.write_all(&input[cursor..range.end])?;
            }
            cursor = range.end;
        }
    }
    ensure!(cursor == input.len(), "unconsumed Wasm bytes");
    Ok(())
}
