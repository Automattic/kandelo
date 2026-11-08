//! Bounded source-line input for post-link debugging. Paths are diagnostic
//! metadata only: reading a line table never reads a host or guest source file.
use anyhow::{Context, Result, ensure};
use gimli::{ColumnType, Dwarf, EndianSlice, LittleEndian, Reader};
use std::{collections::BTreeMap, ops::Range};
use wasmparser::{Encoding, Parser, Payload};

mod source_map;
pub(crate) use source_map::Recorder;
pub use source_map::SourceMap;

/// Optional, additive diagnostic metadata. Appended after Code, so embedding
/// it cannot move the instruction offsets described by the map.
pub const SECTION: &str = "kandelo.debug.lines";
const MAP_MAGIC: &[u8; 8] = b"KDBG\x01\0\0\0";

pub fn embedded_map(input: &[u8], limits: Limits) -> Result<Option<SourceMap>> {
    ensure!(
        input.starts_with(b"\0asm\x01\0\0\0"),
        "debug locations require a core Wasm module"
    );
    let mut map = None;
    let mut code = None;
    for payload in Parser::new(0).parse_all(input) {
        if let Payload::CustomSection(section) = payload? {
            if section.name() == SECTION {
                ensure!(map.is_none(), "duplicate embedded source map");
                use sha2::{Digest, Sha256};
                let data = section.data();
                ensure!(
                    data.len() >= 48 && &data[..8] == MAP_MAGIC,
                    "unsupported embedded source-map format"
                );
                let range = code_range(input)?;
                ensure!(
                    u64::from_le_bytes(data[8..16].try_into().unwrap()) == range.start as u64,
                    "stale embedded source map: Code section moved"
                );
                ensure!(
                    data[16..48] == Sha256::digest(&input[range.clone()])[..],
                    "stale embedded source map: executable code changed"
                );
                map = Some(SourceMap::read(&data[48..], limits)?);
                code = Some(range);
            }
        }
    }
    if let Some(map) = &mut map {
        map.check_offsets(code.unwrap())?;
    }
    Ok(map)
}

pub fn attach_map(
    input: &crate::artifact_io::MappedArtifact,
    map: &[u8],
    limits: Limits,
    output_limit: u64,
) -> Result<crate::artifact_io::MappedArtifact> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use wasm_encoder::Encode;
    ensure!(
        embedded_map(input.bytes(), limits)?.is_none(),
        "module already has an embedded source map"
    );
    let mut parsed = SourceMap::read(map, limits)?;
    parsed.check_offsets(code_range(input.bytes())?)?;
    let map = parsed.encode(limits.section_bytes as u64)?;
    let mut spool = crate::artifact_io::ArtifactSpool::new(output_limit)?;
    spool.write_all(input.bytes())?;
    let mut header = Vec::new();
    header.push(0);
    let mut name = Vec::new();
    SECTION.encode(&mut name);
    let length = name
        .len()
        .checked_add(48)
        .and_then(|length| length.checked_add(map.bytes().len()))
        .context("debug section length overflow")?;
    u32::try_from(length)?.encode(&mut header);
    spool.write_all(&header)?;
    spool.write_all(&name)?;
    let code = code_range(input.bytes())?;
    spool.write_all(MAP_MAGIC)?;
    spool.write_all(&(code.start as u64).to_le_bytes())?;
    spool.write_all(&Sha256::digest(&input.bytes()[code]))?;
    spool.write_all(map.bytes())?;
    spool.freeze()
}

type DwarfReader<'a> = EndianSlice<'a, LittleEndian>;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub section_bytes: usize,
    pub rows: usize,
    pub files: usize,
    pub path_bytes: usize,
    pub total_path_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            section_bytes: 64 * 1024 * 1024,
            rows: 1_000_000,
            files: 4096,
            path_bytes: 16 * 1024,
            total_path_bytes: 4 * 1024 * 1024,
        }
    }
}

/// File indices refer to `LineTable::files`; line and column are zero-based.
/// A zero column also represents DWARF's left-edge location.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Location {
    pub file: u32,
    pub line: u32,
    pub column: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    start: u64,
    end: u64,
    location: Option<Location>,
}

