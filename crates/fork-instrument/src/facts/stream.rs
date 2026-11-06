//! Streaming version-5 facts framing. Unlike the oracle chunk visitor, this
//! decoder never allocates a complete decompressed object. The logical input
//! concatenates facts sections exactly as the linker/oracle does.

use anyhow::{Context, Result, ensure};
use flate2::{Decompress, FlushDecompress, Status};
use std::io::{self, BufRead, BufReader, Read};

const MAGIC: &[u8; 8] = b"KCTZ\0\0\0\x01";
const HEADER: &str = "#kandelo-calltypes\t";

#[derive(Clone, Copy, Debug)]
pub struct ReadLimits {
    pub line_bytes: usize,
    pub chunk_bytes: u64,
    pub total_bytes: u64,
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            line_bytes: 1024 * 1024,
            chunk_bytes: 512 * 1024 * 1024,
            total_bytes: super::codec::MAX_TOTAL_BYTES,
        }
    }
}

/// Text excludes its newline (and an immediately preceding CR), matching
/// `str::lines`. The borrowed text is valid only for the visitor call.
#[derive(Debug)]
pub enum Event<'a> {
    Begin {
        chunk: usize,
    },
    Line {
        chunk: usize,
        number: usize,
        text: &'a str,
    },
    End {
        chunk: usize,
    },
}

#[derive(Debug, Default)]
pub struct ReadReport {
    pub chunks: usize,
    pub decoded_bytes: u64,
    pub largest_line: usize,
}

struct Sections<'a, I> {
    sections: I,
    current: &'a [u8],
}

// Preserve four bytes of lookahead even when a frame magic straddles a read
// buffer boundary. std::io::BufReader::fill_buf may return only that buffer's
// short suffix, which is insufficient to distinguish text from a frame.
struct Input<R> {
    source: R,
    buffer: Vec<u8>,
    start: usize,
    end: usize,
    eof: bool,
}

impl<R: Read> Input<R> {
    fn new(source: R) -> Self {
        Self {
            source,
            buffer: vec![0; 64 * 1024],
            start: 0,
            end: 0,
            eof: false,
        }
    }
}

impl<R: Read> BufRead for Input<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.end - self.start < 4 && !self.eof {
            self.buffer.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
            while self.end < 4 && !self.eof {
                let count = self.source.read(&mut self.buffer[self.end..])?;
                self.end += count;
                self.eof = count == 0;
            }
        }
        Ok(&self.buffer[self.start..self.end])
    }
    fn consume(&mut self, count: usize) {
        self.start += count;
    }
}

impl<R: Read> Read for Input<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let source = self.fill_buf()?;
        let count = output.len().min(source.len());
        output[..count].copy_from_slice(&source[..count]);
        self.consume(count);
        Ok(count)
    }
}

impl<'a, I: Iterator<Item = &'a [u8]>> Read for Sections<'a, I> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let mut written = 0;
        while written < output.len() {
            if self.current.is_empty() {
                match self.sections.next() {
                    Some(next) => self.current = next,
                    None => break,
                }
            }
            let count = self.current.len().min(output.len() - written);
            output[written..written + count].copy_from_slice(&self.current[..count]);
            self.current = &self.current[count..];
            written += count;
        }
        Ok(written)
    }
}

/// Inflate into the caller's bounded buffer, requiring a complete zlib stream
/// that consumes exactly the frame payload and produces its declared length.
struct Frame<'a, R> {
    input: &'a mut R,
    decoder: Decompress,
    encoded: u64,
    decoded: u64,
    ended: bool,
}

impl<R: BufRead> Read for Frame<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.ended || output.is_empty() {
            return Ok(0);
        }
        loop {
            let before_in = self.decoder.total_in();
            let before_out = self.decoder.total_out();
            let remaining = self.encoded - before_in;
            let available = self.input.fill_buf()?;
            let count = remaining.min(available.len() as u64) as usize;
            let status = self
                .decoder
                .decompress(&available[..count], output, FlushDecompress::None)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            let consumed = self.decoder.total_in() - before_in;
            let produced = self.decoder.total_out() - before_out;
            self.input.consume(consumed as usize);
            if self.decoder.total_out() > self.decoded {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "compressed facts decoded length exceeds frame",
                ));
            }
            if status == Status::StreamEnd {
                if self.decoder.total_in() != self.encoded
                    || self.decoder.total_out() != self.decoded
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "compressed facts frame length mismatch or trailing bytes",
                    ));
                }
                self.ended = true;
                return Ok(produced as usize);
            }
            if produced != 0 {
                return Ok(produced as usize);
            }
            if consumed == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "incomplete compressed facts stream",
                ));
            }
        }
    }
}

