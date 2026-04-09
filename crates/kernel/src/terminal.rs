extern crate alloc;

use alloc::vec::Vec;

/// Terminal attribute flags (c_lflag)
pub const ECHO: u32 = 0o0010;
pub const ECHOE: u32 = 0o0020;
pub const ECHOK: u32 = 0o0040;
pub const ECHONL: u32 = 0o0100;
pub const ICANON: u32 = 0o0002;
pub const ISIG: u32 = 0o0001;
pub const IEXTEN: u32 = 0o100000;
pub const TOSTOP: u32 = 0o0400;
pub const NOFLSH: u32 = 0o0200;
pub const ECHOCTL: u32 = 0o1000;

/// Terminal attribute flags (c_iflag)
pub const ICRNL: u32 = 0o0400;
pub const INLCR: u32 = 0o0100;
pub const IGNCR: u32 = 0o0200;
pub const IXON: u32 = 0o2000;
pub const IXOFF: u32 = 0o10000;
pub const IXANY: u32 = 0o4000;
pub const IMAXBEL: u32 = 0o20000;

/// Terminal attribute flags (c_oflag)
pub const OPOST: u32 = 0o0001;
pub const ONLCR: u32 = 0o0004;

/// Terminal attribute flags (c_cflag)
pub const CS8: u32 = 0o0060;
pub const CREAD: u32 = 0o0200;
pub const HUPCL: u32 = 0o2000;

/// Control character indices
pub const VINTR: usize = 0;
pub const VQUIT: usize = 1;
pub const VERASE: usize = 2;
pub const VKILL: usize = 3;
pub const VEOF: usize = 4;
pub const VTIME: usize = 5;
pub const VMIN: usize = 6;
pub const VSTART: usize = 8;
pub const VSTOP: usize = 9;
pub const VSUSP: usize = 10;
pub const VEOL: usize = 11;
pub const NCCS: usize = 32;

/// tcsetattr action constants
pub const TCSANOW: u32 = 0;
pub const TCSADRAIN: u32 = 1;
pub const TCSAFLUSH: u32 = 2;

/// ioctl commands — terminal
pub const TCGETS: u32 = 0x5401;
pub const TCSETS: u32 = 0x5402;
pub const TCSETSW: u32 = 0x5403;
pub const TCSETSF: u32 = 0x5404;
pub const TCSBRK: u32 = 0x5409;
pub const TCXONC: u32 = 0x540A;
pub const TCFLSH: u32 = 0x540B;
pub const TIOCSCTTY: u32 = 0x540E;
pub const TIOCGPGRP: u32 = 0x540F;
pub const TIOCSPGRP: u32 = 0x5410;
pub const TIOCGWINSZ: u32 = 0x5413;
pub const TIOCSWINSZ: u32 = 0x5414;
pub const TIOCNOTTY: u32 = 0x5422;
pub const TIOCGSID: u32 = 0x5429;

/// ioctl commands — PTY
pub const TIOCGPTN: u32 = 0x80045430;
pub const TIOCSPTLCK: u32 = 0x40045431;

/// musl struct termios size: 4 flags (16) + c_line (1) + c_cc (32) + pad (3) + speeds (8) = 60
pub const TERMIOS_SIZE: usize = 60;

/// Window size structure
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WinSize {
    pub ws_row: u16,
    pub ws_col: u16,
    pub ws_xpixel: u16,
    pub ws_ypixel: u16,
}

/// Kernel-internal terminal state (simulated, not affecting actual host I/O).
#[derive(Debug, Clone)]
pub struct TerminalState {
    pub c_iflag: u32,
    pub c_oflag: u32,
    pub c_cflag: u32,
    pub c_lflag: u32,
    pub c_line: u8,
    pub c_cc: [u8; NCCS],
    pub c_ispeed: u32,
    pub c_ospeed: u32,
    pub winsize: WinSize,
    /// Foreground process group ID (for tcgetpgrp/tcsetpgrp via TIOCGPGRP/TIOCSPGRP).
    pub foreground_pgid: i32,
    /// Session ID that owns this terminal (for tcgetsid / TIOCGSID).
    pub session_id: i32,
    /// Line buffer for ICANON mode line editing.
    pub line_buffer: Vec<u8>,
    /// Completed lines ready to be read (includes the terminating newline).
    pub cooked_buffer: Vec<u8>,
}

