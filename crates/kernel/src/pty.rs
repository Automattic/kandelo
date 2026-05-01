extern crate alloc;

use alloc::collections::VecDeque;
use core::cell::UnsafeCell;
use crate::terminal::TerminalState;

/// Maximum number of concurrent PTY pairs.
pub const MAX_PTYS: usize = 64;

/// Default capacity for PTY data buffers (bytes).
const PTY_BUF_CAPACITY: usize = 4096;

/// A pseudo-terminal pair: master ↔ slave connected through a line discipline.
///
/// Data flow:
///   master write → line discipline → slave read  (input: keyboard → program)
///   slave write  → output processing → master read (output: program → screen)
pub struct PtyPair {
    /// Terminal state (termios attributes, winsize, foreground pgrp).
    pub terminal: TerminalState,
    /// Input buffer: data written by master, readable from slave (after line discipline).
    pub input_buf: VecDeque<u8>,
    /// Output buffer: data written by slave, readable from master (after output processing).
    pub output_buf: VecDeque<u8>,
    /// Whether the slave side is locked (unlockpt clears this).
    pub locked: bool,
    /// Number of open file descriptors referencing the master side.
    pub master_refs: u32,
    /// Number of open file descriptors referencing the slave side.
    pub slave_refs: u32,
}

impl PtyPair {
    fn new() -> Self {
        PtyPair {
            terminal: TerminalState::new(),
            input_buf: VecDeque::with_capacity(PTY_BUF_CAPACITY),
            output_buf: VecDeque::with_capacity(PTY_BUF_CAPACITY),
            locked: true,  // locked until unlockpt()
            master_refs: 0,
            slave_refs: 0,
        }
    }

    /// Process a byte through the line discipline (for master→slave input).
    /// Returns an optional signal number if ISIG matched a signal character.
    /// Echo bytes are appended to the output buffer (master read side).
    pub fn process_master_input(&mut self, byte: u8) -> Option<u32> {
        let opost = self.terminal.c_oflag & crate::terminal::OPOST != 0;
        let onlcr = self.terminal.c_oflag & crate::terminal::ONLCR != 0;

        // process_input_byte handles both ISIG (in any mode) and ICANON line editing
        let (echo, signal) = self.terminal.process_input_byte(byte);

        // If a signal was generated, flush input_buf too (unless NOFLSH)
        if signal.is_some() && self.terminal.c_lflag & crate::terminal::NOFLSH == 0 {
            self.input_buf.clear();
        }

        // Echo bytes go to the output buffer (master reads them back)
        // Apply OPOST/ONLCR to echo just like slave_write does
        for &b in &echo {
            if opost && onlcr && b == b'\n' {
                self.output_buf.push_back(b'\r');
                self.output_buf.push_back(b'\n');
            } else {
                self.output_buf.push_back(b);
            }
        }

        if signal.is_some() {
            return signal;
        }

        // In raw mode (non-canonical), pass byte directly to slave input.
        // process_input_byte only handles ISIG in raw mode, not regular input.
        if !self.terminal.is_canonical() {
            self.input_buf.push_back(byte);
            if self.terminal.c_lflag & crate::terminal::ECHO != 0 {
                if opost && onlcr && byte == b'\n' {
                    self.output_buf.push_back(b'\r');
                    self.output_buf.push_back(b'\n');
                } else {
                    self.output_buf.push_back(byte);
                }
            }
        }

        None
    }

    /// Read from the slave side. In canonical mode, reads from cooked buffer.
    /// In raw mode, reads from input_buf directly.
    pub fn slave_read(&mut self, buf: &mut [u8]) -> usize {
        if self.terminal.is_canonical() {
            // First drain any cooked data from the terminal state
            let n = self.terminal.read_cooked(buf);
            if n > 0 {
                return n;
            }
            // Also check input_buf for data that was put there in raw-mode
            // transitions (shouldn't happen normally, but be safe)
            0
        } else {
            // Raw mode: read directly from input_buf
            let n = buf.len().min(self.input_buf.len());
            for i in 0..n {
                buf[i] = self.input_buf.pop_front().unwrap();
            }
            n
        }
    }

    /// Check if slave side has data available for reading.
    pub fn slave_has_data(&self) -> bool {
        if self.terminal.is_canonical() {
            self.terminal.has_cooked_data()
        } else {
            !self.input_buf.is_empty()
        }
    }

    /// Write from the slave side. Does output processing (OPOST) and puts
    /// data into the output buffer for the master to read.
    pub fn slave_write(&mut self, data: &[u8]) -> usize {
        let opost = self.terminal.c_oflag & crate::terminal::OPOST != 0;
        let onlcr = self.terminal.c_oflag & crate::terminal::ONLCR != 0;

        for &byte in data {
            if opost && onlcr && byte == b'\n' {
                self.output_buf.push_back(b'\r');
                self.output_buf.push_back(b'\n');
            } else {
                self.output_buf.push_back(byte);
            }
        }
        data.len()
    }

    /// Read from the master side (reads slave's output).
    pub fn master_read(&mut self, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.output_buf.len());
        for i in 0..n {
            buf[i] = self.output_buf.pop_front().unwrap();
        }
        n
    }

    /// Check if master side has data available for reading.
    pub fn master_has_data(&self) -> bool {
        !self.output_buf.is_empty()
    }

    /// Check if the PTY pair is still alive (at least one side open).
    pub fn is_alive(&self) -> bool {
        self.master_refs > 0 || self.slave_refs > 0
    }
}

