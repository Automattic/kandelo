//! Event producer for `/dev/input/event{0,1}`.
//!
//! The host calls `kernel_input_event` once per translated DOM key /
//! pointer event; that export feeds [`push_event`] here, which fans
//! the record out to every open OFD bound to the matching device.
//!
//! Overflow handling mirrors Linux `drivers/input/evdev.c::
//! evdev_pass_values`: when an OFD's ring is full we set `dropped =
//! true` and discard the **incoming** record. The next `read()` on
//! that OFD (A5) synthesises a `SYN_DROPPED` marker at the head of
//! its output + clears the flag, so userspace can resynchronise via
//! `EVIOCG*`. Crucially, this bound holds for free even under
//! pathological producers — pushes-while-dropped are no-ops, so the
//! ring never grows past [`INPUT_RING_MAX_BYTES`].

use alloc::collections::VecDeque;

use wasm_posix_shared::input::WpkInputEvent;

use crate::ofd::INPUT_RING_MAX_BYTES;

const RECORD_SIZE: usize = core::mem::size_of::<WpkInputEvent>();

/// Push one `WpkInputEvent` onto every open OFD bound to `device`
/// (0 = `/dev/input/event0` / keyboard, 1 = `event1` / pointer).
/// Other device numbers are dropped.
///
/// `tv_sec` / `tv_usec` are the CLOCK_MONOTONIC timestamp the kernel
/// stamps the record with — the export wrapper supplies them so this
/// function stays testable without a host.
///
/// Returns the number of OFDs that accepted the record (i.e. their
/// ring had space and `device` matched). Drops count as "not accepted".
pub fn push_event(
    device: u8,
    ev_type: u16,
    code: u16,
    value: i32,
    tv_sec: i64,
    tv_usec: i32,
) -> usize {
    if device > 1 {
        return 0;
    }
    let ev = WpkInputEvent {
        tv_sec,
        tv_usec,
        _pad: 0,
        ev_type,
        code,
        value,
    };
    let mut delivered = 0;
    let mut woken_ofds: alloc::vec::Vec<usize> = alloc::vec::Vec::new();
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(input) = ofd.input_mut() else { continue };
                if input.device != device {
                    continue;
                }
                // Ring full → set dropped, discard the incoming record.
                // The bound on `event_ring.len()` holds because we
                // never push when dropped flips on, and read() only
                // clears it after emitting the SYN_DROPPED marker.
                if input.event_ring.len() + RECORD_SIZE > INPUT_RING_MAX_BYTES {
                    input.dropped = true;
                    continue;
                }
                let was_empty = input.event_ring.is_empty();
                push_record(&mut input.event_ring, &ev);
                let records = (input.event_ring.len() / RECORD_SIZE) as u32;
                if records > input.ring_high_water {
                    input.ring_high_water = records;
                }
                delivered += 1;
                if was_empty {
                    woken_ofds.push(idx);
                }
            }
        }
    });
    for ofd_idx in woken_ofds {
        crate::input::wait::wake_event_reader(ofd_idx);
    }
    delivered
}

