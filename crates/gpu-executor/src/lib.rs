//! The kgpu executor: the GPU-side half of the kernel's `kgpu` device.
//!
//! Ownership: the kernel owns contexts, sequence numbers, pins and waits
//! (`crates/runtime-core/src/dri/kgpu`); the GPU worker shell owns transport
//! (rings, doorbells, copying bytes). This crate owns everything in between:
//! it decodes each submission record and its command stream, decides whether
//! they are valid for the context that submitted them, drives a `Backend`,
//! and answers each record with exactly one completion record.
//!
//! WHY a separate Rust module: the command stream is guest-written and the
//! kernel validates only its header, so the code that interprets records is
//! the code that must treat them as hostile. Doing that once, in Rust, keeps
//! the rules identical on every host and keeps GL-shaped decisions out of
//! TypeScript (`docs/plans/2026-11-27-rust-gpu-driver-design.md`).
//!
//! Validation rules, all enforced before any command of a stream runs, so a
//! rejected stream has no partial effect:
//!
//! - The record decodes exactly (`wasm_posix_shared::kgpu`), and the stream
//!   bytes the shell copied match the record's stream extents in length.
//! - The stream header decodes, its `reserved` field is zero, its
//!   `record_bytes` covers the whole stream, and its `context` is the
//!   record's context. Every record decodes and carries zero `flags`, so a v1
//!   executor never silently misreads a future flag.
//! - Dimensions are non-negative and clear masks name only known bits.
//! - `ReadPixels.buffer` indexes a WRITE buffer of at least `w*h*4` bytes.
//!
//! A violation faults the submitting context: its surface is released, it
//! answers `ContextLost` with a negative errno, and every later record for it
//! answers `ContextLost` too. No other context's state is consulted or
//! changed, and nothing here can panic, so hostile input can neither trap the
//! module nor reach a neighbour.
#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod backend;
#[cfg(all(target_arch = "wasm32", feature = "standalone"))]
pub mod wasm;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use backend::Backend;
use kgpu_stream::{
    CLEAR_COLOR_BIT, CLEAR_DEPTH_BIT, CLEAR_STENCIL_BIT, Command, Op, RECORD_HEADER_SIZE,
    STREAM_HEADER_SIZE,
};
use wasm_posix_shared::Errno;
use wasm_posix_shared::kgpu::{
    Completion, CompletionKind, Extent, KGPU_ACCESS_WRITE, KGPU_MAX_STREAM, SubmissionHeader,
    SubmissionKind, SubmissionView, decode_submission,
};

/// Slice 1 gives every context a fixed 4x4 surface; sized surfaces arrive
/// with the EGL surface work.
pub const SURFACE_WIDTH: u32 = 4;
pub const SURFACE_HEIGHT: u32 = 4;

const fn neg(errno: Errno) -> i32 {
    -(errno as i32)
}
const EPROTO: i32 = neg(Errno::EPROTO);
const EINVAL: i32 = neg(Errno::EINVAL);
const EIO: i32 = neg(Errno::EIO);
const ENOENT: i32 = neg(Errno::ENOENT);
const EEXIST: i32 = neg(Errno::EEXIST);
const ENOMEM: i32 = neg(Errno::ENOMEM);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// The backend holds a surface for the context.
    Live,
    /// Faulted, or creation failed: no surface, and every record fails
    /// until the kernel's destroy removes the entry.
    Lost,
}

pub struct Executor<B: Backend> {
    backend: B,
    contexts: BTreeMap<u32, State>,
}

