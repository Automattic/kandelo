//! Native executor tests over the recording and null backends.
//!
//! These drive `Executor::handle_record` with records encoded by the shared
//! kernel-host codec and streams encoded by `kgpu_stream::Encoder`, the same
//! producers the kernel and the guest driver use, so a format drift breaks
//! these tests rather than a browser run.

use super::*;
use crate::backend::{Call, NullBackend, RecordingBackend};
use kgpu_stream::{CLEAR_COLOR_BIT, Encoder};
use wasm_posix_shared::kgpu::{
    BufferSpec, Extent, KGPU_ACCESS_READ, KGPU_ACCESS_WRITE, SubmissionHeader, SubmissionKind,
    encode_submission,
};

const EPROTO: i32 = -71;
const EINVAL: i32 = -22;
const ENODEV: i32 = -19;
const EIO: i32 = -5;
const ENOENT: i32 = -2;

fn ext(offset: u64, len: u32) -> Extent {
    Extent {
        offset,
        len,
        pad: 0,
    }
}

fn control(kind: SubmissionKind, context: u32) -> Vec<u8> {
    let mut out = vec![0u8; 64];
    let n = encode_submission(
        &mut out,
        &SubmissionHeader {
            kind,
            context,
            seqno: 0,
        },
        &[],
        &[],
    )
    .unwrap();
    out.truncate(n);
    out
}

/// A submit record whose stream is one extent of `stream_len` bytes, which
/// is what the worker shell copies contiguously into executor memory.
fn submit(context: u32, seqno: u64, stream_len: usize, buffers: &[(u32, &[Extent])]) -> Vec<u8> {
    let specs: Vec<BufferSpec<'_>> = buffers
        .iter()
        .map(|(access, extents)| BufferSpec {
            access: *access,
            extents,
        })
        .collect();
    let mut out = vec![0u8; 4096];
    let n = encode_submission(
        &mut out,
        &SubmissionHeader {
            kind: SubmissionKind::Submit,
            context,
            seqno,
        },
        &[ext(0x1000, stream_len as u32)],
        &specs,
    )
    .unwrap();
    out.truncate(n);
    out
}

fn stream(context: u32, body: impl FnOnce(&mut Encoder<'_>)) -> Vec<u8> {
    let mut out = vec![0u8; 1024];
    let mut e = Encoder::new(&mut out, context);
    body(&mut e);
    let n = e.finish().unwrap();
    out.truncate(n);
    out
}

fn clear_and_read(context: u32) -> Vec<u8> {
    stream(context, |e| {
        e.viewport(0, 0, 4, 4).unwrap();
        e.clear_color(0.2, 0.4, 0.6, 1.0).unwrap();
        e.clear(CLEAR_COLOR_BIT).unwrap();
        e.read_pixels(0, 0, 4, 4, 0).unwrap();
    })
}

fn completion(kind: CompletionKind, context: u32, seqno: u64, status: i32) -> Completion {
    Completion {
        kind,
        context,
        seqno,
        status,
    }
}

fn recording() -> Executor<RecordingBackend> {
    Executor::new(RecordingBackend::new())
}

fn create(exec: &mut Executor<impl Backend>, context: u32) -> Completion {
    exec.handle_record(&control(SubmissionKind::ContextCreate, context), &[])
}

#[test]
fn clear_and_readback_records_calls() {
    let mut exec = recording();
    assert_eq!(
        create(&mut exec, 7),
        completion(CompletionKind::ContextReady, 7, 0, 0)
    );

    // 64 bytes of destination, split across two discontiguous frames.
    let dst = [ext(0x2000, 40), ext(0x9000, 24)];
    let s = clear_and_read(7);
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::Retired, 7, 1, 0)
    );

    assert_eq!(
        exec.backend().calls,
        vec![
            Call::CreateSurface {
                context: 7,
                width: 4,
                height: 4
            },
            Call::Viewport {
                context: 7,
                x: 0,
                y: 0,
                w: 4,
                h: 4
            },
            Call::ClearColor {
                context: 7,
                rgba: [0.2, 0.4, 0.6, 1.0]
            },
            Call::Clear {
                context: 7,
                mask: 0x4000
            },
            Call::ReadPixels {
                context: 7,
                x: 0,
                y: 0,
                w: 4,
                h: 4,
                dst: dst.to_vec()
            },
        ]
    );
}