fn line(reader: &mut impl BufRead, output: &mut Vec<u8>, limit: usize) -> Result<bool> {
    output.clear();
    loop {
        let available = reader.fill_buf().context("reading compiler facts")?;
        if available.is_empty() {
            return Ok(!output.is_empty());
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let count = newline.map_or(available.len(), |n| n + 1);
        ensure!(
            count <= limit.saturating_sub(output.len()),
            "facts line exceeds decoded line budget"
        );
        output.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

struct Visitor<V> {
    callback: V,
    report: ReadReport,
    limits: ReadLimits,
    current: Option<(usize, u64)>,
}

impl<V: for<'a> FnMut(Event<'a>) -> Result<()>> Visitor<V> {
    fn finish(&mut self) -> Result<()> {
        if let Some((_, _)) = self.current.take() {
            (self.callback)(Event::End {
                chunk: self.report.chunks - 1,
            })?;
        }
        Ok(())
    }

    fn accept(&mut self, bytes: &[u8], framed: bool) -> Result<()> {
        let mut text = std::str::from_utf8(bytes).context("facts line is not UTF-8")?;
        if let Some(without) = text.strip_suffix('\n') {
            text = without.strip_suffix('\r').unwrap_or(without);
        }
        let header = text.starts_with(HEADER);
        ensure!(
            text.match_indices(HEADER)
                .all(|(position, _)| position == 0),
            "facts chunk header does not start a line"
        );
        if header {
            ensure!(
                !framed || self.current.is_none(),
                "compressed frame must contain one facts chunk"
            );
            self.finish()?;
            ensure!(
                text.split('\t').nth(1) == Some(super::side::FORMAT_VERSION),
                "unsupported facts format"
            );
            let chunk = self.report.chunks;
            self.report.chunks = chunk.checked_add(1).context("facts chunk count overflow")?;
            self.current = Some((0, 0));
            (self.callback)(Event::Begin { chunk })?;
        }
        let (number, size) = self
            .current
            .as_mut()
            .context("facts section does not start with a chunk header")?;
        *size = size
            .checked_add(bytes.len() as u64)
            .context("facts chunk size overflow")?;
        self.report.decoded_bytes = self
            .report
            .decoded_bytes
            .checked_add(bytes.len() as u64)
            .context("facts decoded size overflow")?;
        ensure!(
            *size <= self.limits.chunk_bytes,
            "facts chunk exceeds decoded size budget"
        );
        ensure!(
            self.report.decoded_bytes <= self.limits.total_bytes,
            "facts sections exceed decoded size budget"
        );
        *number += 1;
        self.report.largest_line = self.report.largest_line.max(bytes.len());
        (self.callback)(Event::Line {
            chunk: self.report.chunks - 1,
            number: *number,
            text,
        })
    }
}

pub fn visit_lines<'a>(
    sections: impl IntoIterator<Item = &'a [u8]>,
    limits: ReadLimits,
    callback: impl for<'line> FnMut(Event<'line>) -> Result<()>,
) -> Result<ReadReport> {
    let mut input = Input::new(Sections {
        sections: sections.into_iter(),
        current: &[],
    });
    let mut visitor = Visitor {
        callback,
        report: ReadReport::default(),
        limits,
        current: None,
    };
    let mut buffer = Vec::new();
    loop {
        let next = input.fill_buf()?;
        if next.is_empty() {
            break;
        }
        if next.starts_with(b"KCTZ") {
            visitor.finish()?;
            let mut header = [0u8; 24];
            input
                .read_exact(&mut header)
                .context("truncated compressed facts header")?;
            ensure!(
                &header[..8] == MAGIC,
                "unsupported compressed facts encoding"
            );
            let decoded = u64::from_le_bytes(header[8..16].try_into().unwrap());
            let encoded = u64::from_le_bytes(header[16..24].try_into().unwrap());
            ensure!(
                decoded <= limits.chunk_bytes,
                "compressed facts chunk exceeds decoded size budget"
            );
            ensure!(
                decoded
                    <= limits
                        .total_bytes
                        .saturating_sub(visitor.report.decoded_bytes),
                "facts sections exceed decoded size budget"
            );
            let mut frame = BufReader::with_capacity(
                64 * 1024,
                Frame {
                    input: &mut input,
                    decoder: Decompress::new(true),
                    encoded,
                    decoded,
                    ended: false,
                },
            );
            while line(&mut frame, &mut buffer, limits.line_bytes)? {
                visitor.accept(&buffer, true)?;
            }
            ensure!(
                visitor.current.is_some(),
                "compressed frame must contain one facts chunk"
            );
            visitor.finish()?;
        } else {
            if line(&mut input, &mut buffer, limits.line_bytes)? {
                visitor.accept(&buffer, false)?;
            }
        }
    }
    visitor.finish()?;
    ensure!(visitor.report.chunks != 0, "empty facts section");
    Ok(visitor.report)
}
