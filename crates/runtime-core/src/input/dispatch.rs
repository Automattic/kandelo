//! Event producer for `/dev/input/event{0,1}`. Mirrors Linux
//! `drivers/input/evdev.c::evdev_pass_values`: a full ring drops the
//! oldest record to make room for the newest and latches `dropped`; the
//! next read prepends a synthetic `SYN_DROPPED` so userspace can resync
//! via `EVIOCG*`.

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
    // Update the device-global keystate first — before the per-OFD ring
    // fan-out — so a key/button transition is recorded even when a ring
    // is full and drops a record. That is what lets a client recover the
    // true key state via EVIOCGKEY after a SYN_DROPPED.
    if ev_type == wasm_posix_shared::input::EV_KEY {
        crate::input::note_key_event(device, code, value);
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
    // A single OFD identity can appear in several processes' tables at
    // once (parent + child after fork) sharing one ring. Deliver to each
    // distinct ring exactly once — mirroring Linux, where a forked
    // `struct file` carries one `struct evdev_client`. Independent
    // `open()`s keep distinct rings and each still receive the event.
    let mut seen: alloc::vec::Vec<usize> = alloc::vec::Vec::new();
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (_idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(input) = ofd.input() else { continue };
                if input.device != device {
                    continue;
                }
                let ring_id = input.ring.identity();
                if seen.contains(&ring_id) {
                    continue;
                }
                seen.push(ring_id);
                let mut ring = input.ring.borrow_mut();
                if ring.event_ring.len() + RECORD_SIZE > INPUT_RING_MAX_BYTES {
                    // Ring full: drop the OLDEST record to make room for the
                    // newest and latch `dropped`, mirroring Linux
                    // drivers/input/evdev.c::evdev_pass_values (which advances
                    // the tail). Keeping the newest guarantees a key release is
                    // never the record dropped; the SYN_DROPPED synthesised on
                    // the next read tells userspace to resync.
                    for _ in 0..RECORD_SIZE {
                        ring.event_ring.pop_front();
                    }
                    ring.dropped = true;
                }
                push_record(&mut ring.event_ring, &ev);
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
        table.processes.insert(pid, Process::new(pid));
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
        proc.ofd_table
            .get(ofd_idx)
            .unwrap()
            .input()
            .unwrap()
            .ring
            .borrow()
            .event_ring
            .len()
            / RECORD_SIZE
    }

    fn ring_dropped(proc: &Process, ofd_idx: usize) -> bool {
        proc.ofd_table.get(ofd_idx).unwrap().input().unwrap().ring.borrow().dropped
    }

    // `value` (the `i32` tail of `WpkInputEvent`) is the last 4 bytes of each
    // 24-byte record; return it for the oldest / newest buffered record.
    fn record_value_at(proc: &Process, ofd_idx: usize, record_start: usize) -> i32 {
        let ofd = proc.ofd_table.get(ofd_idx).unwrap();
        let ring = ofd.input().unwrap().ring.borrow();
        let o = record_start + 20;
        i32::from_le_bytes([
            ring.event_ring[o],
            ring.event_ring[o + 1],
            ring.event_ring[o + 2],
            ring.event_ring[o + 3],
        ])
    }

    fn oldest_value(proc: &Process, ofd_idx: usize) -> i32 {
        record_value_at(proc, ofd_idx, 0)
    }

    fn newest_value(proc: &Process, ofd_idx: usize) -> i32 {
        let bytes = ring_records(proc, ofd_idx) * RECORD_SIZE;
        record_value_at(proc, ofd_idx, bytes - RECORD_SIZE)
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
            .ring
            .borrow()
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
    fn ring_overflow_drops_oldest_and_keeps_newest() {
        let proc = install_process(7004);
        let ofd_idx = install_input_ofd(proc, 0);
        for i in 0..INPUT_RING_MAX_RECORDS {
            push_event(0, EV_KEY, KEY_A, i as i32, 0, 0);
        }
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(!ring_dropped(proc, ofd_idx));
        assert_eq!(oldest_value(proc, ofd_idx), 0);

        // Linux semantics: ring stays at max, `dropped` latches, and the
        // OLDEST record is the one dropped so the newest always survives
        // (a key release is never the record lost).
        push_event(0, EV_KEY, KEY_A, 0xdead, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(ring_dropped(proc, ofd_idx), "dropped flag must latch on overflow");
        assert_eq!(newest_value(proc, ofd_idx), 0xdead, "newest record must survive");
        assert_eq!(oldest_value(proc, ofd_idx), 1, "value 0 (oldest) is the record dropped");

        push_event(0, EV_KEY, KEY_A, 0xbeef, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert_eq!(newest_value(proc, ofd_idx), 0xbeef);
        assert_eq!(oldest_value(proc, ofd_idx), 2);
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
    fn push_event_delivers_once_to_a_shared_ring() {
        // Post-fork share: two OFDs (in two processes) whose evdev rings
        // are the same SharedInputRing. A fanned-out event must land in
        // that ring exactly once, not once per OFD reference — otherwise
        // parent and child would each see a duplicate of every event.
        let parent = install_process(7008);
        let p_idx = install_input_ofd(parent, 1);
        let shared = parent
            .ofd_table
            .get(p_idx)
            .unwrap()
            .input()
            .unwrap()
            .ring
            .clone();

        let child = install_process(7009);
        let c_idx = install_input_ofd(child, 1);
        child.ofd_table.get_mut(c_idx).unwrap().input_mut().unwrap().ring =
            shared.clone();

        push_event(1, EV_REL, REL_X, 5, 0, 0);

        assert_eq!(shared.borrow().event_ring.len(), RECORD_SIZE);
        assert_eq!(ring_records(parent, p_idx), 1);
        assert_eq!(ring_records(child, c_idx), 1);
    }

    #[test]
    fn push_event_syn_report_lands_in_ring_verbatim() {
        let proc = install_process(7007);
        let ofd_idx = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        push_event(0, EV_SYN, SYN_REPORT, 0, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), 2);
    }

    #[test]
    fn keystate_records_key_up_even_when_ring_overflows() {
        // #1(B): keystate is updated before the per-OFD ring op, so a key
        // transition is reflected in EVIOCGKEY even when the ring is
        // saturated — the recovery a client performs after SYN_DROPPED.
        crate::input::reset_key_state();
        let proc = install_process(7050);
        let ofd_idx = install_input_ofd(proc, 0);
        push_event(0, EV_KEY, KEY_A, 1, 0, 0);
        for _ in 0..INPUT_RING_MAX_RECORDS {
            push_event(0, EV_KEY, KEY_A, 2, 0, 0);
        }
        push_event(0, EV_KEY, KEY_A, 0, 0, 0);
        assert_eq!(ring_records(proc, ofd_idx), INPUT_RING_MAX_RECORDS);
        assert!(ring_dropped(proc, ofd_idx), "ring must have overflowed");
        let mut buf = [0u8; 64];
        crate::input::copy_key_state(0, &mut buf);
        let a_byte = (KEY_A >> 3) as usize;
        assert_eq!(
            buf[a_byte] & (1u8 << (KEY_A & 7)),
            0,
            "keystate must record the key-up regardless of ring overflow",
        );
        crate::input::reset_key_state();
    }
}
