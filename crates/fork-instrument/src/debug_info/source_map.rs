//! Standard source-map v3: one generated line, with absolute Wasm byte
//! offsets as columns. End markers keep synthetic instructions unmapped.
use super::{LineTable, Location};
use crate::artifact_io::{ArtifactSpool, MappedArtifact};
use anyhow::{Context, Result, ensure};
use std::io::Write;
use std::sync::Arc;

pub(crate) struct Recorder {
    maximum_rows: usize,
    rows: usize,
    body: Vec<[u64; 3]>,
    spool: ArtifactSpool,
    lines: Arc<LineTable>,
}
impl Recorder {
    pub fn new(maximum_rows: usize, lines: Arc<LineTable>) -> Result<Self> {
        Ok(Self {
            maximum_rows,
            rows: 0,
            body: Vec::new(),
            lines,
            spool: ArtifactSpool::new(
                u64::try_from(maximum_rows)?
                    .checked_mul(24)
                    .context("debug record budget overflow")?,
            )?,
        })
    }
    pub fn reset(&mut self) -> Result<()> {
        *self = Self::new(self.maximum_rows, self.lines.clone())?;
        Ok(())
    }
    pub fn record(&mut self, source: usize, start: usize, end: usize) -> Result<()> {
        ensure!(start <= end, "reversed source instruction span");
        if start == end {
            return Ok(());
        }
        let Some(location) = self.lines.lookup(source as u64) else {
            return Ok(());
        };
        if let Some(previous) = self.body.last_mut() {
            ensure!(
                previous[1] <= start as u64,
                "overlapping emitted source spans"
            );
            if previous[1] == start as u64 && self.lines.lookup(previous[2]) == Some(location) {
                previous[1] = end as u64;
                return Ok(());
            }
        }
        ensure!(
            self.rows < self.maximum_rows,
            "emitted debug locations exceed row budget"
        );
        ensure!(
            self.body.last().is_none_or(|row| row[1] <= start as u64),
            "overlapping emitted source spans"
        );
        self.rows += 1;
        self.body.push([start as u64, end as u64, source as u64]);
        Ok(())
    }
    /// Called after the body's actual LEB length prefix is written to the
    /// Code spool. Local offsets include the encoded local declarations.
    pub fn place_function(&mut self, code_relative_body_start: u64) -> Result<()> {
        for [start, end, source] in self.body.drain(..) {
            for value in [
                code_relative_body_start
                    .checked_add(start)
                    .context("debug offset overflow")?,
                code_relative_body_start
                    .checked_add(end)
                    .context("debug offset overflow")?,
                source,
            ] {
                self.spool.write_all(&value.to_le_bytes())?;
            }
        }
        Ok(())
    }
    pub fn finish(self, module: &[u8], limit: u64) -> Result<MappedArtifact> {
        ensure!(self.body.is_empty(), "unplaced debug function");
        let records = self.spool.freeze()?;
        let base = super::code_offset(module)?;
        let mut writer = Writer::new(&self.lines.files, limit)?;
        for record in records.bytes().chunks_exact(24) {
            let value = |offset| u64::from_le_bytes(record[offset..offset + 8].try_into().unwrap());
            if let Some(location) = self.lines.lookup(value(16)) {
                writer.range(base + value(0), base + value(8), location)?;
            }
        }
        writer.finish()
    }
}

pub(super) struct Writer {
    spool: ArtifactSpool,
    last_column: u64,
    last_location: [i64; 3],
    pending_end: Option<u64>,
    first: bool,
}
impl Writer {
    pub fn new(files: &[String], limit: u64) -> Result<Self> {
        let mut spool = ArtifactSpool::new(limit)?;
        spool.write_all(b"{\"version\":3,\"sources\":")?;
        serde_json::to_writer(&mut spool, files)?;
        spool.write_all(b",\"names\":[],\"mappings\":\"")?;
        Ok(Self {
            spool,
            last_column: 0,
            last_location: [0; 3],
            pending_end: None,
            first: true,
        })
    }
    fn segment(&mut self, column: u64, location: Option<Location>) -> Result<()> {
        ensure!(column >= self.last_column, "unordered source-map locations");
        if !self.first {
            self.spool.write_all(b",")?;
        }
        self.first = false;
        vlq(&mut self.spool, i64::try_from(column - self.last_column)?)?;
        self.last_column = column;
        if let Some(location) = location {
            let values = [
                i64::from(location.file),
                i64::from(location.line),
                i64::from(location.column),
            ];
            for (value, previous) in values.into_iter().zip(&mut self.last_location) {
                vlq(&mut self.spool, value - *previous)?;
                *previous = value;
            }
        }
        Ok(())
    }
    pub fn range(&mut self, start: u64, end: u64, location: Location) -> Result<()> {
        ensure!(start < end, "empty source-map span");
        if let Some(previous) = self.pending_end {
            ensure!(start >= previous, "overlapping source-map spans");
            if previous < start {
                self.segment(previous, None)?;
            }
        }
        self.segment(start, Some(location))?;
        self.pending_end = Some(end);
        Ok(())
    }
    pub fn finish(mut self) -> Result<MappedArtifact> {
        if let Some(end) = self.pending_end {
            self.segment(end, None)?;
        }
        self.spool.write_all(b"\"}")?;
        self.spool.freeze()
    }
}
const BASE64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn vlq(output: &mut impl Write, value: i64) -> Result<()> {
    let mut unsigned = value
        .unsigned_abs()
        .checked_mul(2)
        .context("source-map delta overflow")?
        | u64::from(value < 0);
    loop {
        let mut digit = (unsigned & 31) as usize;
        unsigned >>= 5;
        if unsigned != 0 {
            digit |= 32;
        }
        output.write_all(&[BASE64[digit]])?;
        if unsigned == 0 {
            return Ok(());
        }
    }
}

