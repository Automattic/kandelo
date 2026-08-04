//! Mark definitions in a relocatable WebAssembly archive as weak fallbacks.
//!
//! LLVM's object model understands weak Wasm symbols, but llvm-objcopy does
//! not currently implement symbol rewriting for Wasm. This transformer edits
//! only the binding bit in each member's linking symbol table. Because the
//! encoded value keeps the same length, archive offsets and symbol indexes
//! remain authoritative.

use std::fs;
use std::path::PathBuf;

use wasmparser::{KnownCustom, Linking, Parser, Payload};

const ARCHIVE_MAGIC: &[u8; 8] = b"!<arch>\n";
const ARCHIVE_HEADER_LEN: usize = 60;
const WASM_MAGIC: &[u8; 4] = b"\0asm";
const BINDING_WEAK: u32 = 1 << 0;
const BINDING_LOCAL: u32 = 1 << 1;
const UNDEFINED: u32 = 1 << 4;
const SYMBOL_KIND_SECTION: u8 = 3;

#[derive(Debug, Default, PartialEq, Eq)]
struct WeakenedArchive {
    bytes: Vec<u8>,
    object_members: usize,
    weakened_symbols: usize,
}

fn read_u32_leb(bytes: &[u8], start: usize) -> Result<(u32, usize), String> {
    let mut value = 0u32;
    for index in 0..5 {
        let offset = start
            .checked_add(index)
            .ok_or_else(|| "LEB128 offset overflow".to_string())?;
        let byte = *bytes
            .get(offset)
            .ok_or_else(|| "truncated symbol flags".to_string())?;
        if index == 4 && byte & 0xf0 != 0 {
            return Err("symbol flags overflow u32".to_string());
        }
        value |= u32::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
    }
    Err("symbol flags exceed five-byte u32 LEB128".to_string())
}

fn weaken_object_symbols(bytes: &mut [u8]) -> Result<usize, String> {
    let mut flag_offsets = Vec::new();
    let mut linking_sections = 0usize;
    let mut symbol_tables = 0usize;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|error| format!("parse Wasm object: {error}"))?;
        let Payload::CustomSection(section) = payload else {
            continue;
        };
        if section.name() != "linking" {
            continue;
        }
        linking_sections += 1;
        let KnownCustom::Linking(linking) = section.as_known() else {
            return Err("malformed or unsupported linking custom section".to_string());
        };
        for subsection in linking {
            let subsection =
                subsection.map_err(|error| format!("parse linking section: {error}"))?;
            let Linking::SymbolTable(symbols) = subsection else {
                continue;
            };
            symbol_tables += 1;
            for symbol in symbols.into_iter_with_offsets() {
                let (offset, _) =
                    symbol.map_err(|error| format!("parse linking symbol: {error}"))?;
                let kind = *bytes
                    .get(offset)
                    .ok_or_else(|| "symbol kind lies outside the Wasm object".to_string())?;
                let flags_offset = offset
                    .checked_add(1)
                    .ok_or_else(|| "symbol flags offset overflow".to_string())?;
                let (flags, _) = read_u32_leb(bytes, flags_offset)?;
                if kind != SYMBOL_KIND_SECTION
                    && flags & (BINDING_WEAK | BINDING_LOCAL | UNDEFINED) == 0
                {
                    flag_offsets.push(flags_offset);
                }
            }
        }
    }

    if linking_sections != 1 {
        return Err(format!(
            "expected one linking custom section, found {linking_sections}"
        ));
    }
    // LLVM omits the symbol-table subsection for legitimate relocatable
    // objects with no symbols (musl has several architecture placeholders).
    if symbol_tables > 1 {
        return Err(format!(
            "expected at most one linking symbol table, found {symbol_tables}"
        ));
    }

    for offset in &flag_offsets {
        // WHY: BINDING_WEAK is the low bit of the flags ULEB. Setting it in
        // place cannot change the encoded width, so every relocation and ar
        // member offset remains byte-for-byte stable.
        bytes[*offset] |= BINDING_WEAK as u8;
    }
    Ok(flag_offsets.len())
}