impl TerminalState {
    /// Create default terminal state matching a typical Linux terminal.
    pub fn new() -> Self {
        let mut c_cc = [0u8; NCCS];
        c_cc[VINTR] = 0x03;   // Ctrl-C
        c_cc[VQUIT] = 0x1C;   // Ctrl-backslash
        c_cc[VERASE] = 0x7F;  // DEL
        c_cc[VKILL] = 0x15;   // Ctrl-U
        c_cc[VEOF] = 0x04;    // Ctrl-D
        c_cc[VSTART] = 0x11;  // Ctrl-Q
        c_cc[VSTOP] = 0x13;   // Ctrl-S
        c_cc[VSUSP] = 0x1A;   // Ctrl-Z
        c_cc[VMIN] = 1;
        c_cc[VTIME] = 0;

        // B38400 = 0o0000017 = 15 — default baud rate for PTYs
        const B38400: u32 = 0o0000017;

        TerminalState {
            c_iflag: ICRNL | IXON | IXANY | IMAXBEL,
            c_oflag: OPOST | ONLCR,
            c_cflag: CS8 | CREAD | HUPCL | B38400,
            c_lflag: ECHO | ECHOE | ECHOK | ICANON | ISIG | IEXTEN,
            c_line: 0,
            c_cc,
            c_ispeed: B38400,
            c_ospeed: B38400,
            winsize: WinSize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
            foreground_pgid: 1, // default to PID 1's group
            session_id: 0,
            line_buffer: Vec::new(),
            cooked_buffer: Vec::new(),
        }
    }

    /// Serialize terminal attributes to musl's 60-byte `struct termios` layout.
    /// Layout: c_iflag(4) + c_oflag(4) + c_cflag(4) + c_lflag(4) + c_line(1) +
    ///         c_cc(32) + pad(3) + __c_ispeed(4) + __c_ospeed(4) = 60 bytes.
    pub fn write_termios(&self, buf: &mut [u8]) {
        buf[0..4].copy_from_slice(&self.c_iflag.to_le_bytes());
        buf[4..8].copy_from_slice(&self.c_oflag.to_le_bytes());
        buf[8..12].copy_from_slice(&self.c_cflag.to_le_bytes());
        buf[12..16].copy_from_slice(&self.c_lflag.to_le_bytes());
        buf[16] = self.c_line;
        buf[17..49].copy_from_slice(&self.c_cc);
        buf[49..52].copy_from_slice(&[0, 0, 0]); // padding
        buf[52..56].copy_from_slice(&self.c_ispeed.to_le_bytes());
        buf[56..60].copy_from_slice(&self.c_ospeed.to_le_bytes());
    }

    /// Deserialize terminal attributes from musl's 60-byte `struct termios` layout.
    pub fn read_termios(&mut self, buf: &[u8]) {
        self.c_iflag = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        self.c_oflag = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        self.c_cflag = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        self.c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        self.c_line = buf[16];
        self.c_cc.copy_from_slice(&buf[17..49]);
        self.c_ispeed = u32::from_le_bytes([buf[52], buf[53], buf[54], buf[55]]);
        self.c_ospeed = u32::from_le_bytes([buf[56], buf[57], buf[58], buf[59]]);
    }

    /// Check if ICANON mode is enabled.
    pub fn is_canonical(&self) -> bool {
        self.c_lflag & ICANON != 0
    }