#[derive(Debug)]
pub struct LineTable {
    pub files: Vec<String>,
    spans: Vec<Span>,
}
impl LineTable {
    /// LLVM Wasm line addresses are relative to the Code section payload,
    /// whereas wasmparser instruction positions are absolute module offsets.
    pub fn read(input: &[u8], limits: Limits) -> Result<Self> {
        Self::read_if_present(input, limits)?.context(
            "no DWARF line information with usable source locations; compile with debug information enabled",
        )
    }

    /// Absent or empty line tables are normal for builds without debug
    /// information. Malformed or oversized metadata still fails closed.
    pub fn read_if_present(input: &[u8], limits: Limits) -> Result<Option<Self>> {
        let mut sections = BTreeMap::new();
        let mut code = None;
        let mut bytes = 0usize;
        for payload in Parser::new(0).parse_all(input) {
            match payload.context("reading Wasm debug sections")? {
                Payload::Version { encoding, .. } => ensure!(
                    encoding == Encoding::Module,
                    "debug lines require a core Wasm module"
                ),
                Payload::CodeSectionStart { range, .. } => code = Some(range),
                Payload::CustomSection(section) if section.name().starts_with(".debug_") => {
                    ensure!(sections.len() < 32, "too many DWARF sections");
                    bytes = bytes
                        .checked_add(section.data().len())
                        .and_then(|bytes| bytes.checked_add(section.name().len()))
                        .context("debug section size overflow")?;
                    ensure!(
                        bytes <= limits.section_bytes,
                        "DWARF sections exceed debug metadata budget"
                    );
                    ensure!(
                        sections.insert(section.name(), section.data()).is_none(),
                        "duplicate DWARF section {}",
                        section.name()
                    );
                }
                _ => {}
            }
        }
        if !sections.contains_key(".debug_line") {
            return Ok(None);
        }
        let code = code.context("debug lines require a Code section")?;
        let dwarf = Dwarf::load(|id| {
            Ok::<_, gimli::Error>(DwarfReader::new(
                sections.get(id.name()).copied().unwrap_or_default(),
                LittleEndian,
            ))
        })?;
        let mut units = dwarf.units();
        let mut files = Files::new(limits);
        let mut spans = Vec::new();
        let mut total_rows = 0usize;
        while let Some(header) = units.next().context("reading DWARF unit header")? {
            let unit = dwarf.unit(header).context("reading DWARF unit")?;
            let Some(program) = unit.line_program.clone() else {
                continue;
            };
            let mut rows = program.rows();
            let mut previous: Option<(u64, Option<Location>)> = None;
            let mut unit_files = BTreeMap::new();
            while let Some((header, row)) = rows.next_row().context("reading DWARF line row")? {
                total_rows = total_rows
                    .checked_add(1)
                    .context("debug row count overflow")?;
                ensure!(
                    total_rows <= limits.rows,
                    "DWARF lines exceed debug row budget"
                );
                if let Some((start, location)) = previous {
                    // Dead linked functions can have tombstone addresses. They
                    // are not locations in this module's executable code.
                    if let Some(range) = code_span(&code, start, row.address()) {
                        spans.push(Span {
                            start: range.start,
                            end: range.end,
                            location,
                        });
                    }
                }
                if row.end_sequence() {
                    previous = None;
                    continue;
                }
                let location = if let (Some(file), Some(line)) = (row.file(header), row.line()) {
                    let file_id = if let Some(id) = unit_files.get(&row.file_index()) {
                        *id
                    } else {
                        let path = source_path(&dwarf, &unit, header, file, limits.path_bytes)?;
                        let id = files.intern(path)?;
                        unit_files.insert(row.file_index(), id);
                        id
                    };
                    Some(Location {
                        file: file_id,
                        line: u32::try_from(line.get() - 1)
                            .context("DWARF line number too large")?,
                        column: match row.column() {
                            ColumnType::LeftEdge => 0,
                            ColumnType::Column(column) => {
                                u32::try_from(column.get() - 1).context("DWARF column too large")?
                            }
                        },
                    })
                } else {
                    None
                };
                previous = Some((row.address(), location));
            }
        }
        normalize(&mut spans);
        if !spans.iter().any(|span| span.location.is_some()) {
            return Ok(None);
        }
        Ok(Some(Self {
            files: files.paths,
            spans,
        }))
    }

