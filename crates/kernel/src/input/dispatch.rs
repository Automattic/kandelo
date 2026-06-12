//! Event producer for `/dev/input/event{0,1}`. Mirrors Linux
//! `drivers/input/evdev.c::evdev_pass_values`: a full ring discards
//! the incoming record and latches `dropped`; the next read prepends
//! a synthetic `SYN_DROPPED` so userspace can resync via `EVIOCG*`.

use alloc::collections::VecDeque;

use wasm_posix_shared::input::WpkInputEvent;

use crate::ofd::INPUT_RING_MAX_BYTES;

const RECORD_SIZE: usize = core::mem::size_of::<WpkInputEvent>();

/// Push one `WpkInputEvent` onto every open OFD bound to `device`
/// (0 = keyboard, 1 = pointer). Other device numbers are dropped.
///
/// Returns the count of OFDs that accepted the record (drops do not
/// count). `tv_sec` / `tv_usec` are supplied by the caller so this
/// function stays testable without a host.
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
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (_idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(input) = ofd.input_mut() else { continue };
                if input.device != device {
                    continue;
                }
                if input.event_ring.len() + RECORD_SIZE > INPUT_RING_MAX_BYTES {
                    input.dropped = true;
                    continue;
                }
                push_record(&mut input.event_ring, &ev);
                delivered += 1;
            }
        }
    });
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

    // Tests mutate the global PROCESS_TABLE and only assert on their
    // own pids, so concurrent runs are independent.
    fn install_process(pid: u32) -> &'static mut Process {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let _ = table.create_process(pid);
        let proc = table.processes.get_mut(&pid).unwrap();
        unsafe { &mut *(proc as *mut Process) }
    }

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

        // Linux semantics: ring stays at max, `dropped` latches on,
        // the incoming record is the one discarded.
        push_event(0, EV_KEY, KEY_A, 0xdead, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(
            proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().dropped,
            "dropped flag must latch on overflow"
        );

        push_event(0, EV_KEY, KEY_A, 0xbeef, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
    }

    #[test]
    fn push_event_fans_out_to_every_open_ofd_for_the_device() {
        let proc = install_process(7006);
        let a = install_input_ofd(proc, 0);
        let b = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        assert_eq!(ring_records(proc, a), 1);
        assert_eq!(ring_records(proc, b), 1);
    }

    #[test]
    fn push_event_syn_report_lands_in_ring_verbatim() {
        let proc = install_process(7007);
        let ofd_idx = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        push_event(0, EV_SYN, SYN_REPORT, 0, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), 2);
    }
}
