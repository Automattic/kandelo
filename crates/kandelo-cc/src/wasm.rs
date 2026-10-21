//! The little of the WebAssembly binary format the driver reads: imports,
//! custom sections and the code section.

use crate::Result;
use sha2::{Digest, Sha256};

/// The custom section the KandeloCallTypes plugin writes into each object.
pub const CALLTYPES_SECTION: &str = "kandelo.calltypes";

/// Name of the section binding a module's facts to its linked code.
pub const CALLTYPES_CODE_HASH_SECTION: &str = "kandelo.calltypes.code-sha256";

fn read_leb(bytes: &[u8], mut offset: usize) -> Result<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let Some(&byte) = bytes.get(offset) else {
            return Err("truncated LEB128 in Wasm module".into());
        };
        offset += 1;
        if shift < 64 {
            result |= u64::from(byte & 0x7f) << shift;
        }
        shift += 7;
        if byte & 0x80 == 0 {
            return Ok((result, offset));
        }
    }
}

struct Section {
    id: u8,
    /// First byte of the section header.
    start: usize,
    body_start: usize,
    end: usize,
    name: Option<String>,
}

pub fn is_wasm_module(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[0] == 0 && bytes[1] == 0x61
}

fn sections(bytes: &[u8]) -> Result<Vec<Section>> {
    if bytes.len() < 8 || bytes[..4] != [0, 0x61, 0x73, 0x6d] {
        return Err("not a Wasm module".into());
    }
    let mut out = Vec::new();
    let mut offset = 8;
    while offset < bytes.len() {
        let start = offset;
        let id = bytes[offset];
        let (size, body_start) = read_leb(bytes, offset + 1)?;
        let end = body_start
            .checked_add(size as usize)
            .filter(|&end| end <= bytes.len())
            .ok_or("truncated Wasm section")?;
        let name = if id == 0 {
            let (name_len, name_start) = read_leb(bytes, body_start)?;
            let name_start = name_start.min(bytes.len());
            let name_end = name_start
                .saturating_add(name_len as usize)
                .min(bytes.len());
            Some(String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned())
        } else {
            None
        };
        out.push(Section {
            id,
            start,
            body_start,
            end,
            name,
        });
        offset = end;
    }
    Ok(out)
}

fn read_name(bytes: &[u8], offset: usize) -> Result<(String, usize)> {
    let (len, start) = read_leb(bytes, offset)?;
    let end = start.saturating_add(len as usize);
    let text = &bytes[start.min(bytes.len())..end.min(bytes.len())];
    Ok((String::from_utf8_lossy(text).into_owned(), end))
}

fn byte_at(bytes: &[u8], offset: usize) -> Result<u8> {
    bytes
        .get(offset)
        .copied()
        .ok_or_else(|| "truncated import in Wasm module".into())
}

fn skip_limits(bytes: &[u8], offset: usize) -> Result<usize> {
    let flags = byte_at(bytes, offset)?;
    let (_, mut offset) = read_leb(bytes, offset + 1)?;
    if flags & 1 != 0 {
        (_, offset) = read_leb(bytes, offset)?;
    }
    Ok(offset)
}

/// Does the module import function `module.field`?
pub fn imports_function(bytes: &[u8], module: &str, field: &str) -> Result<bool> {
    let all = sections(bytes)?;
    let Some(imports) = all.iter().find(|s| s.id == 2) else {
        return Ok(false);
    };
    let (mut count, mut offset) = read_leb(bytes, imports.body_start)?;
    while count > 0 {
        let (module_name, next) = read_name(bytes, offset)?;
        let (name, next) = read_name(bytes, next)?;
        offset = next;
        let kind = byte_at(bytes, offset)?;
        offset += 1;
        if kind == 0x00 && module_name == module && name == field {
            return Ok(true);
        }
        match kind {
            // function: type index
            0x00 => (_, offset) = read_leb(bytes, offset)?,
            // table: reference type, limits
            0x01 => {
                let ref_type = byte_at(bytes, offset)?;
                offset += 1;
                if ref_type == 0x63 || ref_type == 0x64 {
                    (_, offset) = read_leb(bytes, offset)?;
                }
                offset = skip_limits(bytes, offset)?;
            }
            // memory: limits
            0x02 => offset = skip_limits(bytes, offset)?,
            // global: value type, mutability
            0x03 => offset += 2,
            // tag: attribute, type index
            0x04 => (_, offset) = read_leb(bytes, offset + 1)?,
            _ => return Err(format!("unknown import kind 0x{kind:x} in Wasm module")),
        }
        count -= 1;
    }
    Ok(false)
}

/// The module without its custom sections named `name`, or `None` when it
/// has none.
pub fn without_custom_section(bytes: &[u8], name: &str) -> Result<Option<Vec<u8>>> {
    let drop: Vec<Section> = sections(bytes)?
        .into_iter()
        .filter(|s| s.id == 0 && s.name.as_deref() == Some(name))
        .collect();
    if drop.is_empty() {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    for s in &drop {
        out.extend_from_slice(&bytes[offset..s.start]);
        offset = s.end;
    }
    out.extend_from_slice(&bytes[offset..]);
    Ok(Some(out))
}

fn leb(mut value: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return out;
        }
    }
}

/// The module with a `kandelo.calltypes.code-sha256` section: the SHA-256 of
/// its code-section payload as wasm-ld wrote it. A module without code is
/// returned unchanged (`None`).
///
/// WHY: some package scripts run wasm-opt themselves before instrumenting.
/// wasm-opt keeps unknown custom sections, so the facts would survive while
/// inlining moved call sites between functions, and the instrumenter would
/// analyze code the facts no longer describe. The instrumenter uses the facts
/// only when this hash still matches the code it is given.
pub fn with_code_hash_section(bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    let all = sections(bytes)?;
    let Some(code) = all.iter().find(|s| s.id == 10) else {
        return Ok(None);
    };
    let digest = Sha256::digest(&bytes[code.body_start..code.end]);
    let name = CALLTYPES_CODE_HASH_SECTION.as_bytes();
    let mut body = leb(name.len());
    body.extend_from_slice(name);
    body.extend_from_slice(&digest);
    let mut out = without_custom_section(bytes, CALLTYPES_CODE_HASH_SECTION)?
        .unwrap_or_else(|| bytes.to_vec());
    out.push(0);
    out.extend(leb(body.len()));
    out.extend(body);
    Ok(Some(out))
}