    /// Process a byte through the line discipline.
    /// Returns echo bytes and an optional signal number if ISIG matched.
    /// ISIG is checked independently of ICANON — signal characters generate
    /// signals in both canonical and raw modes when ISIG is set.
    pub fn process_input_byte(&mut self, byte: u8) -> (Vec<u8>, Option<u32>) {
        let mut echo = Vec::new();
        let do_echo = self.c_lflag & ECHO != 0;

        // Input processing (c_iflag)
        let byte = if self.c_iflag & ICRNL != 0 && byte == b'\r' {
            b'\n'
        } else if self.c_iflag & INLCR != 0 && byte == b'\n' {
            b'\r'
        } else if self.c_iflag & IGNCR != 0 && byte == b'\r' {
            return (echo, None); // discard CR
        } else {
            byte
        };

        // ISIG: check for signal-generating characters before line editing.
        // This works in both canonical and raw modes.
        if self.c_lflag & ISIG != 0 {
            use wasm_posix_shared::signal;
            let sig = if byte == self.c_cc[VINTR] {
                Some(signal::SIGINT)
            } else if byte == self.c_cc[VQUIT] {
                Some(signal::SIGQUIT)
            } else if byte == self.c_cc[VSUSP] {
                Some(signal::SIGTSTP)
            } else {
                None
            };

            if let Some(signum) = sig {
                // Echo the control character as ^X
                if do_echo {
                    echo.push(b'^');
                    echo.push(byte ^ 0x40); // 0x03 → 'C', 0x1A → 'Z', 0x1C → '\\'
                    echo.push(b'\n');
                }
                // Flush input queues unless NOFLSH is set
                if self.c_lflag & NOFLSH == 0 {
                    self.line_buffer.clear();
                    self.cooked_buffer.clear();
                }
                return (echo, Some(signum));
            }
        }

        // The rest is ICANON-only line editing (raw mode handled by caller)
        if self.c_lflag & ICANON == 0 {
            return (echo, None);
        }

        // Check for VERASE (backspace/delete)
        if byte == self.c_cc[VERASE] {
            if !self.line_buffer.is_empty() {
                self.line_buffer.pop();
                if do_echo && self.c_lflag & ECHOE != 0 {
                    // Echo backspace-space-backspace to erase character
                    echo.extend_from_slice(b"\x08 \x08");
                }
            }
            return (echo, None);
        }

        // Check for VKILL (kill line, ^U)
        if byte == self.c_cc[VKILL] {
            if do_echo && self.c_lflag & ECHOK != 0 {
                // Erase the whole line from display
                for _ in 0..self.line_buffer.len() {
                    echo.extend_from_slice(b"\x08 \x08");
                }
            }
            self.line_buffer.clear();
            return (echo, None);
        }

        // Check for VEOF (^D)
        if byte == self.c_cc[VEOF] {
            // Flush current line buffer without adding the EOF character
            self.cooked_buffer.extend_from_slice(&self.line_buffer);
            self.line_buffer.clear();
            return (echo, None);
        }

        // Newline or VEOL: complete the line
        if byte == b'\n' || byte == self.c_cc[VEOL] {
            self.line_buffer.push(byte);
            self.cooked_buffer.extend_from_slice(&self.line_buffer);
            self.line_buffer.clear();
            if do_echo || (self.c_lflag & ECHONL != 0 && byte == b'\n') {
                echo.push(byte);
            }
            return (echo, None);
        }

        // Regular character: add to line buffer
        self.line_buffer.push(byte);
        if do_echo {
            echo.push(byte);
        }
        (echo, None)
    }