impl<B: Backend> Executor<B> {
    pub const fn new(backend: B) -> Self {
        Executor {
            backend,
            contexts: BTreeMap::new(),
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    /// Handle one submission record. `record` is the kernel's submission
    /// record; `stream` holds the command bytes the shell copied, in order,
    /// from the record's stream extents into executor memory (empty for a
    /// control record).
    pub fn handle_record(&mut self, record: &[u8], stream: &[u8]) -> Completion {
        let view = match decode_submission(record) {
            Ok(view) if view.encoded_len == record.len() => view,
            _ => {
                // The kernel encodes every record, so an undecodable one
                // means the transport is out of step. Fault only the
                // context the header names, if it names one.
                let context = le_u32(record, 4).unwrap_or(0);
                let seqno = le_u64(record, 8).unwrap_or(0);
                return self.fault(context, seqno, EPROTO);
            }
        };
        let header = view.header;
        if header.kind != SubmissionKind::Submit && !stream.is_empty() {
            return self.fault(header.context, header.seqno, EPROTO);
        }
        match header.kind {
            SubmissionKind::ContextCreate => self.create(header),
            SubmissionKind::ContextDestroy => self.destroy(header),
            SubmissionKind::Submit => self.submit(&view, stream),
        }
    }

    /// Ruling R4: a created context answers `ContextReady`; a failed one
    /// answers `ContextLost` with the backend's errno and stays as a lost
    /// entry, matching the kernel's view of it until its destroy arrives.
    fn create(&mut self, h: SubmissionHeader) -> Completion {
        if self.contexts.contains_key(&h.context) {
            // The kernel never reuses an id, so a second create means the
            // two sides disagree about this context; it can't be trusted.
            return self.fault(h.context, h.seqno, EEXIST);
        }
        let result = if self.backend.is_lost() {
            Err(EIO)
        } else {
            self.backend
                .create_surface(h.context, SURFACE_WIDTH, SURFACE_HEIGHT)
        };
        match result {
            Ok(()) => {
                self.contexts.insert(h.context, State::Live);
                completion(CompletionKind::ContextReady, h, 0)
            }
            Err(status) => {
                self.contexts.insert(h.context, State::Lost);
                completion(CompletionKind::ContextLost, h, errno(status))
            }
        }
    }

    /// The kernel queues a destroy after the context's work, so everything
    /// before it has already been answered.
    fn destroy(&mut self, h: SubmissionHeader) -> Completion {
        match self.contexts.remove(&h.context) {
            Some(State::Live) => {
                self.backend.destroy_surface(h.context);
                completion(CompletionKind::Retired, h, 0)
            }
            Some(State::Lost) => completion(CompletionKind::Retired, h, 0),
            None => completion(CompletionKind::ContextLost, h, ENOENT),
        }
    }

    fn submit(&mut self, view: &SubmissionView<'_>, stream: &[u8]) -> Completion {
        let h = view.header;
        match self.contexts.get(&h.context) {
            None => return completion(CompletionKind::ContextLost, h, ENOENT),
            Some(State::Lost) => return completion(CompletionKind::ContextLost, h, EIO),
            Some(State::Live) => {}
        }
        if self.backend.is_lost() {
            return self.fault(h.context, h.seqno, EIO);
        }
        let commands = match plan(view, stream) {
            Ok(commands) => commands,
            Err(status) => return self.fault(h.context, h.seqno, status),
        };
        if let Err(status) = self.execute(view, &commands) {
            return self.fault(h.context, h.seqno, status);
        }
        if self.backend.is_lost() {
            return self.fault(h.context, h.seqno, EIO);
        }
        completion(CompletionKind::Retired, h, 0)
    }

    fn execute(&mut self, view: &SubmissionView<'_>, commands: &[Command]) -> Result<(), i32> {
        let context = view.header.context;
        let mut dst: Vec<Extent> = Vec::new();
        for command in commands {
            match *command {
                Command::Viewport { x, y, w, h } => self.backend.viewport(context, x, y, w, h),
                Command::ClearColor { r, g, b, a } => {
                    self.backend.clear_color(context, [r, g, b, a])
                }
                Command::Clear { mask } => self.backend.clear(context, mask),
                Command::ReadPixels { x, y, w, h, buffer } => {
                    destination(view, buffer, pixel_bytes(w, h)?, &mut dst)?;
                    self.backend
                        .read_pixels(context, x, y, w, h, &dst)
                        .map_err(errno)?;
                }
            }
        }
        Ok(())
    }

    /// Fault `context` (if it exists) and answer `ContextLost`.
    fn fault(&mut self, context: u32, seqno: u64, status: i32) -> Completion {
        if let Some(state) = self.contexts.get_mut(&context) {
            if *state == State::Live {
                self.backend.destroy_surface(context);
            }
            *state = State::Lost;
        }
        Completion {
            kind: CompletionKind::ContextLost,
            context,
            seqno,
            status,
        }
    }
}

fn completion(kind: CompletionKind, h: SubmissionHeader, status: i32) -> Completion {
    Completion {
        kind,
        context: h.context,
        seqno: h.seqno,
        status,
    }
}

/// A backend failure is always a failure: a non-negative "error" becomes
/// `EIO` rather than reading as success on the kernel side.
fn errno(status: i32) -> i32 {
    if status < 0 { status } else { EIO }
}

fn le_u32(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn le_u64(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at.checked_add(8)?)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Some(u64::from_le_bytes(a))
}

fn le_u16(b: &[u8], at: usize) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn pixel_bytes(w: i32, h: i32) -> Result<u64, i32> {
    if w < 0 || h < 0 {
        return Err(EINVAL);
    }
    // Two non-negative i32s times 4 fit in u64.
    Ok(w as u64 * h as u64 * 4)
}

fn command_op(command: &Command) -> Op {
    match command {
        Command::Viewport { .. } => Op::Viewport,
        Command::ClearColor { .. } => Op::ClearColor,
        Command::Clear { .. } => Op::Clear,
        Command::ReadPixels { .. } => Op::ReadPixels,
    }
}

/// Decode and validate a whole stream into commands, or refuse it.
fn plan(view: &SubmissionView<'_>, stream: &[u8]) -> Result<Vec<Command>, i32> {
    if stream.len() > KGPU_MAX_STREAM as usize {
        return Err(EPROTO);
    }
    let mut described: u64 = 0;
    for i in 0..view.stream_extent_count() {
        let extent = view.stream_extent(i).ok_or(EPROTO)?;
        described = described.checked_add(u64::from(extent.len)).ok_or(EPROTO)?;
    }
    if described != stream.len() as u64 {
        return Err(EPROTO);
    }
    let decoded = kgpu_stream::decode(stream).map_err(|_| EPROTO)?;
    // `decode` has checked the header is present, so these reads succeed.
    let reserved = le_u16(stream, 6).ok_or(EPROTO)?;
    let record_bytes = le_u32(stream, 12).ok_or(EPROTO)?;
    if reserved != 0
        || decoded.context != view.header.context
        || STREAM_HEADER_SIZE as u64 + u64::from(record_bytes) != stream.len() as u64
    {
        return Err(EPROTO);
    }
    let mut commands = Vec::new();
    let mut at = STREAM_HEADER_SIZE;
    for item in decoded.records {
        let command = item.map_err(|_| EPROTO)?;
        if le_u16(stream, at + 2) != Some(0) {
            return Err(EPROTO);
        }
        check(view, &command)?;
        commands.try_reserve(1).map_err(|_| ENOMEM)?;
        commands.push(command);
        at += RECORD_HEADER_SIZE + command_op(&command).payload_size() as usize;
    }
    Ok(commands)
}

fn check(view: &SubmissionView<'_>, command: &Command) -> Result<(), i32> {
    match *command {
        Command::Viewport { w, h, .. } => {
            pixel_bytes(w, h)?;
        }
        Command::ClearColor { .. } => {}
        Command::Clear { mask } => {
            if mask & !(CLEAR_COLOR_BIT | CLEAR_DEPTH_BIT | CLEAR_STENCIL_BIT) != 0 {
                return Err(EINVAL);
            }
        }
        Command::ReadPixels { w, h, buffer, .. } => {
            let need = pixel_bytes(w, h)?;
            let target = view.buffer(buffer).ok_or(EINVAL)?;
            if target.access & KGPU_ACCESS_WRITE == 0 {
                return Err(EINVAL);
            }
            let mut have: u64 = 0;
            for i in 0..target.extent_count() {
                have = have.saturating_add(u64::from(target.extent(i).ok_or(EPROTO)?.len));
            }
            if have < need {
                return Err(EINVAL);
            }
        }
    }
    Ok(())
}

/// The extents of `buffer` that cover exactly its first `need` bytes, so a
/// backend is handed no more of the guest's memory than the read writes.
fn destination(
    view: &SubmissionView<'_>,
    buffer: u32,
    need: u64,
    out: &mut Vec<Extent>,
) -> Result<(), i32> {
    out.clear();
    let target = view.buffer(buffer).ok_or(EINVAL)?;
    let mut left = need;
    for i in 0..target.extent_count() {
        if left == 0 {
            break;
        }
        let mut extent = target.extent(i).ok_or(EPROTO)?;
        if u64::from(extent.len) > left {
            extent.len = left as u32;
        }
        left -= u64::from(extent.len);
        out.try_reserve(1).map_err(|_| ENOMEM)?;
        out.push(extent);
    }
    if left != 0 { Err(EINVAL) } else { Ok(()) }
}

#[cfg(test)]
mod tests;
