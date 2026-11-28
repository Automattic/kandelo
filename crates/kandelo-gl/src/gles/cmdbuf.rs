//! One EGL context's command buffer: the `kgpu-stream` bytes queued for its
//! next submission.
//!
//! Ownership: each context owns one `CommandBuffer`, a heap stream that
//! grows as records are queued and is submitted whole. Records are encoded
//! as they are queued, by `kgpu_stream::Encoder` (the wire format's single
//! definition), so a flush only finalizes the stream header and submits.
//! A record that would push the stream past `KGPU_MAX_STREAM` first submits
//! what is queued, so no stream the kernel would refuse is ever built.

use crate::kgpu::{Buffer, Device, KGPU_MAX_BUFFERS, KGPU_MAX_STREAM};
use alloc::vec::Vec;
use kgpu_stream::{Command, Encoder, RECORD_HEADER_SIZE, STREAM_HEADER_SIZE};

/// The offset of the stream header's `record_bytes` field (the layout in
/// `crates/kgpu-stream/src/lib.rs`). A test pins the header this module
/// writes to the one `Encoder::finish` writes for the same records.
const RECORD_BYTES_OFFSET: usize = 12;

/// The largest record: `ReadPixels`.
const MAX_RECORD: usize = RECORD_HEADER_SIZE + kgpu_stream::READ_PIXELS_PAYLOAD_SIZE as usize;

pub struct CommandBuffer {
    kgpu: u32,
    /// The stream header's space, then every queued record; empty when no
    /// record is queued.
    bytes: Vec<u8>,
    /// The guest ranges the queued records reference, by index.
    buffers: Vec<Buffer>,
    /// The sequence number of the last successful submission.
    last_seqno: Option<u64>,
}

impl CommandBuffer {
    pub fn new(kgpu: u32) -> Self {
        Self { kgpu, bytes: Vec::new(), buffers: Vec::new(), last_seqno: None }
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// The sequence number of the last successful submission, which a
    /// finish waits for.
    pub fn last_seqno(&self) -> Option<u64> {
        self.last_seqno
    }

    /// Queues `command`, submitting what is queued first if the record
    /// would push the stream past `KGPU_MAX_STREAM`. `Err` is the failed
    /// submission's errno; `command` is then not queued.
    pub fn record(&mut self, dev: &mut impl Device, command: Command) -> Result<(), i32> {
        let mut scratch = [0u8; STREAM_HEADER_SIZE + MAX_RECORD];
        let mut e = Encoder::new(&mut scratch, self.kgpu);
        let r = match command {
            Command::Viewport { x, y, w, h } => e.viewport(x, y, w, h),
            Command::ClearColor { r, g, b, a } => e.clear_color(r, g, b, a),
            Command::Clear { mask } => e.clear(mask),
            Command::ReadPixels { x, y, w, h, buffer } => e.read_pixels(x, y, w, h, buffer),
            Command::SurfaceCreate { surface, width, height } => e.surface_create(surface, width, height),
            Command::SurfaceDestroy { surface } => e.surface_destroy(surface),
            Command::SurfaceBind { surface } => e.surface_bind(surface),
        };
        r.expect("the scratch buffer holds the largest record");
        let end = e.finish().expect("the scratch buffer holds the largest record");
        let record = &scratch[STREAM_HEADER_SIZE..end];
        self.make_room(dev, record.len())?;
        if self.bytes.is_empty() {
            self.bytes.resize(STREAM_HEADER_SIZE, 0);
        }
        self.bytes.extend_from_slice(record);
        Ok(())
    }

    /// Queues a `ReadPixels` of `x, y, w, h` into `target`, which becomes
    /// the next entry of the submission's buffer table.
    pub fn record_read_pixels(
        &mut self,
        dev: &mut impl Device,
        (x, y, w, h): (i32, i32, i32, i32),
        target: Buffer,
    ) -> Result<(), i32> {
        if self.buffers.len() == KGPU_MAX_BUFFERS as usize {
            self.flush(dev)?;
        }
        // Room first, so the record's buffer index names the table the
        // record is submitted with.
        self.make_room(dev, MAX_RECORD)?;
        self.record(dev, Command::ReadPixels { x, y, w, h, buffer: self.buffers.len() as u32 })?;
        self.buffers.push(target);
        Ok(())
    }

    /// Submits what is queued if `len` more record bytes would push the
    /// stream past `KGPU_MAX_STREAM`.
    fn make_room(&mut self, dev: &mut impl Device, len: usize) -> Result<(), i32> {
        let queued = if self.bytes.is_empty() { STREAM_HEADER_SIZE } else { self.bytes.len() };
        if queued + len > KGPU_MAX_STREAM as usize {
            self.flush(dev)?;
        }
        Ok(())
    }

    /// Submits the queued records, if any, without waiting, and returns the
    /// submission's sequence number. `Err` is the submission's errno; the
    /// queue is discarded either way.
    pub fn flush(&mut self, dev: &mut impl Device) -> Result<Option<u64>, i32> {
        if self.bytes.is_empty() {
            return Ok(None);
        }
        let record_bytes = (self.bytes.len() - STREAM_HEADER_SIZE) as u32;
        Encoder::new(&mut self.bytes[..STREAM_HEADER_SIZE], self.kgpu)
            .finish()
            .expect("the header space is a stream header");
        self.bytes[RECORD_BYTES_OFFSET..RECORD_BYTES_OFFSET + 4].copy_from_slice(&record_bytes.to_le_bytes());
        let result = dev.submit(self.kgpu, &self.bytes, &self.buffers);
        self.discard();
        let seqno = result?;
        self.last_seqno = Some(seqno);
        Ok(Some(seqno))
    }

    /// Drops the queued records without submitting them.
    pub fn discard(&mut self) {
        self.bytes.clear();
        self.buffers.clear();
    }

    /// The bytes a flush would submit now, header included, for tests.
    #[cfg(test)]
    pub(crate) fn stream_len(&self) -> usize {
        self.bytes.len()
    }
}
