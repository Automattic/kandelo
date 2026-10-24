//! Bounded counterpart to the Vec-returning oracle API. Only feature names
//! and one small custom section are retained; all other bytes are borrowed.
use super::*;
use std::io::Write;
use wasm_encoder::Encode;

pub fn write_declared_features(input: &[u8], output: &mut impl Write, budget: usize) -> Result<()> {
    let used = used_features(input)?;
    let mut entries = Vec::new();
    let mut seen = false;
    for payload in Parser::new(0).parse_all(input) {
        let Payload::CustomSection(section) = payload? else {
            continue;
        };
        if section.name() != SECTION {
            continue;
        }
        ensure!(!seen, "module has more than one target_features section");
        seen = true;
        ensure!(
            section.range().len() <= budget,
            "target_features exceeds metadata budget"
        );
        let mut reader = wasmparser::BinaryReader::new(section.data(), 0);
        let count = reader.read_var_u32()? as usize;
        ensure!(
            count <= budget / 64,
            "target feature entries exceed metadata budget"
        );
        for _ in 0..count {
            entries.push((reader.read_u8()?, reader.read_string()?));
        }
        ensure!(reader.eof(), "target_features has trailing bytes");
    }
    for feature in used {
        match entries.iter().find(|(_, name)| *name == feature) {
            Some((b'-', _)) => {
                bail!("module disallows the `{feature}` feature, which its instrumented code uses")
            }
            Some(_) => {}
            None => entries.push((b'+', feature)),
        }
    }
    let mut data = Vec::new();
    write_u32(&mut data, u32::try_from(entries.len())?);
    for (prefix, name) in entries {
        ensure!(
            data.len()
                .checked_add(name.len())
                .and_then(|n| n.checked_add(6))
                .is_some_and(|bytes| bytes <= budget),
            "target_features exceeds output budget"
        );
        data.push(prefix);
        write_u32(&mut data, u32::try_from(name.len())?);
        data.extend_from_slice(name.as_bytes());
    }
    let mut section = vec![0];
    wasm_encoder::CustomSection {
        name: SECTION.into(),
        data: data.into(),
    }
    .encode(&mut section);
    ensure!(
        section.len() <= budget,
        "target_features exceeds output budget"
    );
    crate::artifact_io::copy_without_custom(input, output, |name| name == SECTION)?;
    output.write_all(&section)?;
    Ok(())
}
