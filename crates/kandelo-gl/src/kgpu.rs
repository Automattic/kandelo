//! The driver's one seam to the kernel: the `kandelo.kgpu.v1` program
//! extension.
//!
//! Ownership: everything above this module models EGL and GL state in
//! process; only `Device` reaches the kernel, and only to create and destroy
//! kgpu contexts, submit `kgpu-stream` command buffers and wait for them.
//! Keeping that seam a trait lets native tests run the same driver code over
//! `FakeDevice` and count exactly how many kgpu trips each GL call makes.
//!
//! The argument structs and constants come from `wasm_posix_shared::kgpu`,
//! the definition `<kandelo/kgpu.h>` is generated from, so the driver, the
//! kernel and C clients read one layout. The asserts below pin it to the
//! header's sizes and offsets as well.

use core::mem::{offset_of, size_of};
use wasm_posix_shared::kgpu::{KgpuContextCreate, KgpuContextDestroy, KgpuSubmit, KgpuWait};
pub use wasm_posix_shared::kgpu::{
    KGPU_ACCESS_READ, KGPU_ACCESS_WRITE, KGPU_MAX_BUFFERS, KGPU_MAX_STREAM, KGPU_OP_CONTEXT_CREATE,
    KGPU_OP_CONTEXT_DESTROY, KGPU_OP_SUBMIT, KGPU_OP_WAIT,
};

/// One guest memory range a submission reads or writes (`struct kgpu_buffer`).
pub type Buffer = wasm_posix_shared::kgpu::KgpuBuffer;

const _: () = {
    assert!(size_of::<KgpuContextCreate>() == 8);
    assert!(size_of::<KgpuContextDestroy>() == 8);
    assert!(size_of::<KgpuSubmit>() == 40);
    assert!(size_of::<Buffer>() == 16);
    assert!(size_of::<KgpuWait>() == 24);
    assert!(offset_of!(KgpuSubmit, stream_addr) == 8);
    assert!(offset_of!(KgpuSubmit, buffers_addr) == 24);
    assert!(offset_of!(KgpuSubmit, seqno) == 32);
    assert!(offset_of!(KgpuWait, seqno) == 8);
    assert!(offset_of!(KgpuWait, timeout_ns) == 16);
};

/// The kernel operations the driver uses. Every error is a negative errno,
/// exactly as `__kandelo_kgpu_v1` returns it.
pub trait Device {
    /// Creates a kgpu context and returns its id.
    fn context_create(&mut self) -> Result<u32, i32>;
    fn context_destroy(&mut self, context: u32) -> Result<(), i32>;
    /// Queues `stream` (a complete `kgpu-stream` buffer) on `context` with
    /// the guest ranges it references, and returns its sequence number.
    fn submit(&mut self, context: u32, stream: &[u8], buffers: &[Buffer]) -> Result<u64, i32>;
    /// Waits until `seqno` on `context` retires. A negative `timeout_ns`
    /// waits forever; zero polls.
    fn wait(&mut self, context: u32, seqno: u64, timeout_ns: i64) -> Result<(), i32>;
}

/// The real device: the `kandelo.kgpu.v1` import of the program the driver
/// is linked into.
pub struct KgpuDevice;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "kandelo.kgpu.v1")]
unsafe extern "C" {
    fn __kandelo_kgpu_v1(arg: *mut u8, size: i32, op: i32) -> i32;
}

#[cfg(target_arch = "wasm32")]
const EINVAL: i32 = 22;

#[cfg(target_arch = "wasm32")]
fn call<T>(op: i32, arg: &mut T) -> Result<i32, i32> {
    let r = unsafe { __kandelo_kgpu_v1(arg as *mut T as *mut u8, size_of::<T>() as i32, op) };
    if r < 0 { Err(r) } else { Ok(r) }
}

#[cfg(target_arch = "wasm32")]
impl Device for KgpuDevice {
    fn context_create(&mut self) -> Result<u32, i32> {
        let mut arg = KgpuContextCreate { flags: 0, context: 0 };
        call(KGPU_OP_CONTEXT_CREATE, &mut arg)?;
        Ok(arg.context)
    }