#[test]
fn stream_context_mismatch_faults_context() {
    let mut exec = recording();
    create(&mut exec, 7);
    create(&mut exec, 8);
    let dst = [ext(0x2000, 64)];

    // Context 7 submits a stream that names context 8.
    let s = clear_and_read(8);
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EPROTO)
    );

    // Nothing ran, for either context; only 7's surface was released.
    assert_eq!(
        exec.backend().calls,
        vec![
            Call::CreateSurface {
                context: 7,
                width: 4,
                height: 4
            },
            Call::CreateSurface {
                context: 8,
                width: 4,
                height: 4
            },
            Call::DestroySurface { context: 7 },
        ]
    );

    // The fault is sticky for 7 and invisible to 8.
    let s7 = clear_and_read(7);
    let r7 = submit(7, 2, s7.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r7, &s7),
        completion(CompletionKind::ContextLost, 7, 2, EIO)
    );
    let s8 = clear_and_read(8);
    let r8 = submit(8, 3, s8.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r8, &s8),
        completion(CompletionKind::Retired, 8, 3, 0)
    );
    assert_eq!(exec.backend().calls.len(), 3 + 4);
}

#[test]
fn readpixels_into_read_only_buffer_faults() {
    let dst = [ext(0x2000, 64)];
    let s = clear_and_read(7);

    // Read-only destination.
    let mut exec = recording();
    create(&mut exec, 7);
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_READ, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EINVAL)
    );
    // Validation precedes execution: not even the viewport ran.
    assert_eq!(
        exec.backend().calls,
        vec![
            Call::CreateSurface {
                context: 7,
                width: 4,
                height: 4
            },
            Call::DestroySurface { context: 7 },
        ]
    );

    // A write buffer one byte short of w*h*4.
    let mut exec = recording();
    create(&mut exec, 7);
    let short = [ext(0x2000, 40), ext(0x9000, 23)];
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &short)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EINVAL)
    );

    // A buffer index past the table.
    let mut exec = recording();
    create(&mut exec, 7);
    let r = submit(7, 1, s.len(), &[]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EINVAL)
    );

    // Negative dimensions are not a huge unsigned read.
    let mut exec = recording();
    create(&mut exec, 7);
    let neg = stream(7, |e| e.read_pixels(0, 0, -1, -1, 0).unwrap());
    let r = submit(7, 1, neg.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &neg),
        completion(CompletionKind::ContextLost, 7, 1, EINVAL)
    );
}

#[test]
fn nonzero_reserved_or_record_flags_fault() {
    let dst = [ext(0x2000, 64)];
    for at in [6usize, 16 + 2] {
        let mut exec = recording();
        create(&mut exec, 7);
        let mut s = clear_and_read(7);
        s[at] = 1;
        let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
        assert_eq!(
            exec.handle_record(&r, &s),
            completion(CompletionKind::ContextLost, 7, 1, EPROTO),
            "byte {at}"
        );
        assert_eq!(exec.backend().calls.len(), 2, "byte {at}: nothing may run");
    }
    // A flag on a later record also stops the whole stream before any of it
    // runs.
    let mut exec = recording();
    create(&mut exec, 7);
    let mut s = clear_and_read(7);
    let last = s.len() - (8 + 20);
    s[last + 2] = 0x80;
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EPROTO)
    );
    assert_eq!(exec.backend().calls.len(), 2);
}

#[test]
fn stream_length_must_match_record_and_header() {
    let dst = [ext(0x2000, 64)];
    let s = clear_and_read(7);

    // The record's stream extents describe a different length than the
    // shell copied.
    let mut exec = recording();
    create(&mut exec, 7);
    let r = submit(7, 1, s.len() + 4, &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EPROTO)
    );

    // Bytes past the header's record_bytes.
    let mut exec = recording();
    create(&mut exec, 7);
    let mut long = s.clone();
    long.extend_from_slice(&[0; 8]);
    let r = submit(7, 1, long.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &long),
        completion(CompletionKind::ContextLost, 7, 1, EPROTO)
    );
}

#[test]
fn unknown_context_and_destroy() {
    let mut exec = recording();
    let s = clear_and_read(5);
    let r = submit(5, 1, s.len(), &[]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 5, 1, ENOENT)
    );
    assert!(exec.backend().calls.is_empty());

    create(&mut exec, 5);
    let d = control(SubmissionKind::ContextDestroy, 5);
    assert_eq!(
        exec.handle_record(&d, &[]),
        completion(CompletionKind::Retired, 5, 0, 0)
    );
    assert_eq!(
        exec.handle_record(&d, &[]),
        completion(CompletionKind::ContextLost, 5, 0, ENOENT)
    );
    assert_eq!(
        exec.backend().calls,
        vec![
            Call::CreateSurface {
                context: 5,
                width: 4,
                height: 4
            },
            Call::DestroySurface { context: 5 },
        ]
    );
}

#[test]
fn lost_device_faults_the_submitting_context() {
    let mut exec = recording();
    create(&mut exec, 7);
    exec.backend_mut().lost = true;
    let dst = [ext(0x2000, 64)];
    let s = clear_and_read(7);
    let r = submit(7, 1, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EIO)
    );
}