fn archive_member_size(header: &[u8], header_offset: usize) -> Result<usize, String> {
    let raw = std::str::from_utf8(&header[48..58])
        .map_err(|_| format!("archive member at {header_offset} has a non-UTF-8 size"))?;
    raw.trim()
        .parse::<usize>()
        .map_err(|_| format!("archive member at {header_offset} has invalid size {raw:?}"))
}

fn archive_object_start(
    header: &[u8],
    data_start: usize,
    data_end: usize,
    header_offset: usize,
) -> Result<usize, String> {
    let name = std::str::from_utf8(&header[..16])
        .map_err(|_| format!("archive member at {header_offset} has a non-UTF-8 name"))?
        .trim();
    let Some(length) = name.strip_prefix("#1/") else {
        return Ok(data_start);
    };
    let length = length
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("archive member at {header_offset} has invalid BSD name length"))?;
    let object_start = data_start
        .checked_add(length)
        .ok_or_else(|| "archive extended-name offset overflow".to_string())?;
    if object_start > data_end {
        return Err(format!(
            "archive member at {header_offset} has an out-of-bounds BSD name"
        ));
    }
    Ok(object_start)
}

fn weaken_archive(input: &[u8]) -> Result<WeakenedArchive, String> {
    if !input.starts_with(ARCHIVE_MAGIC) {
        return Err("input is not a regular Unix archive".to_string());
    }

    let mut output = input.to_vec();
    let mut offset = ARCHIVE_MAGIC.len();
    let mut object_members = 0usize;
    let mut weakened_symbols = 0usize;

    while offset < input.len() {
        let header_end = offset
            .checked_add(ARCHIVE_HEADER_LEN)
            .ok_or_else(|| "archive header offset overflow".to_string())?;
        let header = input
            .get(offset..header_end)
            .ok_or_else(|| format!("truncated archive header at {offset}"))?;
        if &header[58..60] != b"`\n" {
            return Err(format!("invalid archive header terminator at {offset}"));
        }
        let size = archive_member_size(header, offset)?;
        let data_start = header_end;
        let data_end = data_start
            .checked_add(size)
            .ok_or_else(|| "archive member size overflow".to_string())?;
        if data_end > input.len() {
            return Err(format!(
                "archive member at {offset} extends past end of file"
            ));
        }
        let object_start = archive_object_start(header, data_start, data_end, offset)?;
        if input
            .get(object_start..object_start + WASM_MAGIC.len())
            .is_some_and(|magic| magic == WASM_MAGIC)
        {
            object_members += 1;
            weakened_symbols += weaken_object_symbols(&mut output[object_start..data_end])?;
        }
        offset = data_end
            .checked_add(size & 1)
            .ok_or_else(|| "archive padding offset overflow".to_string())?;
        if offset > input.len() {
            return Err("archive is missing its final padding byte".to_string());
        }
    }

    if object_members == 0 {
        return Err("archive contains no relocatable WebAssembly members".to_string());
    }
    Ok(WeakenedArchive {
        bytes: output,
        object_members,
        weakened_symbols,
    })
}

fn parse_args(args: Vec<String>) -> Result<(PathBuf, PathBuf), String> {
    if args.len() != 2 {
        return Err("usage: xtask weaken-wasm-archive <input.a> <output.a>".to_string());
    }
    let input = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    if input == output {
        return Err("input and output archive paths must differ".to_string());
    }
    Ok((input, output))
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let (input_path, output_path) = parse_args(args)?;
    let input =
        fs::read(&input_path).map_err(|error| format!("read {}: {error}", input_path.display()))?;
    let weakened = weaken_archive(&input)?;
    fs::write(&output_path, &weakened.bytes)
        .map_err(|error| format!("write {}: {error}", output_path.display()))?;
    eprintln!(
        "weaken-wasm-archive: weakened {} definitions across {} Wasm members",
        weakened.weakened_symbols, weakened.object_members
    );
    Ok(())
}