    /// Read from the cooked buffer (for ICANON mode).
    /// Returns the number of bytes read.
    pub fn read_cooked(&mut self, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.cooked_buffer.len());
        if n == 0 {
            return 0;
        }
        buf[..n].copy_from_slice(&self.cooked_buffer[..n]);
        self.cooked_buffer.drain(..n);
        n
    }

    /// Check if cooked data is available for reading.
    pub fn has_cooked_data(&self) -> bool {
        !self.cooked_buffer.is_empty()
    }

    /// Get VMIN value (minimum bytes for raw read).
    pub fn vmin(&self) -> u8 {
        self.c_cc[VMIN]
    }

    /// Get VTIME value (timeout in tenths of a second for raw read).
    pub fn vtime(&self) -> u8 {
        self.c_cc[VTIME]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terminal_state_defaults() {
        let ts = TerminalState::new();
        assert!(ts.c_lflag & ECHO != 0);
        assert!(ts.c_lflag & ICANON != 0);
        assert!(ts.c_lflag & ISIG != 0);
        assert!(ts.c_iflag & ICRNL != 0);
        assert!(ts.c_oflag & OPOST != 0);
        assert_eq!(ts.c_cc[VINTR], 0x03);
        assert_eq!(ts.c_cc[VEOF], 0x04);
        assert_eq!(ts.winsize.ws_row, 24);
        assert_eq!(ts.winsize.ws_col, 80);
    }

    #[test]
    fn test_canonical_mode_default() {
        let ts = TerminalState::new();
        assert!(ts.is_canonical());
    }

    #[test]
    fn test_line_buffer_newline() {
        let mut ts = TerminalState::new();

        // Type "hello\n"
        for &b in b"hello" {
            ts.process_input_byte(b);
        }
        assert!(!ts.has_cooked_data()); // not yet complete
        ts.process_input_byte(b'\n');
        assert!(ts.has_cooked_data()); // now complete

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"hello\n");
    }

    #[test]
    fn test_line_buffer_cr_to_nl() {
        let mut ts = TerminalState::new();
        // ICRNL is set by default, so CR becomes NL
        for &b in b"hi" {
            ts.process_input_byte(b);
        }
        ts.process_input_byte(b'\r');
        assert!(ts.has_cooked_data());

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"hi\n");
    }

    #[test]
    fn test_verase_backspace() {
        let mut ts = TerminalState::new();

        for &b in b"abc" {
            ts.process_input_byte(b);
        }
        // Delete 'c'
        ts.process_input_byte(0x7F); // DEL = VERASE default
        ts.process_input_byte(b'\n');

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"ab\n");
    }

    #[test]
    fn test_vkill_clears_line() {
        let mut ts = TerminalState::new();

        for &b in b"hello" {
            ts.process_input_byte(b);
        }
        // ^U kills the line
        ts.process_input_byte(0x15);
        assert_eq!(ts.line_buffer.len(), 0);

        for &b in b"world" {
            ts.process_input_byte(b);
        }
        ts.process_input_byte(b'\n');

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"world\n");
    }

    #[test]
    fn test_veof_flushes_without_newline() {
        let mut ts = TerminalState::new();

        for &b in b"data" {
            ts.process_input_byte(b);
        }
        // ^D flushes without adding newline
        ts.process_input_byte(0x04);
        assert!(ts.has_cooked_data());

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"data"); // no trailing newline
    }

    #[test]
    fn test_veof_empty_line_returns_eof() {
        let mut ts = TerminalState::new();

        // ^D on empty line
        ts.process_input_byte(0x04);
        // Should flush empty buffer (returns 0 bytes = EOF to reader)
        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(n, 0);
    }

    #[test]
    fn test_echo_output() {
        let mut ts = TerminalState::new();

        // Typing 'a' should echo 'a'
        let (echo, sig) = ts.process_input_byte(b'a');
        assert_eq!(echo, vec![b'a']);
        assert!(sig.is_none());

        // Newline should echo newline
        let (echo, sig) = ts.process_input_byte(b'\n');
        assert_eq!(echo, vec![b'\n']);
        assert!(sig.is_none());
    }

    #[test]
    fn test_echo_disabled() {
        let mut ts = TerminalState::new();
        ts.c_lflag &= !ECHO; // disable echo

        let (echo, _) = ts.process_input_byte(b'a');
        assert!(echo.is_empty());
    }

    #[test]
    fn test_echonl_without_echo() {
        let mut ts = TerminalState::new();
        ts.c_lflag &= !ECHO;
        ts.c_lflag |= ECHONL;

        let (echo, _) = ts.process_input_byte(b'a');
        assert!(echo.is_empty()); // no echo for regular chars

        let (echo, _) = ts.process_input_byte(b'\n');
        assert_eq!(echo, vec![b'\n']); // but newline is echoed
    }

    #[test]
    fn test_backspace_echo_erases() {
        let mut ts = TerminalState::new();

        ts.process_input_byte(b'x');
        let (echo, _) = ts.process_input_byte(0x7F); // DEL
        // Should echo BS-SPACE-BS (erase character from display)
        assert_eq!(echo, b"\x08 \x08");
    }

    #[test]
    fn test_backspace_on_empty_line() {
        let mut ts = TerminalState::new();

        // Backspace on empty line should do nothing
        let (echo, _) = ts.process_input_byte(0x7F);
        assert!(echo.is_empty());
    }

    #[test]
    fn test_multiple_lines() {
        let mut ts = TerminalState::new();

        // First line
        for &b in b"line1\n" {
            ts.process_input_byte(b);
        }
        // Second line
        for &b in b"line2\n" {
            ts.process_input_byte(b);
        }

        let mut buf = [0u8; 64];
        // Read first line
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"line1\nline2\n");
    }

    #[test]
    fn test_vmin_vtime_defaults() {
        let ts = TerminalState::new();
        assert_eq!(ts.vmin(), 1);
        assert_eq!(ts.vtime(), 0);
    }

    #[test]
    fn test_igncr_discards_cr() {
        let mut ts = TerminalState::new();
        ts.c_iflag &= !ICRNL; // disable CR->NL
        ts.c_iflag |= IGNCR;  // enable ignore CR

        for &b in b"ab" {
            ts.process_input_byte(b);
        }
        ts.process_input_byte(b'\r'); // should be discarded
        ts.process_input_byte(b'\n');

        let mut buf = [0u8; 64];
        let n = ts.read_cooked(&mut buf);
        assert_eq!(&buf[..n], b"ab\n");
    }

    #[test]
    fn test_isig_ctrl_c_generates_sigint() {
        let mut ts = TerminalState::new();
        // ISIG is on by default

        for &b in b"hello" {
            ts.process_input_byte(b);
        }
        assert_eq!(ts.line_buffer.len(), 5);

        // Ctrl-C should generate SIGINT and flush line buffer
        let (echo, sig) = ts.process_input_byte(0x03);
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));
        assert_eq!(echo, b"^C\n"); // echo ^C + newline
        assert!(ts.line_buffer.is_empty()); // flushed
        assert!(ts.cooked_buffer.is_empty()); // flushed
    }

    #[test]
    fn test_isig_ctrl_backslash_generates_sigquit() {
        let mut ts = TerminalState::new();

        let (_, sig) = ts.process_input_byte(0x1C); // Ctrl-backslash
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGQUIT));
    }

    #[test]
    fn test_isig_ctrl_z_generates_sigtstp() {
        let mut ts = TerminalState::new();

        let (_, sig) = ts.process_input_byte(0x1A); // Ctrl-Z
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGTSTP));
    }

    #[test]
    fn test_isig_disabled_no_signal() {
        let mut ts = TerminalState::new();
        ts.c_lflag &= !ISIG; // disable ISIG

        let (_, sig) = ts.process_input_byte(0x03); // Ctrl-C
        assert!(sig.is_none());
        // Ctrl-C is added to line buffer as a regular character
        assert_eq!(ts.line_buffer, vec![0x03]);
    }

    #[test]
    fn test_isig_noflsh_preserves_buffers() {
        let mut ts = TerminalState::new();
        ts.c_lflag |= NOFLSH;

        for &b in b"hello" {
            ts.process_input_byte(b);
        }
        assert_eq!(ts.line_buffer.len(), 5);

        let (_, sig) = ts.process_input_byte(0x03); // Ctrl-C
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));
        // With NOFLSH, buffers are preserved
        assert_eq!(ts.line_buffer.len(), 5);
    }

    #[test]
    fn test_isig_flushes_cooked_buffer() {
        let mut ts = TerminalState::new();

        // Complete a line to put data in cooked buffer
        for &b in b"line1\n" {
            ts.process_input_byte(b);
        }
        assert!(ts.has_cooked_data());

        // Ctrl-C should flush both buffers
        let (_, sig) = ts.process_input_byte(0x03);
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));
        assert!(!ts.has_cooked_data()); // cooked buffer flushed
    }

    #[test]
    fn test_isig_works_in_raw_mode() {
        let mut ts = TerminalState::new();
        ts.c_lflag &= !ICANON; // raw mode, but ISIG still set

        let (_, sig) = ts.process_input_byte(0x03);
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));
    }

    #[test]
    fn test_isig_no_echo_when_echo_disabled() {
        let mut ts = TerminalState::new();
        ts.c_lflag &= !ECHO;

        let (echo, sig) = ts.process_input_byte(0x03);
        assert_eq!(sig, Some(wasm_posix_shared::signal::SIGINT));
        assert!(echo.is_empty()); // no echo when ECHO is off
    }
}