/// A validated bounded map for exact-module callers. Source names are display
/// metadata; this type never opens or fetches them. No filename in a map binds
/// it to a module: keep it alongside the actual loaded bytes/content digest.
#[derive(Debug)]
pub struct SourceMap {
    pub files: Vec<String>,
    segments: Vec<(u64, Option<Location>)>,
    code: Option<std::ops::Range<u64>>,
}
impl SourceMap {
    pub fn read(input: &[u8], limits: super::Limits) -> Result<Self> {
        ensure!(
            input.len() <= limits.section_bytes,
            "source map exceeds metadata budget"
        );
        let json: serde_json::Value = serde_json::from_slice(input)?;
        ensure!(
            json["version"] == 3 && json.get("sections").is_none(),
            "expected a flat v3 Wasm source map"
        );
        ensure!(
            json.get("sourceRoot").is_none_or(|root| root == ""),
            "source-map sourceRoot is unsupported; use complete diagnostic source paths"
        );
        let sources = json["sources"]
            .as_array()
            .context("source map has no sources")?;
        ensure!(
            sources.len() <= limits.files,
            "source map exceeds file budget"
        );
        let mut files = Vec::with_capacity(sources.len());
        let mut bytes = 0usize;
        for source in sources {
            let source = source.as_str().context("invalid source filename")?;
            ensure!(
                source.len() <= limits.path_bytes,
                "source map exceeds path budget"
            );
            bytes = bytes
                .checked_add(source.len())
                .context("source path size overflow")?;
            ensure!(
                bytes <= limits.total_path_bytes,
                "source map exceeds path budget"
            );
            files.push(source.to_owned());
        }
        let mappings = json["mappings"]
            .as_str()
            .context("source map has no mappings")?;
        ensure!(
            !mappings.contains(';'),
            "Wasm source map must have one generated line"
        );
        let mut segments = Vec::new();
        let mut values = [0i64; 5];
        for segment in mappings.split(',').filter(|segment| !segment.is_empty()) {
            ensure!(
                segments.len() < limits.rows,
                "source map exceeds row budget"
            );
            let mut reader = segment.as_bytes();
            let mut count = 0;
            while !reader.is_empty() {
                ensure!(count < values.len(), "invalid source-map segment");
                let delta = read_vlq(&mut reader)?;
                if count == 0 {
                    ensure!(delta >= 0, "unordered source-map columns");
                }
                values[count] = values[count]
                    .checked_add(delta)
                    .context("source-map delta overflow")?;
                count += 1;
            }
            ensure!(
                count == 1 || count == 4 || count == 5,
                "invalid source-map fields"
            );
            let offset = u64::try_from(values[0]).context("negative source-map offset")?;
            let location = if count == 1 {
                None
            } else {
                let file = u32::try_from(values[1]).context("invalid source-map file")?;
                ensure!(
                    (file as usize) < files.len(),
                    "source-map file out of bounds"
                );
                Some(Location {
                    file,
                    line: u32::try_from(values[2]).context("invalid source-map line")?,
                    column: u32::try_from(values[3]).context("invalid source-map column")?,
                })
            };
            segments.push((offset, location));
        }
        Ok(Self {
            files,
            segments,
            code: None,
        })
    }
    pub fn lookup(&self, offset: u64) -> Option<Location> {
        if self
            .code
            .as_ref()
            .is_some_and(|code| !code.contains(&offset))
        {
            return None;
        }
        let index = self.segments.partition_point(|(start, _)| *start <= offset);
        self.segments
            .get(index.checked_sub(1)?)
            .and_then(|(_, location)| *location)
    }
    /// Canonicalize the fields we actually use. Optimizer temporary paths in
    /// `file`, source contents and optional names do not become module identity.
    pub fn encode(&self, limit: u64) -> Result<MappedArtifact> {
        let mut writer = Writer::new(&self.files, limit)?;
        for &(offset, location) in &self.segments {
            writer.segment(offset, location)?;
        }
        writer.finish()
    }
    pub(super) fn check_offsets(&mut self, code: std::ops::Range<usize>) -> Result<()> {
        for &(offset, location) in &self.segments {
            ensure!(
                offset >= code.start as u64 && offset <= code.end as u64,
                "source-map location outside Code section"
            );
            ensure!(
                offset < code.end as u64 || location.is_none(),
                "mapped location after executable code"
            );
        }
        self.code = Some(code.start as u64..code.end as u64);
        Ok(())
    }
}
fn read_vlq(reader: &mut &[u8]) -> Result<i64> {
    let mut value = 0u64;
    for shift in (0..65).step_by(5) {
        let (&byte, rest) = reader.split_first().context("truncated source-map delta")?;
        *reader = rest;
        let digit = BASE64
            .iter()
            .position(|&candidate| candidate == byte)
            .context("invalid source-map base64")? as u64;
        ensure!(digit & 31 <= u64::MAX >> shift, "source-map delta overflow");
        value |= (digit & 31) << shift;
        if digit & 32 == 0 {
            let magnitude = i64::try_from(value >> 1).context("source-map delta overflow")?;
            return Ok(if value & 1 == 0 {
                magnitude
            } else {
                -magnitude
            });
        }
    }
    anyhow::bail!("source-map delta overflow")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorder_budget_counts_useful_ranges_and_preserves_unmapped_gaps() {
        let lines = Arc::new(LineTable {
            files: vec!["user.rs".into()],
            spans: vec![super::super::Span {
                start: 10,
                end: 30,
                location: Some(Location {
                    file: 0,
                    line: 1,
                    column: 2,
                }),
            }],
        });
        let mut recorder = Recorder::new(1, lines).unwrap();
        for position in 0..100_000 {
            recorder.record(0, position, position + 1).unwrap();
        }
        assert_eq!(recorder.rows, 0);
        for position in 0..100 {
            recorder.record(10, position, position + 1).unwrap();
        }
        assert_eq!(recorder.body, vec![[0, 100, 10]]);
        recorder.record(0, 100, 101).unwrap();
        assert!(
            recorder
                .record(10, 101, 102)
                .unwrap_err()
                .to_string()
                .contains("row budget")
        );
        // Resetting for a retried emission keeps the same bounded line table.
        recorder.reset().unwrap();
        recorder.record(10, 0, 1).unwrap();
        assert_eq!(recorder.rows, 1);
    }
    #[test]
    fn range_ends_leave_gaps_and_helpers_unmapped() {
        let location = Location {
            file: 0,
            line: 15,
            column: 7,
        };
        let mut writer = Writer::new(&["source.rs".into()], 4096).unwrap();
        writer.range(100, 102, location).unwrap();
        writer
            .range(
                105,
                107,
                Location {
                    line: 3,
                    ..location
                },
            )
            .unwrap();
        let bytes = writer.finish().unwrap();
        let map = SourceMap::read(bytes.bytes(), Default::default()).unwrap();
        assert_eq!(map.lookup(99), None);
        assert_eq!(map.lookup(100), Some(location));
        assert_eq!(map.lookup(102), None);
        assert_eq!(map.lookup(104), None);
        assert_eq!(map.lookup(105).unwrap().line, 3);
        assert_eq!(map.lookup(107), None);
        assert_eq!(map.lookup(1000), None);
    }

    #[test]
    fn malformed_and_oversized_maps_fail_explicitly() {
        for mappings in [
            "g",
            "!",
            "AA",
            "AAAAAA",
            "DAAA",
            "ACAA",
            "AADA",
            "AAAD",
            "/////////////f",
        ] {
            let json = serde_json::json!({"version":3,"sources":["test.rs"],"mappings":mappings});
            assert!(
                SourceMap::read(json.to_string().as_bytes(), Default::default()).is_err(),
                "{mappings}"
            );
        }
        let input = br#"{"version":3,"sources":["test.rs"],"mappings":"AAAA,C"}"#;
        let mut limits = super::super::Limits::default();
        limits.rows = 1;
        assert!(
            SourceMap::read(input, limits)
                .unwrap_err()
                .to_string()
                .contains("row budget")
        );
        limits.rows = 100;
        limits.files = 0;
        assert!(
            SourceMap::read(input, limits)
                .unwrap_err()
                .to_string()
                .contains("file budget")
        );
    }

    #[test]
    fn a_map_without_a_final_marker_cannot_resolve_past_its_module() {
        let mut map = SourceMap::read(
            br#"{"version":3,"sources":["test.rs"],"mappings":"UAAA"}"#,
            Default::default(),
        )
        .unwrap();
        map.check_offsets(10..20).unwrap();
        assert!(map.lookup(19).is_some());
        assert_eq!(map.lookup(20), None);
        assert_eq!(map.lookup(u64::MAX), None);
    }
}