pub fn run_object(args: Vec<String>) -> Result<(), String> {
    if args.len() != 2 {
        return Err("usage: xtask weaken-wasm-object <input.o> <output.o>".to_string());
    }
    let input_path = PathBuf::from(&args[0]);
    let output_path = PathBuf::from(&args[1]);
    if input_path == output_path {
        return Err("input and output object paths must differ".to_string());
    }
    let mut bytes =
        fs::read(&input_path).map_err(|error| format!("read {}: {error}", input_path.display()))?;
    if !bytes.starts_with(WASM_MAGIC) {
        return Err("input is not a WebAssembly object".to_string());
    }
    let weakened_symbols = weaken_object_symbols(&mut bytes)?;
    fs::write(&output_path, bytes)
        .map_err(|error| format!("write {}: {error}", output_path.display()))?;
    eprintln!("weaken-wasm-object: weakened {weakened_symbols} definitions");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_leb(mut value: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn push_name(bytes: &mut Vec<u8>, name: &str) {
        bytes.extend(u32_leb(name.len() as u32));
        bytes.extend(name.as_bytes());
    }

    fn fixture_object() -> Vec<u8> {
        let mut symbols = Vec::new();
        symbols.extend(u32_leb(4));
        // Defined hidden function: becomes weak+hidden.
        symbols.extend([0, 4, 0]);
        push_name(&mut symbols, "fallback");
        // Undefined function: remains undefined, not weak.
        symbols.extend([0, UNDEFINED as u8, 1]);
        // Local data: remains local, not weak.
        symbols.extend([1, BINDING_LOCAL as u8]);
        push_name(&mut symbols, "local_data");
        symbols.extend([0, 0, 1]);
        // Section symbol: is never a linkable fallback definition.
        symbols.extend([SYMBOL_KIND_SECTION, 0, 0]);

        let mut linking = vec![2, 8];
        linking.extend(u32_leb(symbols.len() as u32));
        linking.extend(symbols);

        let mut custom = Vec::new();
        push_name(&mut custom, "linking");
        custom.extend(linking);

        let mut module = b"\0asm\x01\0\0\0".to_vec();
        module.push(0);
        module.extend(u32_leb(custom.len() as u32));
        module.extend(custom);
        module
    }

    fn fixture_archive_member(name: &str, bytes: &[u8]) -> Vec<u8> {
        let mut header = [b' '; ARCHIVE_HEADER_LEN];
        let name = format!("{name}/");
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[16] = b'0';
        header[28] = b'0';
        header[34] = b'0';
        header[40..46].copy_from_slice(b"100644");
        let size = bytes.len().to_string();
        header[48..48 + size.len()].copy_from_slice(size.as_bytes());
        header[58..60].copy_from_slice(b"`\n");
        let mut member = header.to_vec();
        member.extend(bytes);
        if bytes.len() & 1 != 0 {
            member.push(b'\n');
        }
        member
    }

    #[test]
    fn weakens_only_defined_global_symbols_without_changing_size() {
        let mut object = fixture_object();
        let original_len = object.len();
        assert_eq!(weaken_object_symbols(&mut object).unwrap(), 1);
        assert_eq!(object.len(), original_len);
        assert_eq!(weaken_object_symbols(&mut object).unwrap(), 0);
    }

    #[test]
    fn preserves_archive_layout_and_non_wasm_members() {
        let object = fixture_object();
        let text = b"symbol index";
        let mut archive = ARCHIVE_MAGIC.to_vec();
        archive.extend(fixture_archive_member("/", text));
        archive.extend(fixture_archive_member("fallback.o", &object));

        let weakened = weaken_archive(&archive).unwrap();
        assert_eq!(weakened.object_members, 1);
        assert_eq!(weakened.weakened_symbols, 1);
        assert_eq!(weakened.bytes.len(), archive.len());
        assert_eq!(
            weakened
                .bytes
                .iter()
                .zip(&archive)
                .filter(|(left, right)| left != right)
                .count(),
            1
        );
    }

    #[test]
    fn rejects_in_place_cli_writes_and_malformed_archives() {
        assert!(parse_args(vec!["same.a".into(), "same.a".into()]).is_err());
        assert!(weaken_archive(b"not an archive").is_err());
    }
}