fn push_record(ring: &mut VecDeque<u8>, ev: &WpkInputEvent) {
    let bytes: [u8; RECORD_SIZE] = unsafe {
        core::mem::transmute::<WpkInputEvent, [u8; RECORD_SIZE]>(*ev)
    };
    for &b in bytes.iter() {
        ring.push_back(b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ofd::{FileType, InputFdState, INPUT_RING_MAX_RECORDS};
    use crate::process::Process;
    use crate::process_table::GLOBAL_PROCESS_TABLE as PROCESS_TABLE;
    use alloc::boxed::Box;
    use wasm_posix_shared::flags::O_RDWR;
    use wasm_posix_shared::input::{EV_KEY, EV_REL, EV_SYN, KEY_A, REL_X, SYN_REPORT};

    /// Several tests mutate the global PROCESS_TABLE; each uses a
    /// distinct pid and only asserts on its own OFDs, so concurrent
    /// runs are independent. Returns a 'static &mut to the inserted
    /// process — safe because the ProcessTable backs each entry on
    /// the heap and tests don't drop their pids.
    fn install_process(pid: u32) -> &'static mut Process {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let _ = table.create_process(pid);
        let proc = table.processes.get_mut(&pid).unwrap();
        unsafe { &mut *(proc as *mut Process) }
    }

    /// Install a fresh OFD on `proc` with `input_state` populated for
    /// `device`. Mirrors the shape `install_input_state_on_open`
    /// produces from `sys_open`, without dragging MockHostIO across
    /// module boundaries.
    fn install_input_ofd(proc: &mut Process, device: u8) -> usize {
        let host_handle = if device == 0 { -10 } else { -11 };
        let path: alloc::vec::Vec<u8> = if device == 0 {
            b"/dev/input/event0".to_vec()
        } else {
            b"/dev/input/event1".to_vec()
        };
        let ofd_idx = proc
            .ofd_table
            .create(FileType::CharDevice, O_RDWR, host_handle, path);
        let ofd = proc.ofd_table.get_mut(ofd_idx).unwrap();
        ofd.input_state = Some(Box::new(InputFdState {
            device,
            ..Default::default()
        }));
        ofd_idx
    }

    fn ring_records(proc: &Process, ofd_idx: usize) -> usize {
        proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().event_ring.len()
            / RECORD_SIZE
    }

    #[test]
    fn push_event_with_unknown_device_is_a_noop() {
        // device > 1 → not a valid evdev node; push returns 0.
        let _ = install_process(7001);
        let delivered = push_event(2, EV_KEY, KEY_A, 1, 0, 0);
        assert_eq!(delivered, 0);
    }

    #[test]
    fn push_event_writes_24_byte_record_to_matching_ofd() {
        let proc = install_process(7002);
        let ofd_idx = install_input_ofd(proc, 0);
        assert_eq!(ring_records(proc, ofd_idx), 0);

        push_event(0, EV_KEY, KEY_A, 1, 42, 1000);

        assert_eq!(ring_records(proc, ofd_idx), 1);
        let input = proc.ofd_table.get(ofd_idx).unwrap().input().unwrap();
        // First 8 bytes = tv_sec (i64 LE) = 42.
        let tv_sec_bytes: [u8; 8] = input
            .event_ring
            .iter()
            .take(8)
            .copied()
            .collect::<alloc::vec::Vec<_>>()
            .try_into()
            .unwrap();
        assert_eq!(i64::from_le_bytes(tv_sec_bytes), 42);
    }

    #[test]
    fn push_event_skips_other_device() {
        let proc = install_process(7003);
        let kbd = install_input_ofd(proc, 0);
        let ptr = install_input_ofd(proc, 1);

        push_event(1, EV_REL, REL_X, 5, 0, 0);

        assert_eq!(ring_records(proc, kbd), 0);
        assert_eq!(ring_records(proc, ptr), 1);
    }

    #[test]
    fn ring_overflow_sets_dropped_and_discards_new_records() {
        let proc = install_process(7004);
        let ofd_idx = install_input_ofd(proc, 0);
        for i in 0..INPUT_RING_MAX_RECORDS {
            push_event(0, EV_KEY, KEY_A, i as i32, 0, 0);
        }
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(!proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().dropped);
        assert_eq!(
            proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().ring_high_water as usize,
            INPUT_RING_MAX_RECORDS
        );

        // One more push: ring stays at max, `dropped` latches on, the
        // incoming record is the one discarded (Linux semantics).
        push_event(0, EV_KEY, KEY_A, 0xdead, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(
            proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().dropped,
            "dropped flag must latch on overflow"
        );

        // Pushes-while-dropped stay no-ops; the ring is bounded for free.
        // (A5 clears `dropped` after emitting SYN_DROPPED at the head
        // of the next read.)
        push_event(0, EV_KEY, KEY_A, 0xbeef, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
    }

    #[test]
    fn push_event_tracks_high_water() {
        let proc = install_process(7005);
        let ofd_idx = install_input_ofd(proc, 0);
        for _ in 0..50 {
            push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        }
        assert_eq!(
            proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().ring_high_water,
            50
        );
    }

    #[test]
    fn push_event_fans_out_to_every_open_ofd_for_the_device() {
        // Multi-open: every OFD bound to the same evdev node gets the
        // record (mirrors A2's `open_event0_is_multi_process_no_busy`
        // — every reader sees every event).
        let proc = install_process(7006);
        let a = install_input_ofd(proc, 0);
        let b = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        assert_eq!(ring_records(proc, a), 1);
        assert_eq!(ring_records(proc, b), 1);
    }

    #[test]
    fn push_event_syn_report_lands_in_ring_verbatim() {
        // SYN_REPORT is just a record from the producer's POV — A5's
        // read path treats it as the value-boundary marker.
        let proc = install_process(7007);
        let ofd_idx = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        push_event(0, EV_SYN, SYN_REPORT, 0, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), 2);
    }
}