    fn context_destroy(&mut self, context: u32) -> Result<(), i32> {
        call(KGPU_OP_CONTEXT_DESTROY, &mut KgpuContextDestroy { context, pad: 0 }).map(drop)
    }

    fn submit(&mut self, context: u32, stream: &[u8], buffers: &[Buffer]) -> Result<u64, i32> {
        // Guest addresses are the program's own pointers; the kernel
        // resolves and bounds them, and refuses oversized counts itself.
        let mut arg = KgpuSubmit {
            context,
            flags: 0,
            stream_addr: stream.as_ptr() as usize as u64,
            stream_len: u32::try_from(stream.len()).map_err(|_| -EINVAL)?,
            buffer_count: u32::try_from(buffers.len()).map_err(|_| -EINVAL)?,
            buffers_addr: buffers.as_ptr() as usize as u64,
            seqno: 0,
        };
        call(KGPU_OP_SUBMIT, &mut arg)?;
        Ok(arg.seqno)
    }

    fn wait(&mut self, context: u32, seqno: u64, timeout_ns: i64) -> Result<(), i32> {
        call(KGPU_OP_WAIT, &mut KgpuWait { context, flags: 0, seqno, timeout_ns }).map(drop)
    }
}

/// Native builds have no kgpu: the driver runs there only over `FakeDevice`.
#[cfg(not(target_arch = "wasm32"))]
impl Device for KgpuDevice {
    fn context_create(&mut self) -> Result<u32, i32> {
        unimplemented!("kgpu exists only in a wasm32 Kandelo guest")
    }
    fn context_destroy(&mut self, _context: u32) -> Result<(), i32> {
        unimplemented!("kgpu exists only in a wasm32 Kandelo guest")
    }
    fn submit(&mut self, _context: u32, _stream: &[u8], _buffers: &[Buffer]) -> Result<u64, i32> {
        unimplemented!("kgpu exists only in a wasm32 Kandelo guest")
    }
    fn wait(&mut self, _context: u32, _seqno: u64, _timeout_ns: i64) -> Result<(), i32> {
        unimplemented!("kgpu exists only in a wasm32 Kandelo guest")
    }
}

#[cfg(any(test, feature = "fake"))]
pub use fake::{Call, FakeDevice, FakeOp};

#[cfg(any(test, feature = "fake"))]
mod fake {
    use super::{Buffer, Device};
    use alloc::collections::VecDeque;
    use alloc::vec::Vec;
    use kgpu_stream::Command;