    pub fn lookup(&self, original_module_offset: u64) -> Option<Location> {
        let index = self
            .spans
            .partition_point(|span| span.start <= original_module_offset);
        let span = self.spans.get(index.checked_sub(1)?)?;
        (original_module_offset < span.end)
            .then_some(span.location)
            .flatten()
    }

    pub(crate) fn copied_map(
        &self,
        original: &[u8],
        output: &[u8],
        limit: u64,
    ) -> Result<crate::artifact_io::MappedArtifact> {
        let source_base = code_offset(original)?;
        let output_base = code_offset(output)?;
        let mut map = source_map::Writer::new(&self.files, limit)?;
        for span in &self.spans {
            if let Some(location) = span.location {
                map.range(
                    output_base + span.start - source_base,
                    output_base + span.end - source_base,
                    location,
                )?;
            }
        }
        map.finish()
    }
}

pub(crate) fn code_offset(input: &[u8]) -> Result<u64> {
    Ok(code_range(input)?.start as u64)
}

fn code_range(input: &[u8]) -> Result<Range<usize>> {
    for payload in Parser::new(0).parse_all(input) {
        if let Payload::CodeSectionStart { range, .. } = payload? {
            return Ok(range);
        }
    }
    anyhow::bail!("debug locations require a Code section")
}

fn code_span(code: &Range<usize>, start: u64, end: u64) -> Option<Range<u64>> {
    let length = (code.end - code.start) as u64;
    if start >= length || end <= start {
        return None;
    }
    Some(code.start as u64 + start..code.start as u64 + end.min(length))
}

/// Conservatively leave conflicting overlapping compile-unit locations
/// unresolved. Never select an arbitrary source file for folded code.
fn normalize(spans: &mut Vec<Span>) {
    spans.sort_unstable_by_key(|span| (span.start, span.end));
    let mut count = 0usize;
    for index in 0..spans.len() {
        let current = spans[index];
        if count > 0 && current.start < spans[count - 1].end {
            let previous = &mut spans[count - 1];
            previous.end = previous.end.max(current.end);
            if previous.location != current.location {
                previous.location = None;
            }
        } else {
            spans[count] = current;
            count += 1;
        }
    }
    spans.truncate(count);
}