#[test]
fn failed_surface_allocation_reports_its_errno() {
    let mut exec = recording();
    exec.backend_mut().create_result = Err(-12);
    assert_eq!(
        create(&mut exec, 7),
        completion(CompletionKind::ContextLost, 7, 0, -12)
    );
    // A backend that reports a non-negative "error" still yields a failure.
    exec.backend_mut().create_result = Err(3);
    assert_eq!(
        create(&mut exec, 8),
        completion(CompletionKind::ContextLost, 8, 0, EIO)
    );
}

#[test]
fn malformed_record_faults_named_context() {
    let mut exec = recording();
    create(&mut exec, 7);
    let mut r = control(SubmissionKind::ContextCreate, 7);
    r[0] = 99;
    assert_eq!(
        exec.handle_record(&r, &[]),
        completion(CompletionKind::ContextLost, 7, 0, EPROTO)
    );
    assert_eq!(
        exec.backend().calls.last(),
        Some(&Call::DestroySurface { context: 7 })
    );
    // Too short to name a context at all.
    assert_eq!(
        exec.handle_record(&[1, 0], &[]),
        completion(CompletionKind::ContextLost, 0, 0, EPROTO)
    );
}

#[test]
fn null_backend_reports_enodev_on_create() {
    let mut exec = Executor::new(NullBackend);
    assert_eq!(
        create(&mut exec, 7),
        completion(CompletionKind::ContextLost, 7, 0, ENODEV)
    );
    // The context stays lost, as the kernel sees it, until its destroy.
    let s = clear_and_read(7);
    let r = submit(7, 1, s.len(), &[]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::ContextLost, 7, 1, EIO)
    );
    let d = control(SubmissionKind::ContextDestroy, 7);
    assert_eq!(
        exec.handle_record(&d, &[]),
        completion(CompletionKind::Retired, 7, 0, 0)
    );
}

/// xorshift64*: deterministic, so a failure reproduces from the iteration
/// number alone.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn bytes(&mut self, max: usize) -> Vec<u8> {
        let len = (self.next() % (max as u64 + 1)) as usize;
        (0..len).map(|_| self.next() as u8).collect()
    }
}

#[test]
fn garbage_streams_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut exec = recording();
    // A bystander context that no garbage targets.
    create(&mut exec, 9);
    let bystander_calls = exec.backend().calls.len();
    let dst = [ext(0x2000, 64)];
    let mut faults = 0;

    for i in 0..10_000u32 {
        let context = 100 + i;
        let seqno = u64::from(i) + 1;
        assert_eq!(
            create(&mut exec, context).kind,
            CompletionKind::ContextReady
        );
        let (record, stream) = match i % 3 {
            // Garbage everywhere: record and stream.
            0 => (rng.bytes(512), rng.bytes(512)),
            // A well-formed record over a garbage stream.
            1 => {
                let s = rng.bytes(512);
                (
                    submit(context, seqno, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]),
                    s,
                )
            }
            // A valid stream header over garbage records, so the record
            // walker, not the header check, meets the noise.
            _ => {
                let body = rng.bytes(512 - 16);
                let mut s = clear_and_read(context)[..16].to_vec();
                s[12..16].copy_from_slice(&(body.len() as u32).to_le_bytes());
                s.extend_from_slice(&body);
                (
                    submit(context, seqno, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]),
                    s,
                )
            }
        };
        let c = exec.handle_record(&record, &stream);
        if i % 3 != 0 {
            assert_eq!(c.context, context, "iteration {i}");
            assert_eq!(c.seqno, seqno, "iteration {i}");
            if c.kind == CompletionKind::ContextLost {
                assert!(c.status < 0, "iteration {i}");
                faults += 1;
            } else {
                assert_eq!(
                    c,
                    completion(CompletionKind::Retired, context, seqno, 0),
                    "iteration {i}"
                );
            }
        }
        let d = exec.handle_record(&control(SubmissionKind::ContextDestroy, context), &[]);
        assert_eq!(d.context, context, "iteration {i}");
    }
    assert!(
        faults > 6_000,
        "the generator must reach the fault paths, got {faults}"
    );

    // No garbage reached the bystander, which still works.
    assert!(
        exec.backend().calls[bystander_calls..]
            .iter()
            .all(|call| !matches!(
                call,
                Call::CreateSurface { context: 9, .. }
                    | Call::DestroySurface { context: 9 }
                    | Call::Viewport { context: 9, .. }
                    | Call::ClearColor { context: 9, .. }
                    | Call::Clear { context: 9, .. }
                    | Call::ReadPixels { context: 9, .. }
            ))
    );
    let s = clear_and_read(9);
    let r = submit(9, 99_999, s.len(), &[(KGPU_ACCESS_WRITE, &dst)]);
    assert_eq!(
        exec.handle_record(&r, &s),
        completion(CompletionKind::Retired, 9, 99_999, 0)
    );
}