/// Global PTY table wrapper using UnsafeCell (same pattern as pipe table).
struct GlobalPtyTable(UnsafeCell<[Option<PtyPair>; MAX_PTYS]>);
unsafe impl Sync for GlobalPtyTable {}

static PTY_TABLE: GlobalPtyTable = GlobalPtyTable(UnsafeCell::new({
    const NONE: Option<PtyPair> = None;
    [NONE; MAX_PTYS]
}));

fn get_table() -> &'static mut [Option<PtyPair>; MAX_PTYS] {
    unsafe { &mut *PTY_TABLE.0.get() }
}

/// Allocate a new PTY pair. Returns the index (pty number) or None if full.
pub fn alloc_pty() -> Option<usize> {
    let table = get_table();
    for (i, slot) in table.iter_mut().enumerate() {
        if slot.is_none() {
            *slot = Some(PtyPair::new());
            return Some(i);
        }
    }
    None
}

/// Get a mutable reference to a PTY pair by index.
pub fn get_pty(idx: usize) -> Option<&'static mut PtyPair> {
    if idx >= MAX_PTYS { return None; }
    get_table()[idx].as_mut()
}

/// Free a PTY pair (when both sides are closed).
pub fn free_pty(idx: usize) {
    if idx < MAX_PTYS {
        get_table()[idx] = None;
    }
}

/// Reset all PTY slots (for testing).
#[cfg(test)]
fn reset_table() {
    let table = get_table();
    for slot in table.iter_mut() {
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alloc_pty() {
        reset_table();

        let idx = alloc_pty().unwrap();
        assert_eq!(idx, 0);
        let pty = get_pty(idx).unwrap();
        assert!(pty.locked);
        assert_eq!(pty.master_refs, 0);
        assert_eq!(pty.slave_refs, 0);

        let idx2 = alloc_pty().unwrap();
        assert_eq!(idx2, 1);

        free_pty(idx);
        let idx3 = alloc_pty().unwrap();
        assert_eq!(idx3, 0); // reuses freed slot

        reset_table();
    }

    #[test]
    fn test_pty_data_flow_raw_mode() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        pty.terminal.c_lflag &= !crate::terminal::ICANON; // raw mode
        pty.terminal.c_lflag &= !crate::terminal::ECHO;   // no echo

        // Master writes → slave reads
        for &b in b"hello" {
            pty.process_master_input(b);
        }
        assert!(pty.slave_has_data());
        let mut buf = [0u8; 32];
        let n = pty.slave_read(&mut buf);
        assert_eq!(&buf[..n], b"hello");

        // Slave writes → master reads
        pty.slave_write(b"world");
        assert!(pty.master_has_data());
        let n = pty.master_read(&mut buf);
        assert_eq!(&buf[..n], b"world");

        reset_table();
    }

    #[test]
    fn test_pty_canonical_mode() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        // Default is canonical mode with echo

        // Type "hi\n" via master
        for &b in b"hi\n" {
            pty.process_master_input(b);
        }

        // Slave should have cooked data
        assert!(pty.slave_has_data());
        let mut buf = [0u8; 32];
        let n = pty.slave_read(&mut buf);
        assert_eq!(&buf[..n], b"hi\n");

        // Master should have echo data
        assert!(pty.master_has_data());
        let n = pty.master_read(&mut buf);
        assert_eq!(&buf[..n], b"hi\r\n"); // echo with ONLCR: \n → \r\n

        reset_table();
    }

    #[test]
    fn test_pty_onlcr() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        // OPOST | ONLCR is on by default

        // Slave writes newline
        pty.slave_write(b"a\nb");
        let mut buf = [0u8; 32];
        let n = pty.master_read(&mut buf);
        assert_eq!(&buf[..n], b"a\r\nb"); // NL → CR+NL

        reset_table();
    }

    #[test]
    fn test_pty_isig_canonical() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        // Default: canonical + ISIG + ECHO

        // Type some chars then Ctrl-C
        for &b in b"hello" {
            assert!(pty.process_master_input(b).is_none());
        }
        let sig = pty.process_master_input(0x03); // Ctrl-C
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));

        // Input buffers should be flushed
        assert!(!pty.slave_has_data());

        // Master should have echo output: "hello" + "^C\r\n" (ONLCR converts \n → \r\n)
        assert!(pty.master_has_data());
        let mut buf = [0u8; 64];
        let n = pty.master_read(&mut buf);
        assert_eq!(&buf[..n], b"hello^C\r\n");

        reset_table();
    }

    #[test]
    fn test_pty_isig_raw_mode() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        pty.terminal.c_lflag &= !crate::terminal::ICANON; // raw mode
        // ISIG still set by default

        // Ctrl-C in raw mode with ISIG should still generate signal
        let sig = pty.process_master_input(0x03);
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));

        // No data passed to slave (signal consumed the byte)
        assert!(!pty.slave_has_data());

        reset_table();
    }

    #[test]
    fn test_pty_isig_disabled_raw_mode() {
        reset_table();

        let idx = alloc_pty().unwrap();
        let pty = get_pty(idx).unwrap();
        pty.terminal.c_lflag &= !crate::terminal::ICANON; // raw mode
        pty.terminal.c_lflag &= !crate::terminal::ISIG;   // disable ISIG
        pty.terminal.c_lflag &= !crate::terminal::ECHO;   // no echo

        // Ctrl-C without ISIG should pass through as data
        let sig = pty.process_master_input(0x03);
        assert!(sig.is_none());
        assert!(pty.slave_has_data());

        let mut buf = [0u8; 8];
        let n = pty.slave_read(&mut buf);
        assert_eq!(&buf[..n], &[0x03]); // raw byte passed through

        reset_table();
    }
}