fn reader_string(reader: DwarfReader<'_>, limit: usize) -> Result<String> {
    ensure!(
        reader.len() <= limit,
        "DWARF path exceeds debug path budget"
    );
    let path = reader.to_string_lossy().into_owned();
    ensure!(
        path.len() <= limit,
        "decoded DWARF path exceeds debug path budget"
    );
    Ok(path)
}
fn source_path(
    dwarf: &Dwarf<DwarfReader<'_>>,
    unit: &gimli::Unit<DwarfReader<'_>>,
    header: &gimli::LineProgramHeader<DwarfReader<'_>>,
    file: &gimli::FileEntry<DwarfReader<'_>>,
    limit: usize,
) -> Result<String> {
    let name = reader_string(dwarf.attr_string(unit, file.path_name())?, limit)?;
    ensure!(!name.is_empty(), "empty DWARF source filename");
    if name.starts_with('/') {
        return Ok(name);
    }
    let directory = header
        .directory(file.directory_index())
        .map(|value| dwarf.attr_string(unit, value))
        .transpose()?
        .map(|reader| reader_string(reader, limit))
        .transpose()?
        .unwrap_or_default();
    let comp_dir = unit
        .comp_dir
        .clone()
        .map(|reader| reader_string(reader, limit))
        .transpose()?
        .unwrap_or_default();
    let mut path = String::new();
    for part in [
        if directory.starts_with('/') {
            ""
        } else {
            &comp_dir
        },
        &directory,
        &name,
    ] {
        if part.is_empty() {
            continue;
        }
        if !path.is_empty() && !path.ends_with('/') {
            path.push('/');
        }
        path.push_str(part);
    }
    ensure!(
        path.len() <= limit,
        "DWARF combined path exceeds debug path budget"
    );
    Ok(path)
}
struct Files {
    paths: Vec<String>,
    ids: BTreeMap<String, u32>,
    bytes: usize,
    limits: Limits,
}
impl Files {
    fn new(limits: Limits) -> Self {
        Self {
            paths: Vec::new(),
            ids: BTreeMap::new(),
            bytes: 0,
            limits,
        }
    }
    fn intern(&mut self, path: String) -> Result<u32> {
        if let Some(id) = self.ids.get(&path) {
            return Ok(*id);
        }
        ensure!(
            self.paths.len() < self.limits.files,
            "DWARF files exceed debug file budget"
        );
        self.bytes = self
            .bytes
            .checked_add(path.len())
            .context("debug path size overflow")?;
        ensure!(
            self.bytes <= self.limits.total_path_bytes,
            "DWARF filenames exceed debug path budget"
        );
        let id = u32::try_from(self.paths.len())?;
        self.paths.push(path.clone());
        self.ids.insert(path, id);
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn loc(file: u32) -> Option<Location> {
        Some(Location {
            file,
            line: 2,
            column: 4,
        })
    }
    #[test]
    fn conflicting_folded_locations_remain_unresolved() {
        let mut spans = vec![
            Span {
                start: 10,
                end: 30,
                location: loc(1),
            },
            Span {
                start: 15,
                end: 20,
                location: loc(2),
            },
        ];
        normalize(&mut spans);
        assert_eq!(
            spans,
            [Span {
                start: 10,
                end: 30,
                location: None
            }]
        );
    }
    #[test]
    fn lookup_does_not_cross_sequence_ends_or_gaps() {
        let table = LineTable {
            files: vec![],
            spans: vec![
                Span {
                    start: 10,
                    end: 15,
                    location: loc(1),
                },
                Span {
                    start: 20,
                    end: 30,
                    location: loc(2),
                },
            ],
        };
        assert_eq!(table.lookup(10), loc(1));
        assert_eq!(table.lookup(14), loc(1));
        assert_eq!(table.lookup(15), None);
        assert_eq!(table.lookup(19), None);
        assert_eq!(table.lookup(20), loc(2));
        assert_eq!(table.lookup(30), None);
    }
    #[test]
    fn tombstones_are_not_source_locations() {
        assert_eq!(code_span(&(100..200), u64::MAX, u64::MAX), None);
        assert_eq!(code_span(&(100..200), 8, 12), Some(108..112));
    }
    #[test]
    fn missing_line_information_is_an_explicit_error() {
        let input = wat::parse_str("(module (func))").unwrap();
        assert!(
            LineTable::read(&input, Limits::default())
                .unwrap_err()
                .to_string()
                .contains("no DWARF line information")
        );
    }

    #[test]
    fn embedded_maps_reject_changed_code_and_changed_code_positions() {
        use crate::artifact_io::MappedArtifact;
        use wasm_encoder::Encode;
        let input = wat::parse_str("(module (func nop))").unwrap();
        let offset = Parser::new(0)
            .parse_all(&input)
            .find_map(|payload| {
                if let Payload::CodeSectionEntry(body) = payload.unwrap() {
                    Some(body.get_operators_reader().unwrap().original_position())
                } else {
                    None
                }
            })
            .unwrap();
        let location = Location {
            file: 0,
            line: 2,
            column: 0,
        };
        let mut writer = source_map::Writer::new(&["source.rs".into()], 4096).unwrap();
        writer
            .range(offset as u64, offset as u64 + 1, location)
            .unwrap();
        let map = writer.finish().unwrap();
        let input = MappedArtifact::snapshot(std::io::Cursor::new(input), 4096).unwrap();
        let prepared = attach_map(&input, map.bytes(), Default::default(), 4096).unwrap();
        assert_eq!(
            embedded_map(prepared.bytes(), Default::default())
                .unwrap()
                .unwrap()
                .lookup(offset as u64),
            Some(location)
        );

        let mut changed = prepared.bytes().to_vec();
        assert_eq!(changed[offset], 1); // nop -> unreachable, still valid Wasm
        changed[offset] = 0;
        wasmparser::Validator::new().validate_all(&changed).unwrap();
        assert!(
            embedded_map(&changed, Default::default())
                .unwrap_err()
                .to_string()
                .contains("executable code changed")
        );

        let mut shifted = prepared.bytes()[..8].to_vec();
        shifted.push(0);
        wasm_encoder::CustomSection {
            name: "prefix".into(),
            data: vec![1].into(),
        }
        .encode(&mut shifted);
        shifted.extend_from_slice(&prepared.bytes()[8..]);
        wasmparser::Validator::new().validate_all(&shifted).unwrap();
        assert!(
            embedded_map(&shifted, Default::default())
                .unwrap_err()
                .to_string()
                .contains("Code section moved")
        );
    }
}