    /// Which `Device` operation a scripted result answers.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum FakeOp {
        ContextCreate,
        ContextDestroy,
        Submit,
        Wait,
    }

    /// One recorded kgpu trip. A submit is recorded decoded, so tests
    /// assert on commands rather than bytes.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Call {
        ContextCreate,
        ContextDestroy { context: u32 },
        Submit { context: u32, stream_context: u32, commands: Vec<Command>, buffers: Vec<Buffer> },
        Wait { context: u32, seqno: u64, timeout_ns: i64 },
    }

    /// A device that records every call and, unless a scripted error is
    /// queued for that operation, succeeds: contexts are numbered from 1
    /// and each submission gets the next sequence number, from 1.
    ///
    /// A submitted stream that does not decode is a driver defect, not a
    /// device answer, so the fake panics on it instead of returning an
    /// error the driver might handle.
    #[derive(Default)]
    pub struct FakeDevice {
        log: Vec<Call>,
        script: VecDeque<(FakeOp, i32)>,
        next_context: u32,
        next_seqno: u64,
    }

    impl FakeDevice {
        pub fn new() -> Self {
            Self::default()
        }

        /// The next `op` call fails with `errno` (a negative errno).
        /// Scripted errors for one operation answer in the order queued.
        pub fn fail_next(&mut self, op: FakeOp, errno: i32) {
            assert!(errno < 0, "a kgpu error is a negative errno");
            self.script.push_back((op, errno));
        }

        /// How many kgpu trips the driver has made.
        pub fn calls(&self) -> usize {
            self.log.len()
        }

        pub fn log(&self) -> &[Call] {
            &self.log
        }

        fn scripted(&mut self, op: FakeOp) -> Result<(), i32> {
            match self.script.iter().position(|&(o, _)| o == op) {
                Some(i) => Err(self.script.remove(i).unwrap().1),
                None => Ok(()),
            }
        }
    }

    impl Device for FakeDevice {
        fn context_create(&mut self) -> Result<u32, i32> {
            self.log.push(Call::ContextCreate);
            self.scripted(FakeOp::ContextCreate)?;
            self.next_context += 1;
            Ok(self.next_context)
        }

        fn context_destroy(&mut self, context: u32) -> Result<(), i32> {
            self.log.push(Call::ContextDestroy { context });
            self.scripted(FakeOp::ContextDestroy)
        }

        fn submit(&mut self, context: u32, stream: &[u8], buffers: &[Buffer]) -> Result<u64, i32> {
            let decoded = kgpu_stream::decode(stream)
                .unwrap_or_else(|e| panic!("the driver submitted an undecodable stream: {e:?}"));
            let stream_context = decoded.context;
            let commands = decoded
                .records
                .collect::<Result<Vec<_>, _>>()
                .unwrap_or_else(|e| panic!("the driver submitted a malformed record: {e:?}"));
            self.log.push(Call::Submit { context, stream_context, commands, buffers: buffers.to_vec() });
            self.scripted(FakeOp::Submit)?;
            self.next_seqno += 1;
            Ok(self.next_seqno)
        }

        fn wait(&mut self, context: u32, seqno: u64, timeout_ns: i64) -> Result<(), i32> {
            self.log.push(Call::Wait { context, seqno, timeout_ns });
            self.scripted(FakeOp::Wait)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kgpu_stream::{Command, Encoder};

    const EIO: i32 = 5;

    #[test]
    fn the_fake_records_and_decodes_every_trip() {
        let mut device = FakeDevice::new();
        let context = device.context_create().unwrap();
        assert_eq!(context, 1);
        let mut bytes = [0u8; 128];
        let mut encoder = Encoder::new(&mut bytes, context);
        encoder.clear_color(0.0, 0.5, 1.0, 1.0).unwrap();
        encoder.clear(kgpu_stream::CLEAR_COLOR_BIT).unwrap();
        let len = encoder.finish().unwrap();
        let pixels = Buffer { addr: 0x1000, len: 64, access: KGPU_ACCESS_WRITE };
        assert_eq!(device.submit(context, &bytes[..len], &[pixels]), Ok(1));
        assert_eq!(device.wait(context, 1, -1), Ok(()));
        assert_eq!(device.context_destroy(context), Ok(()));
        assert_eq!(device.calls(), 4);
        assert_eq!(device.log()[1], Call::Submit {
            context,
            stream_context: context,
            commands: vec![
                Command::ClearColor { r: 0.0, g: 0.5, b: 1.0, a: 1.0 },
                Command::Clear { mask: kgpu_stream::CLEAR_COLOR_BIT },
            ],
            buffers: vec![pixels],
        });
        assert_eq!(device.log()[2], Call::Wait { context, seqno: 1, timeout_ns: -1 });
    }

    #[test]
    fn a_scripted_error_answers_one_call_of_its_operation() {
        let mut device = FakeDevice::new();
        device.fail_next(FakeOp::Wait, -EIO);
        let context = device.context_create().unwrap();
        assert_eq!(device.wait(context, 1, 0), Err(-EIO));
        assert_eq!(device.wait(context, 1, 0), Ok(()));
        // A failed call is still a trip.
        assert_eq!(device.calls(), 3);
    }

    #[test]
    #[should_panic(expected = "undecodable stream")]
    fn the_fake_refuses_an_undecodable_stream() {
        let _ = FakeDevice::new().submit(1, &[0u8; 16], &[]);
    }
}
